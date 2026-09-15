const axios = require('axios');

function getField(lead, fieldId) {
  if (!fieldId || fieldId === '0') return null;
  const field = (lead.custom_fields_values || []).find((f) => String(f.field_id) === String(fieldId));
  return field && field.values && field.values[0] ? field.values[0].value : null;
}

function classifySegment(klass, nishClasses, entClasses) {
  const k = Number(klass);
  if (nishClasses.includes(k)) return 'nish';
  if (entClasses.includes(k)) return 'ent';
  return null;
}

async function fetchAmoLeads(since, until) {
  const {
    AMO_SUBDOMAIN, AMO_ACCESS_TOKEN, AMO_PIPELINE_ID,
    AMO_STATUS_QUALIFIED, AMO_STATUS_SUCCESS, AMO_STATUS_FULL_PAYMENT, AMO_STATUS_WON,
    AMO_FIELD_CAMPAIGN_ID, AMO_FIELD_ADSET_ID, AMO_FIELD_AD_ID, AMO_FIELD_CLASS, AMO_FIELD_DEPARTMENT,
    NISH_CLASSES, ENT_CLASSES,
  } = process.env;

  if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
    throw new Error('AMO_SUBDOMAIN или AMO_ACCESS_TOKEN не заданы в .env');
  }

  const nishClasses = (NISH_CLASSES || '3,4,5,6').split(',').map(Number);
  const entClasses = (ENT_CLASSES || '9,10,11').split(',').map(Number);

  // Если статус "успешно реализовано" отдельно не задан — используем старый AMO_STATUS_WON для совместимости
  const successStatus = AMO_STATUS_SUCCESS || AMO_STATUS_WON;

  const sinceTs = Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000);
  const untilTs = Math.floor(new Date(until + 'T23:59:59Z').getTime() / 1000);

  const leads = [];
  let page = 1;
  const limit = 250;

  while (true) {
    const url = `https://${AMO_SUBDOMAIN}.amocrm.ru/api/v4/leads`;
    const params = {
      'filter[pipeline_id]': AMO_PIPELINE_ID,
      'filter[created_at][from]': sinceTs,
      'filter[created_at][to]': untilTs,
      with: 'custom_fields_values,tags',
      page,
      limit,
    };

    const resp = await axios.get(url, {
      params,
      headers: { Authorization: `Bearer ${AMO_ACCESS_TOKEN}` },
      validateStatus: () => true,
    });

    if (resp.status === 204) break;
    if (resp.status >= 400) {
      throw new Error(`amoCRM API error (${resp.status}): ${JSON.stringify(resp.data)}`);
    }

    const pageLeads = (resp.data._embedded && resp.data._embedded.leads) || [];
    if (pageLeads.length === 0) break;

    for (const lead of pageLeads) {
      const klass = getField(lead, AMO_FIELD_CLASS);
      const department = getField(lead, AMO_FIELD_DEPARTMENT);
      const tagNames = ((lead._embedded && lead._embedded.tags) || []).map((t) => t.name).join(',');

      // Если поле "Отдел" настроено — учитываем только Online, остальные пропускаем
      if (AMO_FIELD_DEPARTMENT && AMO_FIELD_DEPARTMENT !== '0') {
        const dep = (department || '').toLowerCase();
        if (dep !== 'online') continue;
      }

      leads.push({
        id: lead.id,
        name: lead.name,
        price: lead.price || 0,
        status_id: lead.status_id,
        created_at: lead.created_at,
        closed_at: lead.closed_at,
        campaign_id: getField(lead, AMO_FIELD_CAMPAIGN_ID),
        adset_id: getField(lead, AMO_FIELD_ADSET_ID),
        ad_id: getField(lead, AMO_FIELD_AD_ID),
        klass,
        segment: classifySegment(klass, nishClasses, entClasses),
        department: getField(lead, AMO_FIELD_DEPARTMENT),
        tags: tagNames,
        is_qualified: Number(lead.status_id) === Number(AMO_STATUS_QUALIFIED) ? 1 : 0,
        is_success: Number(lead.status_id) === Number(successStatus) ? 1 : 0,
        is_full_payment: Number(lead.status_id) === Number(AMO_STATUS_FULL_PAYMENT) ? 1 : 0,
        synced_at: new Date().toISOString(),
      });
    }

    page++;
  }

  return leads;
}

async function fetchAmoMeta() {
  const { AMO_SUBDOMAIN, AMO_ACCESS_TOKEN } = process.env;
  const headers = { Authorization: `Bearer ${AMO_ACCESS_TOKEN}` };

  const [fields, pipelines] = await Promise.all([
    axios.get(`https://${AMO_SUBDOMAIN}.amocrm.ru/api/v4/leads/custom_fields`, { headers, validateStatus: () => true }),
    axios.get(`https://${AMO_SUBDOMAIN}.amocrm.ru/api/v4/leads/pipelines`, { headers, validateStatus: () => true }),
  ]);

  return { fields: fields.data, pipelines: pipelines.data };
}

module.exports = { fetchAmoLeads, fetchAmoMeta };
