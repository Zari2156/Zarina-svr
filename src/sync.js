const { fetchFacebookInsights } = require('./facebookClient');
const { fetchAmoLeads, fetchAmoSalesByContractDate, fetchPipelineStatuses, fetchReachedQualIds } = require('./amoClient');
const { toTs, segmentByTags } = require('./rules');
const db = require('./db');
const { buildRecommendations } = require('./recommendations');

function getAdsTags() {
  return {
    nish: (process.env.ADS_TAGS_NISH || '').split(',').map((t) => t.trim()).filter(Boolean),
    ent: (process.env.ADS_TAGS_ENT || '').split(',').map((t) => t.trim()).filter(Boolean),
  };
}

// Приводит название к единому виду для сравнения: убирает разницу в регистре, лишние пробелы
// по краям и схлопывает несколько пробелов внутри в один — чтобы "Ниш Каз 4кл " и "ниш каз  4кл"
// считались одним и тем же объявлением.
function normalizeName(str) {
  return (str || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

// Этапы, которые считаются "квалом": "Квалификация пройдена" (AMO_STATUS_QUALIFIED) и ВСЕ этапы
// после неё по порядку воронки, включая "Успешно реализовано" (142). Кроме "Закрыто и не
// реализовано" (143) — такие сделки считаются квалом, только если по истории доходили до квала.
function qualifyingStatusIds(statuses) {
  const qualId = Number(process.env.AMO_STATUS_QUALIFIED);
  const qual = (statuses || []).find((st) => Number(st.id) === qualId);
  if (!qual) return qualId ? [qualId] : [];
  return statuses.filter((st) => st.sort >= qual.sort && Number(st.id) !== 143).map((st) => Number(st.id));
}

function defaultRangeIfMissing(since, until) {
  if (since && until) return { since, until };
  const today = new Date();
  const monthAgo = new Date();
  monthAgo.setDate(today.getDate() - 30);
  return {
    since: since || monthAgo.toISOString().slice(0, 10),
    until: until || today.toISOString().slice(0, 10),
  };
}

let syncInProgress = false; // защита от одновременного запуска нескольких синхронизаций

async function runSync(sinceIn, untilIn) {
  const { since, until } = defaultRangeIfMissing(sinceIn, untilIn);

  if (syncInProgress) {
    console.log(`[sync] Пропущено (${since} — ${until}) — уже идёт другая синхронизация`);
    throw new Error('Синхронизация уже выполняется, подождите её завершения (обычно 1-3 минуты)');
  }
  syncInProgress = true;

  try {
    // Раньше три запроса шли параллельно (Promise.all), и в логах при зависании было не видно,
    // какой именно из них виснет. Теперь идут по очереди, с логом времени каждого шага —
    // если синк опять зависнет, в логах будет точно видно, на каком шаге.
    console.log(`[sync] Старт (${since} — ${until})`);

    let t0 = Date.now();
    const fbRows = await fetchFacebookInsights(since, until);
    console.log(`[sync] Facebook: ${fbRows.length} строк за ${((Date.now() - t0) / 1000).toFixed(1)}с`);

    t0 = Date.now();
    const amoLeads = await fetchAmoLeads(since, until);
    console.log(`[sync] amoCRM (сделки): ${amoLeads.length} строк за ${((Date.now() - t0) / 1000).toFixed(1)}с`);

    // Источник выручки — НЕ Google Таблица (убрали её полностью, третий источник только тормозил),
    // а сама amoCRM: сделки, дошедшие до успешной оплаты, отфильтрованные по дате ЗАКЛЮЧЕНИЯ
    // ДОГОВОРА. Остаётся всего два источника — Facebook + amoCRM.
    t0 = Date.now();
    const amoSales = await fetchAmoSalesByContractDate(since, until);
    console.log(`[sync] amoCRM (продажи): ${amoSales.length} строк за ${((Date.now() - t0) / 1000).toFixed(1)}с`);

    // Этапы воронки и история: какие сделки доходили до квалификации (для подсчёта квалов как в amoCRM).
    // Если этот шаг не получится — синхронизация не падает, квалы считаются по текущему этапу.
    t0 = Date.now();
    try {
      const statuses = await fetchPipelineStatuses();
      await db.setKv('pipeline_statuses', statuses);
      const qualIds = qualifyingStatusIds(statuses);
      const qualStatus = statuses.find((st) => Number(st.id) === Number(process.env.AMO_STATUS_QUALIFIED));
      console.log(`[sync] Этап квала: ${qualStatus ? qualStatus.name : 'НЕ НАЙДЕН (проверьте AMO_STATUS_QUALIFIED)'}; этапов, считающихся квалом: ${qualIds.length}`);
      if (qualIds.length) {
        const reached = await fetchReachedQualIds(toTs(since), qualIds);
        if (reached) {
          await db.addReachedQual(reached);
          console.log(`[sync] История квалов: ${reached.length} сделок за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
        }
      }
    } catch (e) {
      console.warn('[sync] Этапы/история квалов не получены:', e.message);
    }

    t0 = Date.now();
    await db.upsertFbInsights(fbRows);
    await db.upsertAmoLeads(amoLeads);
    await db.upsertAmoSales(amoSales.map((s) => ({ ...s, contract_date: s.contract_date || null, synced_at: new Date().toISOString() })));
    // Сделки, которые сейчас не в отделе Online, убираем из базы — чтобы переведённые в офлайн не считались.
    const offlineIds = [...new Set([...(amoLeads.excludedIds || []), ...(amoSales.excludedIds || [])])];
    const removedLeads = await db.deleteAmoLeadsByIds(offlineIds);
    const removedSales = await db.deleteAmoSalesByIds(offlineIds);
    if (removedLeads || removedSales) {
      console.log(`[sync] Убрано из базы (больше не Online): сделок ${removedLeads}, продаж ${removedSales}`);
    }
    await db.logSync({ since, until, fbRows: fbRows.length, amoRows: amoLeads.length, sheetRows: amoSales.length, status: 'ok' });
    console.log(`[sync] Запись в БД: за ${((Date.now() - t0) / 1000).toFixed(1)}с`);

    console.log(`[sync] OK (${since} — ${until}): FB ${fbRows.length}, amoCRM сделки ${amoLeads.length}, amoCRM продажи ${amoSales.length}`);
    return { since, until, fbRows: fbRows.length, amoRows: amoLeads.length, sheetRows: amoSales.length };
  } catch (err) {
    await db.logSync({ since, until, status: 'error', error: err.message }).catch(() => {});
    console.error('[sync] ОШИБКА:', err.message);
    throw err;
  } finally {
    syncInProgress = false;
  }
}

// ===================== ОТЧЁТ ДЛЯ ДАШБОРДА =====================
// Правила подсчёта (как в amoCRM):
// - Везде только отдел Online (остальные отделы в базу не попадают).
// - Лиды = сделки, СОЗДАННЫЕ в выбранном периоде (даты по времени Алматы).
// - Квал = сделка дошла до этапа "Квалификация пройдена" или любого этапа после него
//   (включая закрытые позже как "не реализовано", если по истории они доходили до квала).
// - Продажа/выручка = сделки с ДАТОЙ ЗАКЛЮЧЕНИЯ ДОГОВОРА в периоде (даже если сделка создана
//   в прошлых месяцах) на этапе "Полная оплата получена" / "Успешно реализовано". Выручка — бюджет сделки.
// - Верхний блок и таблица = ТОЛЬКО реклама: сделки с тегами НИШ (ADS_TAGS_NISH) или ЕНТ
//   (ADS_TAGS_ENT). Поле "Класс" не используется.
// - Нижний блок "Все онлайн" = все онлайн-сделки и продажи, из любых источников.

function sumPrice(list) {
  return list.reduce((sum, x) => sum + (x.price || 0), 0);
}

function buildSegmentReport(segment, fbRows, segLeads, segSales, isQual, rate) {
  const fbSeg = fbRows.filter((r) => r.segment === segment);

  // --- Таблица по объявлениям ---
  const rows = fbSeg.map((fb) => {
    const fbAdNameNorm = normalizeName(fb.ad_name);
    let related = segLeads.filter((l) => l.ad_id && String(l.ad_id) === String(fb.ad_id));
    if (related.length === 0 && fbAdNameNorm) {
      related = segLeads.filter((l) => l.fb_ad_name && normalizeName(l.fb_ad_name) === fbAdNameNorm);
    }
    const leads = fb.fb_leads || 0; // лиды по объявлению — из самого Facebook
    const qualified = related.filter(isQual).length;
    const adSales = segSales.filter((x) => x.fb_ad_name && normalizeName(x.fb_ad_name) === fbAdNameNorm);
    const revenue = sumPrice(adSales);
    const sales = adSales.length;
    return {
      ad_id: fb.ad_id, ad_name: fb.ad_name, adset_name: fb.adset_name, campaign_name: fb.campaign_name,
      spend: fb.spend, impressions: fb.impressions,
      ctr: fb.impressions > 0 ? (fb.clicks / fb.impressions) * 100 : 0,
      leads, qualified, sales, revenue,
      cpl: leads > 0 ? fb.spend / leads : null,
      cpql: qualified > 0 ? fb.spend / qualified : null,
      cac: sales > 0 ? fb.spend / sales : null,
      convRate: leads > 0 ? sales / leads : null,
      percentQualified: leads > 0 ? (qualified / leads) * 100 : null,
      roas: fb.spend > 0 ? revenue / (fb.spend * rate) : null,
    };
  });

  // --- Верхний блок: только реклама (по тегам сегмента) ---
  const spend = fbSeg.reduce((sum, r) => sum + (r.spend || 0), 0);
  const qualified = segLeads.filter(isQual).length;
  const totals = {
    spend,
    leads: segLeads.length,
    qualified,
    sales: segSales.length,
    revenue: sumPrice(segSales),
  };
  totals.cpl = totals.leads > 0 ? spend / totals.leads : null;
  totals.cpql = qualified > 0 ? spend / qualified : null;
  totals.cac = totals.sales > 0 ? spend / totals.sales : null;
  totals.percentQualified = totals.leads > 0 ? (qualified / totals.leads) * 100 : null;
  totals.roas = spend > 0 ? totals.revenue / (spend * rate) : null;

  return { segment, rows, totals, recommendations: buildRecommendations(rows) };
}

async function buildJoinedReport(since, until) {
  const sinceTs = toTs(since);
  const untilTs = toTs(until, true);
  const fbRows = await db.getFbInsightsInRange(since, until);
  const leads = await db.getAmoLeadsCreatedInRange(sinceTs, untilTs);
  const sales = await db.getAmoSalesInRange(sinceTs, untilTs);

  const statuses = (await db.getKv('pipeline_statuses')) || [];
  const qualStatusSet = new Set(qualifyingStatusIds(statuses));
  const reached = await db.getReachedQualSet();
  const isQual = (l) => qualStatusSet.has(Number(l.status_id)) || reached.has(Number(l.id)) || Number(l.is_qualified) === 1;

  // Курс для ROAS, если расход Facebook в другой валюте, чем выручка (например, $ -> ₸).
  const rate = Number(process.env.SPEND_TO_REVENUE_RATE || 1) || 1;

  const segOf = (x) => segmentByTags(x.tags);
  const nish = buildSegmentReport('nish', fbRows, leads.filter((l) => segOf(l) === 'nish'), sales.filter((x) => segOf(x) === 'nish'), isQual, rate);
  const ent = buildSegmentReport('ent', fbRows, leads.filter((l) => segOf(l) === 'ent'), sales.filter((x) => segOf(x) === 'ent'), isQual, rate);

  // --- Нижний блок: все онлайн-сделки и продажи (любые источники) ---
  const allQual = leads.filter(isQual).length;
  const general = {
    leads: leads.length,
    qualified: allQual,
    percentQualified: leads.length > 0 ? (allQual / leads.length) * 100 : null,
    sales: sales.length,
    revenue: sumPrice(sales),
  };

  return { since, until, nish, ent, general, lastSync: await db.getLastSync() };
}

module.exports = { runSync, buildJoinedReport };
