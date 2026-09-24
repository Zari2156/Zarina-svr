const { fetchFacebookInsights } = require('./facebookClient');
const { fetchAmoLeads, fetchAmoSalesByContractDate } = require('./amoClient');
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

    db.upsertFbInsights(fbRows);
    db.upsertAmoLeads(amoLeads);
    const sinceTs = Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000);
    const untilTs = Math.floor(new Date(until + 'T23:59:59Z').getTime() / 1000);
    db.upsertAmoSales(amoSales.map((s) => ({ ...s, contract_date: s.contract_date || null, synced_at: new Date().toISOString() })));
    db.logSync({ since, until, fbRows: fbRows.length, amoRows: amoLeads.length, sheetRows: amoSales.length, status: 'ok' });

    console.log(`[sync] OK (${since} — ${until}): FB ${fbRows.length}, amoCRM сделки ${amoLeads.length}, amoCRM продажи ${amoSales.length}`);
    return { since, until, fbRows: fbRows.length, amoRows: amoLeads.length, sheetRows: amoSales.length };
  } catch (err) {
    db.logSync({ since, until, status: 'error', error: err.message });
    console.error('[sync] ОШИБКА:', err.message);
    throw err;
  }
}

// Строит один сегмент (НИШ или ЕНТ): джойн Facebook+amoCRM по ad_id/названию + блок "с рекламы"
// по тегам + общие продажи. Все данные — из двух источников: Facebook и amoCRM (Google Таблица
// больше не используется).
// "Лид" — сделка СОЗДАНА в выбранном периоде. "Квал" — на момент синхронизации текущий статус
// сделки равен статусу "Квалификация пройдена". "Продажа"/"Выручка" — сделки со статусом
// "Успешно реализовано", попавшие в период по ДАТЕ ЗАКЛЮЧЕНИЯ ДОГОВОРА (amoSalesRows).
function buildSegmentReport(segment, since, until, fbRows, amoLeads, amoSalesRows, adsTags) {
  const fbSeg = fbRows.filter((r) => r.segment === segment);
  const amoSeg = amoLeads.filter((r) => r.segment === segment);
  const salesSeg = amoSalesRows.filter((r) => r.segment === segment);

  const hasAdsTag = (tagsStr, list) => (tagsStr || '').split(',').map((t) => t.trim()).some((t) => list.includes(t));

  // --- Джойн по объявлениям (детализация по каждому креативу) ---
  const rows = fbSeg.map((fb) => {
    const fbAdNameNorm = normalizeName(fb.ad_name);
    // Сопоставление с amoCRM нужно ТОЛЬКО для квалов (Facebook не знает о квалификации) —
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
    // Продажи/выручка по объявлению — сделки из amoSales (уже отфильтрованы по статусу
    // "Успешно реализовано" и дате заключения договора), сматченные по названию объявления.
    const adSales = salesSeg.filter((s) => s.fb_ad_name && normalizeName(s.fb_ad_name) === fbAdNameNorm);
    const revenue = adSales.reduce((sum, s) => sum + (s.price || 0), 0);
    const sales = adSales.length;

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
  const adsLeads = amoSeg.filter((l) => hasAdsTag(l.tags, adsTags));
  const adsQualifiedCount = adsLeads.filter((l) => l.is_qualified).length;
  // sales / revenue — сделки из amoSales (успешные, по дате заключения договора) с рекламным тегом.
  const adsPayments = salesSeg.filter((s) => hasAdsTag(s.tags, adsTags));
  const adsBlock = {
    leads: adsLeads.length,
    qualified: adsQualifiedCount,
    percentQualified: adsLeads.length > 0 ? (adsQualifiedCount / adsLeads.length) * 100 : null,
    sales: adsPayments.length,
    revenue: adsPayments.reduce((sum, s) => sum + (s.price || 0), 0),
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

  // --- Общие продажи (все источники) ---
  // Считаем ПО ВСЕМ сделкам сегмента (Online + класс НИШ/ЕНТ), дошедшим до успешной оплаты в
  // периоде — не только с рекламы. Разбивку "новые/повторные" убрали вместе с Google Таблицей —
  // amoCRM в этом разрезе такого деления не даёт; если нужно будет вернуть, обсудим отдельно.
  const generalSales = {
    total: salesSeg.reduce((sum, s) => sum + (s.price || 0), 0),
    count: salesSeg.length,
    qualified: totalQualified,
  };

  return { segment, rows, totals, adsBlock, generalSales, recommendations: buildRecommendations(rows) };
}

function buildJoinedReport(since, until) {
  const fbRows = db.getFbInsightsInRange(since, until);
  const amoLeads = db.getAmoLeadsInRange(since, until);
  const sinceTs = Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000);
  const untilTs = Math.floor(new Date(until + 'T23:59:59Z').getTime() / 1000);
  const amoSalesRows = db.getAmoSalesInRange(sinceTs, untilTs);

  const adsTagsNish = (process.env.ADS_TAGS_NISH || '').split(',').map((t) => t.trim()).filter(Boolean);
  const adsTagsEnt = (process.env.ADS_TAGS_ENT || '').split(',').map((t) => t.trim()).filter(Boolean);

  const nish = buildSegmentReport('nish', since, until, fbRows, amoLeads, amoSalesRows, adsTagsNish);
  const ent = buildSegmentReport('ent', since, until, fbRows, amoLeads, amoSalesRows, adsTagsEnt);

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
