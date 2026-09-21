const { fetchFacebookInsights } = require('./facebookClient');
const { fetchAmoLeads, fetchAmoLeadsByIds } = require('./amoClient');
const { fetchGeneralSales } = require('./googleSheetClient');
const db = require('./db');
const { buildRecommendations } = require('./recommendations');

function getAdsTags() {
  return {
    nish: (process.env.ADS_TAGS_NISH || '').split(',').map((t) => t.trim()).filter(Boolean),
    ent: (process.env.ADS_TAGS_ENT || '').split(',').map((t) => t.trim()).filter(Boolean),
  };
}

// Помечает у каждого НОВОГО платежа (is_new=1) из Google Таблицы, пришёл ли он "с рекламы":
// ищет сделку с таким же ID в amoCRM (независимо от даты создания сделки) и проверяет,
// есть ли у неё тег из списка рекламных тегов её сегмента (НИШ/ЕНТ).
// Повторные продажи и доплаты (is_new=0) в "С рекламы" никогда не попадают — так решили.
async function markAdsPayments(sheetRows) {
  const adsTags = getAdsTags();
  const idsToCheck = sheetRows.filter((r) => r.is_new).map((r) => r.id);
  const tagsById = await fetchAmoLeadsByIds(idsToCheck);

  return sheetRows.map((r) => {
    if (!r.is_new) return { ...r, is_from_ads: 0 };
    const tags = tagsById[String(r.id)] || [];
    const relevantTags = r.segment === 'nish' ? adsTags.nish : r.segment === 'ent' ? adsTags.ent : [];
    const matched = relevantTags.length > 0 && tags.some((t) => relevantTags.includes(t));
    return { ...r, is_from_ads: matched ? 1 : 0 };
  });
}

// Приводит название к единому виду для сравнения: убирает разницу в регистре, лишние пробелы
// по краям и схлопывает несколько пробелов внутри в один — чтобы "Ниш Каз 4кл " и "ниш каз  4кл"
// считались одним и тем же объявлением.
function normalizeName(str) {
  return (str || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
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

async function runSync(sinceIn, untilIn) {
  const { since, until } = defaultRangeIfMissing(sinceIn, untilIn);

  try {
    const [fbRows, amoLeads, sheetRowsRaw] = await Promise.all([
      fetchFacebookInsights(since, until),
      fetchAmoLeads(since, until),
      fetchGeneralSales(), // отдаёт весь лог; отфильтруем по датам при чтении из БД
    ]);

    // Для каждого нового платежа из таблицы проверяем в amoCRM по ID, есть ли рекламный тег —
    // это отдельный запрос к amoCRM (по ID, не по дате создания сделки), делаем один раз тут при синке.
    const sheetRows = await markAdsPayments(sheetRowsRaw);

    db.upsertFbInsights(fbRows);
    db.upsertAmoLeads(amoLeads);
    db.upsertGeneralSales(sheetRows);
    db.logSync({ since, until, fbRows: fbRows.length, amoRows: amoLeads.length, sheetRows: sheetRows.length, status: 'ok' });

    console.log(`[sync] OK (${since} — ${until}): FB ${fbRows.length}, amoCRM ${amoLeads.length}, таблица ${sheetRows.length}`);
    return { since, until, fbRows: fbRows.length, amoRows: amoLeads.length, sheetRows: sheetRows.length };
  } catch (err) {
    db.logSync({ since, until, status: 'error', error: err.message });
    console.error('[sync] ОШИБКА:', err.message);
    throw err;
  }
}

// Строит один сегмент (НИШ или ЕНТ): джойн Facebook+amoCRM по ad_id + блок "с рекламы" по тегам
// + общие продажи из Google Таблицы.
// "Лид" — сделка СОЗДАНА в выбранном периоде. "Квал" — на момент синхронизации текущий статус
// сделки равен статусу "Квалификация пройдена" (AMO_STATUS_QUALIFIED) — сделки в этой воронке
// с этого статуса дальше не переходят, поэтому текущего статуса достаточно.
function buildSegmentReport(segment, since, until, fbRows, amoLeads, sheetRows, adsTags) {
  const fbSeg = fbRows.filter((r) => r.segment === segment);
  const amoSeg = amoLeads.filter((r) => r.segment === segment);
  const sheetSeg = sheetRows.filter((r) => r.segment === segment);

  // --- Джойн по объявлениям (детализация по каждому креативу) ---
  const rows = fbSeg.map((fb) => {
    const fbAdNameNorm = normalizeName(fb.ad_name);
    // Сопоставление с amoCRM нужно ТОЛЬКО для квалов/продаж (Facebook не знает о квалификации) —
    // сначала пробуем по ad_id (если он вообще у кого-то заполнен), иначе по названию объявления
    // (FB_AD_NAME из amoCRM, приходит через Zapier-интеграцию с Facebook).
    let related = amoSeg.filter((l) => l.ad_id && String(l.ad_id) === String(fb.ad_id));
    if (related.length === 0 && fbAdNameNorm) {
      related = amoSeg.filter((l) => l.fb_ad_name && normalizeName(l.fb_ad_name) === fbAdNameNorm);
    }
    // "Лиды" на объявление — берём НЕ из amoCRM (связка может быть неполной), а готовой цифрой
    // прямо из Facebook (fb_leads) — там это уже посчитано точно средствами самого Facebook.
    const leads = fb.fb_leads || 0;
    const qualified = related.filter((l) => l.is_qualified).length;
    // Продажи/выручка по объявлению — пока всё ещё по текущему статусу amoCRM (is_success/is_full_payment).
    // ВАЖНО: в отличие от adsBlock ниже, эта детализация по объявлениям ещё НЕ переведена на
    // деньги из Google Таблицы — здесь используется старое поле "Бюджет" amoCRM. Это отдельная
    // задача на доработку, если нужна точная выручка в разрезе по каждому креативу.
    const success = related.filter((l) => l.is_success);
    const fullPayments = related.filter((l) => l.is_full_payment);
    const revenue = success.reduce((sum, l) => sum + (l.price || 0), 0);
    const sales = fullPayments.length;

    const cpl = leads > 0 ? fb.spend / leads : null;
    const cpql = qualified > 0 ? fb.spend / qualified : null;
    const cac = sales > 0 ? fb.spend / sales : null;
    const convRate = leads > 0 ? sales / leads : null;
    const percentQualified = leads > 0 ? (qualified / leads) * 100 : null;
    const roas = fb.spend > 0 ? revenue / fb.spend : null;

    return {
      ad_id: fb.ad_id, ad_name: fb.ad_name, adset_name: fb.adset_name, campaign_name: fb.campaign_name,
      spend: fb.spend, impressions: fb.impressions,
      ctr: fb.impressions > 0 ? (fb.clicks / fb.impressions) * 100 : 0,
      leads, qualified, sales, revenue, cpl, cpql, cac, convRate, percentQualified, roas,
    };
  });

  // --- Блок "С рекламы" (считаем ДО totals, т.к. totals берёт из него продажи/выручку) ---
  const adsLeads = amoSeg.filter((l) => {
    const tags = (l.tags || '').split(',').map((t) => t.trim());
    return tags.some((t) => adsTags.includes(t));
  });
  const adsQualifiedCount = adsLeads.filter((l) => l.is_qualified).length;
  // sales / revenue — деньги: берём НЕ из поля "Бюджет" amoCRM (оно меняется по ходу сделки и
  // не хранит историю) и НЕ из джойна по ad_id (он работает только если сделке проставлен ID
  // объявления — а это есть не всегда), а из фактических платежей в Google Таблице, помеченных
  // при синке (markAdsPayments) как "с рекламы" — по совпадению ID сделки + рекламный тег.
  const adsPayments = sheetSeg.filter((r) => r.is_from_ads);
  const adsBlock = {
    leads: adsLeads.length,
    qualified: adsQualifiedCount,
    percentQualified: adsLeads.length > 0 ? (adsQualifiedCount / adsLeads.length) * 100 : null,
    sales: adsPayments.length,
    revenue: adsPayments.reduce((sum, r) => sum + r.amount, 0),
  };

  // Итоги сегмента: leads/qualified — по ВСЕМ сделкам сегмента за период (не зависит от ad_id).
  // sales/revenue — из adsBlock (надёжный источник, см. выше), а НЕ суммой строк-объявлений —
  // та сумма верна только если у сделок стоит ad_id, что бывает не всегда.
  const totalSpend = fbSeg.reduce((sum, r) => sum + r.spend, 0);
  const totalQualified = amoSeg.filter((l) => l.is_qualified).length;
  const totals = {
    spend: totalSpend,
    leads: amoSeg.length,
    qualified: totalQualified,
    sales: adsBlock.sales,
    revenue: adsBlock.revenue,
  };
  totals.cpl = totals.leads > 0 ? totals.spend / totals.leads : null;
  totals.cpql = totals.qualified > 0 ? totals.spend / totals.qualified : null;
  totals.cac = totals.sales > 0 ? totals.spend / totals.sales : null;
  totals.percentQualified = totals.leads > 0 ? (totals.qualified / totals.leads) * 100 : null;
  totals.roas = totals.spend > 0 ? totals.revenue / totals.spend : null;

  // --- Общие продажи (все источники, из Google Таблицы) ---
  // Квал. лиды тут — НЕ из таблицы (там их нет), а широким фильтром по amoCRM: весь сегмент
  // (Online + класс НИШ/ЕНТ) за период, без привязки к тегам/рекламе — теговые лиды и так уже
  // входят в этот широкий охват.
  const generalSales = {
    total: sheetSeg.reduce((sum, r) => sum + r.amount, 0),
    new: sheetSeg.filter((r) => r.is_new).reduce((sum, r) => sum + r.amount, 0),
    repeat: sheetSeg.filter((r) => !r.is_new).reduce((sum, r) => sum + r.amount, 0),
    count: sheetSeg.length,
    qualified: totalQualified,
  };

  return { segment, rows, totals, adsBlock, generalSales, recommendations: buildRecommendations(rows) };
}

function buildJoinedReport(since, until) {
  const fbRows = db.getFbInsightsInRange(since, until);
  const amoLeads = db.getAmoLeadsInRange(since, until);
  const sheetRows = db.getGeneralSalesInRange(since, until);

  const adsTagsNish = (process.env.ADS_TAGS_NISH || '').split(',').map((t) => t.trim()).filter(Boolean);
  const adsTagsEnt = (process.env.ADS_TAGS_ENT || '').split(',').map((t) => t.trim()).filter(Boolean);

  const nish = buildSegmentReport('nish', since, until, fbRows, amoLeads, sheetRows, adsTagsNish);
  const ent = buildSegmentReport('ent', since, until, fbRows, amoLeads, sheetRows, adsTagsEnt);

  // ВРЕМЕННАЯ ДИАГНОСТИКА: показывает, как распределились сделки/объявления по сегментам,
  // чтобы понять, почему НИШ/ЕНТ могут быть пустыми.
  const debug = {
    totalAmoLeadsInRange: amoLeads.length,
    amoNish: amoLeads.filter((l) => l.segment === 'nish').length,
    amoEnt: amoLeads.filter((l) => l.segment === 'ent').length,
    amoNoSegment: amoLeads.filter((l) => !l.segment).length,
    sampleAmoLead: amoLeads[0] || null,
    totalFbRowsInRange: fbRows.length,
    fbNish: fbRows.filter((r) => r.segment === 'nish').length,
    fbEnt: fbRows.filter((r) => r.segment === 'ent').length,
    fbNoSegment: fbRows.filter((r) => !r.segment).length,
    sampleFbRow: fbRows[0] || null,
  };

  return { since, until, nish, ent, lastSync: db.getLastSync(), debug };
}

module.exports = { runSync, buildJoinedReport };
