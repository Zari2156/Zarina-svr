const axios = require('axios');

function getField(lead, fieldId) {
  if (!fieldId || fieldId === '0') return null;
  const field = (lead.custom_fields_values || []).find((f) => String(f.field_id) === String(fieldId));
  return field && field.values && field.values[0] ? field.values[0].value : null;
}

// Распознаёт значение "Да" в поле-флажке независимо от регистра/формата (Да / ДА / true / yes)
function isYes(value) {
  if (value === null || value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  return v === 'да' || v === 'yes' || v === 'true' || v === '1';
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
    AMO_FIELD_FB_CAMPAIGN_NAME, AMO_FIELD_FB_ADSET_NAME, AMO_FIELD_FB_AD_NAME, AMO_FIELD_QUALIFIED_FLAG,
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
        // Названия кампании/группы объявлений/объявления, которые приходят в amoCRM через
        // интеграцию (Zapier) из Facebook — используются для сопоставления с рекламным кабинетом,
        // т.к. числовой ad_id часто не заполняется, а название — надёжный источник совпадения.
        fb_campaign_name: getField(lead, AMO_FIELD_FB_CAMPAIGN_NAME),
        fb_adset_name: getField(lead, AMO_FIELD_FB_ADSET_NAME),
        fb_ad_name: getField(lead, AMO_FIELD_FB_AD_NAME),
        klass,
        segment: classifySegment(klass, nishClasses, entClasses),
        department: getField(lead, AMO_FIELD_DEPARTMENT),
        tags: tagNames,
        // Квал засчитывается, если ЛИБО текущий статус сделки = "Квалификация пройдена",
        // ЛИБО отдельное поле-флажок "Квалификация пройдена" (Да/Нет) стоит на "Да" —
        // проверяем оба варианта, чтобы не терять квалов, если что-то одно не сработает.
        is_qualified: (Number(lead.status_id) === Number(AMO_STATUS_QUALIFIED)
          || isYes(getField(lead, AMO_FIELD_QUALIFIED_FLAG))) ? 1 : 0,
        is_success: Number(lead.status_id) === Number(successStatus) ? 1 : 0,
        is_full_payment: Number(lead.status_id) === Number(AMO_STATUS_FULL_PAYMENT) ? 1 : 0,
        synced_at: new Date().toISOString(),
      });
    }

    page++;
  }

  return leads;
}

// Ищет в amoCRM сделки по конкретным ID (пачками, т.к. amoCRM ограничивает длину запроса)
// и отдаёт только теги — этого достаточно, чтобы понять, пришла ли сделка "с рекламы".
// В отличие от fetchAmoLeads, НЕ ограничена датой создания сделки — нужна сделка любого возраста,
// если оплата по ней (из Google Таблицы) попала в выбранный период.
async function fetchAmoLeadsByIds(ids) {
  const { AMO_SUBDOMAIN, AMO_ACCESS_TOKEN, AMO_FIELD_FB_AD_NAME } = process.env;
  if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN) {
    throw new Error('AMO_SUBDOMAIN или AMO_ACCESS_TOKEN не заданы в .env');
  }

  const uniqueIds = [...new Set((ids || []).map((id) => String(id).trim()).filter(Boolean))];
  const result = {}; // { [leadId]: { tags: ['tag1', ...], ad_name: 'Название объявления' | null } }
  if (uniqueIds.length === 0) return result;

  const batchSize = 50; // безопасный размер пачки для длины URL
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const params = new URLSearchParams();
    batch.forEach((id) => params.append('filter[id][]', id));
    params.append('with', 'tags,custom_fields_values');
    params.append('limit', String(batchSize));

    const url = `https://${AMO_SUBDOMAIN}.amocrm.ru/api/v4/leads?${params.toString()}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${AMO_ACCESS_TOKEN}` },
      validateStatus: () => true,
    });

    if (resp.status === 204) continue; // ни одна сделка из пачки не найдена — не ошибка
    if (resp.status >= 400) {
      // Не роняем весь синк из-за одной проблемной пачки ID — просто логируем и идём дальше
      console.error(`[amoClient] fetchAmoLeadsByIds: ошибка ${resp.status} на пачке ${i}-${i + batch.length}`);
      continue;
    }

    const pageLeads = (resp.data._embedded && resp.data._embedded.leads) || [];
    for (const lead of pageLeads) {
      const tagNames = ((lead._embedded && lead._embedded.tags) || []).map((t) => t.name);
      result[String(lead.id)] = {
        tags: tagNames,
        ad_name: getField(lead, AMO_FIELD_FB_AD_NAME),
      };
    }
  }

  return result;
}

// Ищет в истории событий amoCRM, КОГДА каждая сделка впервые попала на нужный статус
// (например, "Квалификация пройдена") — а не когда она была создана и не какой у неё статус
// сейчас. Это нужно, чтобы правильно относить сделку к периоду отчёта: сделка могла быть
// создана 1 сентября, а квалифицирована только 9-го — и должна попасть именно в период,
// где стоит 9 сентября, а не 1-е.
async function fetchStatusChangeDates(leadIds, statusId) {
  const { AMO_SUBDOMAIN, AMO_ACCESS_TOKEN } = process.env;
  const result = {}; // { [leadId]: unix-время САМОГО РАННЕГО перехода на этот статус }
  if (!AMO_SUBDOMAIN || !AMO_ACCESS_TOKEN || !statusId) return result;

  const uniqueIds = [...new Set((leadIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return result;

  const batchSize = 50; // безопасный размер пачки для длины URL
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    let page = 1;
    const limit = 250;

    while (true) {
      const params = new URLSearchParams();
      params.append('filter[type][]', 'lead_status_changed');
      params.append('filter[entity]', 'lead');
      batch.forEach((id) => params.append('filter[entity_id][]', id));
      params.append('page', String(page));
      params.append('limit', String(limit));

      const url = `https://${AMO_SUBDOMAIN}.amocrm.ru/api/v4/events?${params.toString()}`;
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${AMO_ACCESS_TOKEN}` },
        validateStatus: () => true,
      });

      if (resp.status === 204) break; // на этой пачке событий больше нет
      if (resp.status >= 400) {
        console.error(`[amoClient] fetchStatusChangeDates: ошибка ${resp.status} (пачка ${i}, стр. ${page})`);
        break; // не роняем весь синк из-за одной пачки — просто эти ID останутся без qualified_at
      }

      const events = (resp.data._embedded && resp.data._embedded.events) || [];
      if (events.length === 0) break;

      for (const ev of events) {
        const after = (ev.value_after && ev.value_after[0]) || {};
        // amoCRM отдаёт статус то как value_after[0].lead_status.id, то (в старых версиях) как status_id —
        // проверяем оба варианта, чтобы не потерять совпадение из-за формата ответа.
        const afterStatusId = (after.lead_status && after.lead_status.id) || after.status_id || null;
        if (afterStatusId === null || String(afterStatusId) !== String(statusId)) continue;

        const leadId = String(ev.entity_id);
        const ts = ev.created_at;
        if (!result[leadId] || ts < result[leadId]) {
          result[leadId] = ts; // запоминаем САМЫЙ РАННИЙ переход, если сделка попадала на статус несколько раз
        }
      }

      if (events.length < limit) break; // последняя страница для этой пачки ID
      page++;
      if (page > 20) break; // защита от бесконечного цикла на случай неожиданного ответа API
    }
  }

  return result;
}

async function fetchAmoMeta() {
  const { AMO_SUBDOMAIN, AMO_ACCESS_TOKEN } = process.env;
  const headers = { Authorization: `Bearer ${AMO_ACCESS_TOKEN}` };

  const [fields, pipelines] = await Promise.all([
    axios.get(`https://${AMO_SUBDOMAIN}.amocrm.ru/api/v4/leads/custom_fields?limit=250`, { headers, validateStatus: () => true }),
    axios.get(`https://${AMO_SUBDOMAIN}.amocrm.ru/api/v4/leads/pipelines`, { headers, validateStatus: () => true }),
  ]);

  // Простой читаемый список полей: ID + название + код — чтобы не искать вручную по интерфейсу amoCRM.
  const fieldsList = ((fields.data._embedded && fields.data._embedded.custom_fields) || [])
    .map((f) => ({ id: f.id, name: f.name, code: f.code, type: f.type_id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  // Простой список воронок и статусов внутри них — с ID, чтобы находить AMO_STATUS_* без гадания.
  const pipelinesList = ((pipelines.data._embedded && pipelines.data._embedded.pipelines) || []).map((p) => ({
    id: p.id,
    name: p.name,
    statuses: ((p._embedded && p._embedded.statuses) || []).map((s) => ({ id: s.id, name: s.name, sort: s.sort, type: s.type })),
  }));

  return { fieldsList, pipelinesList, raw: { fields: fields.data, pipelines: pipelines.data } };
}

module.exports = { fetchAmoLeads, fetchAmoLeadsByIds, fetchStatusChangeDates, fetchAmoMeta };
