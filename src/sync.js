const { fetchFacebookInsights } = require('./facebookClient');
const { fetchAmoLeads } = require('./amoClient');
const db = require('./db');
const { buildRecommendations } = require('./recommendations');

// Синхронизация за конкретный диапазон дат (по умолчанию — последние 30 дней)
async function runSync(since, until) {
  if (!since || !until) {
    const today = new Date();
    const monthAgo = new Date();
    monthAgo.setDate(today.getDate() - 30);
    until = until || today.toISOString().slice(0, 10);
    since = since || monthAgo.toISOString().slice(0, 10);
  }

  try {
    const [fbRows, amoLeads] = await Promise.all([
      fetchFacebookInsights(since, until),
      fetchAmoLeads(since, until),
    ]);

    db.upsertFbInsights(fbRows);
    db.upsertAmoLeads(amoLeads);
    db.logSync({ since, until, fbRows: fbRows.length, amoRows: amoLeads.length, status: 'ok' });

    console.log(`[sync] OK (${since} — ${until}): ${fbRows.length} строк Facebook, ${amoLeads.length} сделок amoCRM`);
    return { since, until, fbRows: fbRows.length, amoRows: amoLeads.length };
  } catch (err) {
    db.logSync({ since, until, status: 'error', error: err.message });
    console.error('[sync] ОШИБКА:', err.message);
    throw err;
  }
}

// Джойн Facebook + amoCRM по ad_id за выбранный период — "мозг" сервиса
function buildJoinedReport(since, until) {
  const fbRows = db.getFbInsightsInRange(since, until);
  const amoLeads = db.getAmoLeadsInRange(since, until);

  const joined = fbRows.map((fb) => {
    const related = amoLeads.filter((l) => String(l.ad_id) === String(fb.ad_id));
    const leads = related.length;
    const qualified = related.filter((l) => l.is_qualified).length;
    const sales = related.filter((l) => l.is_won).length;
    const revenue = related.filter((l) => l.is_won).reduce((sum, l) => sum + (l.price || 0), 0);

    const cpl = leads > 0 ? fb.spend / leads : null;
    const convRate = leads > 0 ? sales / leads : null;
    const roas = fb.spend > 0 ? revenue / fb.spend : null;

    return {
      ad_id: fb.ad_id,
      ad_name: fb.ad_name,
      adset_name: fb.adset_name,
      campaign_name: fb.campaign_name,
      spend: fb.spend,
      impressions: fb.impressions,
      ctr: fb.impressions > 0 ? (fb.clicks / fb.impressions) * 100 : 0,
      leads,
      qualified,
      sales,
      revenue,
      cpl,
      convRate,
      roas,
    };
  });

  const totals = joined.reduce(
    (acc, r) => {
      acc.spend += r.spend;
      acc.leads += r.leads;
      acc.sales += r.sales;
      acc.revenue += r.revenue;
      return acc;
    },
    { spend: 0, leads: 0, sales: 0, revenue: 0 }
  );
  totals.cpl = totals.leads > 0 ? totals.spend / totals.leads : null;
  totals.roas = totals.spend > 0 ? totals.revenue / totals.spend : null;

  const recommendations = buildRecommendations(joined);

  return { since, until, rows: joined, totals, recommendations, lastSync: db.getLastSync() };
}

module.exports = { runSync, buildJoinedReport };
