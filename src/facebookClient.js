const axios = require('axios');

function classifyCampaignSegment(campaignName) {
  const name = (campaignName || '').toUpperCase();
  if (name.includes('НИШ') || name.includes('NISH')) return 'nish';
  if (name.includes('ЕНТ') || name.includes('ENT')) return 'ent';
  return null;
}

// Забирает данные из Facebook Insights ПО ДНЯМ (time_increment=1) за указанный диапазон,
// чтобы потом можно было выбирать в интерфейсе любую дату или период.
async function fetchFacebookInsights(since, until) {
  const { FB_ACCESS_TOKEN, FB_AD_ACCOUNT_ID, FB_API_VERSION } = process.env;

  if (!FB_ACCESS_TOKEN || !FB_AD_ACCOUNT_ID) {
    throw new Error('FB_ACCESS_TOKEN или FB_AD_ACCOUNT_ID не заданы в .env');
  }

  const fields = [
    'campaign_id', 'campaign_name',
    'adset_id', 'adset_name',
    'ad_id', 'ad_name',
    'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc',
    'actions',
  ].join(',');

  let url = `https://graph.facebook.com/${FB_API_VERSION}/${FB_AD_ACCOUNT_ID}/insights`;
  let params = {
    level: 'ad',
    fields,
    time_range: JSON.stringify({ since, until }),
    time_increment: 1, // разбивка по дням — ключевая часть для выбора даты
    limit: 200,
    access_token: FB_ACCESS_TOKEN,
  };

  const rows = [];
  while (url) {
    const { data } = await axios.get(url, { params, validateStatus: () => true, timeout: 60000 });

    if (data.error) {
      throw new Error(`Facebook API error: ${data.error.message}`);
    }

    for (const row of data.data || []) {
      const leadAction = (row.actions || []).find(
        (a) => a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped'
      );
      const leads = leadAction ? Number(leadAction.value) : 0;
      const spend = Number(row.spend) || 0;

      rows.push({
        ad_id: row.ad_id,
        date: row.date_start,
        ad_name: row.ad_name,
        adset_id: row.adset_id,
        adset_name: row.adset_name,
        campaign_id: row.campaign_id,
        campaign_name: row.campaign_name,
        segment: classifyCampaignSegment(row.campaign_name),
        spend,
        impressions: Number(row.impressions) || 0,
        reach: Number(row.reach) || 0,
        clicks: Number(row.clicks) || 0,
        ctr: Number(row.ctr) || 0,
        cpc: Number(row.cpc) || 0,
        fb_leads: leads,
        fb_cpl: leads > 0 ? spend / leads : null,
        synced_at: new Date().toISOString(),
      });
    }

    url = data.paging && data.paging.next ? data.paging.next : null;
    params = undefined;
  }

  return rows;
}

module.exports = { fetchFacebookInsights };
