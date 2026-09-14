/**
 * Простой, но расширяемый движок правил-рекомендаций.
 * На вход — массив объединённых метрик по объявлениям (см. sync.js -> buildJoinedReport).
 * На выход — массив { ad_id, ad_name, level: 'critical'|'warning'|'good', message }.
 *
 * Логика намеренно прозрачная (rule-based), а не "чёрный ящик" —
 * пороги задаются в .env и их легко поменять под свою unit-экономику.
 */
function buildRecommendations(joinedRows) {
  const minLeadsForDisable = Number(process.env.REC_MIN_LEADS_FOR_DISABLE || 10);
  const minRoasForScale = Number(process.env.REC_MIN_ROAS_FOR_SCALE || 3);

  // Средний CPL по всем объявлениям с расходом > 0 — точка отсчёта "дорого/дёшево"
  const withSpend = joinedRows.filter((r) => r.spend > 0);
  const avgCpl = withSpend.length
    ? withSpend.reduce((sum, r) => sum + (r.cpl || 0), 0) / withSpend.filter((r) => r.cpl).length || 0
    : 0;

  return joinedRows
    .filter((r) => r.spend > 0)
    .map((r) => {
      const items = [];

      if (r.leads === 0) {
        items.push({ level: 'critical', message: `Расход ${r.spend.toFixed(0)}, но 0 лидов — проверить объявление/таргетинг` });
      } else if (r.sales === 0 && r.leads >= minLeadsForDisable) {
        items.push({ level: 'critical', message: `${r.leads} лидов, но 0 продаж — кандидат на отключение или смену оффера` });
      }

      if (avgCpl > 0 && r.cpl && r.cpl > avgCpl * 1.5) {
        items.push({ level: 'warning', message: `CPL (${r.cpl.toFixed(0)}) выше среднего по аккаунту в ${(r.cpl / avgCpl).toFixed(1)}x — дорогой лид` });
      }

      if (r.roas !== null && r.roas >= minRoasForScale) {
        items.push({ level: 'good', message: `ROAS ${r.roas.toFixed(1)}x — хороший результат, кандидат на масштабирование бюджета` });
      }

      if (r.convRate !== null && r.convRate >= 0.2 && r.leads >= 5) {
        items.push({ level: 'good', message: `Конверсия лид→оплата ${(r.convRate * 100).toFixed(0)}% — сильный оффер/креатив, качественный трафик` });
      }

      if (items.length === 0) {
        items.push({ level: 'neutral', message: 'Показатели в норме, явных сигналов нет' });
      }

      return {
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        campaign_name: r.campaign_name,
        items,
      };
    })
    // сначала критичные сигналы, потом хорошие, потом нейтральные
    .sort((a, b) => {
      const rank = { critical: 0, warning: 1, good: 2, neutral: 3 };
      return rank[a.items[0].level] - rank[b.items[0].level];
    });
}

module.exports = { buildRecommendations };
