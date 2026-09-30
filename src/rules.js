// Общие правила подсчёта — в одном месте, чтобы дашборд считал так же, как amoCRM.

// Часовой пояс для дат периода. Даты в дашборде — по времени Алматы (UTC+5), как в amoCRM.
const TZ_OFFSET = process.env.TZ_OFFSET || '+05:00';

// "2026-09-21" -> unix-время начала (00:00:00) или конца (23:59:59) этого дня по Алматы
function toTs(dateStr, endOfDay = false) {
  const time = endOfDay ? 'T23:59:59' : 'T00:00:00';
  return Math.floor(new Date(dateStr + time + TZ_OFFSET).getTime() / 1000);
}

function tagList(envValue) {
  return (envValue || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function hasAnyTag(tagsStr, list) {
  if (!list.length) return false;
  return (tagsStr || '').split(',').map((t) => t.trim().toLowerCase()).some((t) => list.includes(t));
}

// Сегмент сделки определяется ТОЛЬКО по рекламным тегам (поле "Класс" не используется):
// теги ADS_TAGS_NISH -> 'nish', теги ADS_TAGS_ENT -> 'ent', без рекламных тегов -> null.
function segmentByTags(tagsStr) {
  if (hasAnyTag(tagsStr, tagList(process.env.ADS_TAGS_NISH))) return 'nish';
  if (hasAnyTag(tagsStr, tagList(process.env.ADS_TAGS_ENT))) return 'ent';
  return null;
}

module.exports = { toTs, tagList, hasAnyTag, segmentByTags };
