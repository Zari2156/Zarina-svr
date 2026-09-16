const { fetchFacebookInsights } = require('./facebookClient');
const { fetchAmoLeads } = require('./amoClient');
const { fetchGeneralSales } = require('./googleSheetClient');
const db = require('./db');
const { buildRecommendations } = require('./recommendations');

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
    const [fbRows, amoLeads, sheetRows] = await Promise.all([
      fetchFacebookInsights(since, until),
      fetchAmoLeads(since, until),
      fetchGeneralSales(), // отдаёт весь лог; отфильтруем по датам при чтении из БД
    ]);

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
function buildSegmentReport(segment, since, until, fbRows, amoLeads, sheetRows, adsTags) {
  const fbSeg = fbRows.filter((r) => r.segment === segment);
  const amoSeg = amoLeads.filter((r) => r.segment === segment);
  const sheetSeg = sheetRows.filter((r) => r.segment === segment);

  // --- Джойн по объявлениям (как раньше, но только для этого сегмента) ---
  const rows = fbSeg.map((fb) => {
    const related = amoSeg.filter((l) => String(l.ad_id) === String(fb.ad_id));
    const leads = related.length;
    const qualified = related.filter((l) => l.is_qualified).length;
    const success = related.filter((l) => l.is_success);
    const fullPayments = related.filter((l) => l.is_full_payment);
    const revenue = success.reduce((sum, l) => sum + (l.price || 0), 0);
    const sales = fullPayments.length;

    const cpl = leads > 0 ? fb.spend / leads : null;
    const convRate = leads > 0 ? sales / leads : null;
    const roas = fb.spend > 0 ? revenue / fb.spend : null;

    return {
      ad_id: fb.ad_id, ad_name: fb.ad_name, adset_name: fb.adset_name, campaign_name: fb.campaign_name,
      spend: fb.spend, impressions: fb.impressions,
      ctr: fb.impressions > 0 ? (fb.clicks / fb.impressions) * 100 : 0,
      leads, qualified, sales, revenue, cpl, convRate, roas,
    };
  });

  const totals = rows.reduce((acc, r) => {
    acc.spend += r.spend; acc.leads += r.leads; acc.sales += r.sales; acc.revenue += r.revenue;
    return acc;
  }, { spend: 0, leads: 0, sales: 0, revenue: 0 });
  totals.cpl = totals.leads > 0 ? totals.spend / totals.leads : null;
  totals.roas = totals.spend > 0 ? totals.revenue / totals.spend : null;

  // --- Блок "С рекламы" — по тегам amoCRM, независимо от ad_id ---
  const adsLeads = amoSeg.filter((l) => {
    const tags = (l.tags || '').split(',').map((t) => t.trim());
    return tags.some((t) => adsTags.includes(t));
  });
  const adsBlock = {
    leads: adsLeads.length,
    qualified: adsLeads.filter((l) => l.is_qualified).length,
    sales: adsLeads.filter((l) => l.is_full_payment).length,
    revenue: adsLeads.filter((l) => l.is_success).reduce((sum, l) => sum + (l.price || 0), 0),
  };

  // --- Общие продажи (все источники, из Google Таблицы) ---
  const generalSales = {
    total: sheetSeg.reduce((sum, r) => sum + r.amount, 0),
    new: sheetSeg.filter((r) => r.is_new).reduce((sum, r) => sum + r.amount, 0),
    repeat: sheetSeg.filter((r) => !r.is_new).reduce((sum, r) => sum + r.amount, 0),
    count: sheetSeg.length,
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
