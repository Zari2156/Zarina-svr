const fmt = (n, digits = 0) => (n === null || n === undefined || Number.isNaN(n))
  ? '—'
  : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits });

const fmtRoas = (n) => (n === null || n === undefined) ? '—' : `${n.toFixed(1)}x`;
const fmtPct = (n) => (n === null || n === undefined) ? '—' : `${(n * 100).toFixed(0)}%`;

let currentReport = null;
let chart = null;

function getSelectedRange() {
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;
  return { since: from, until: to };
}

function initDefaultDates() {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 30);
  document.getElementById('dateFrom').value = from.toISOString().slice(0, 10);
  document.getElementById('dateTo').value = to.toISOString().slice(0, 10);
}

async function loadDashboard() {
  const { since, until } = getSelectedRange();
  const res = await fetch(`/api/dashboard?since=${since}&until=${until}`);
  const data = await res.json();
  currentReport = data;
  render(data);
}

function render(data) {
  const hasData = data.rows && data.rows.length > 0;
  document.getElementById('emptyState').hidden = hasData;
  document.querySelector('.layout').style.display = hasData ? 'block' : 'none';

  if (data.lastSync) {
    const d = new Date(data.lastSync.ran_at);
    document.getElementById('lastSync').textContent = `Обновлено: ${d.toLocaleString('ru-RU')}`;
  }

  if (!hasData) return;

  renderTotals(data.totals);
  renderTable(data.rows);
  renderRecommendations(data.recommendations);
  renderChart(data.rows);
}

function renderTotals(t) {
  const cards = [
    { label: 'Расход', value: fmt(t.spend) },
    { label: 'Лиды', value: fmt(t.leads) },
    { label: 'Средний CPL', value: fmt(t.cpl) },
    { label: 'Продажи', value: fmt(t.sales) },
    { label: 'Выручка', value: fmt(t.revenue) },
    { label: 'ROAS', value: fmtRoas(t.roas) },
  ];
  document.getElementById('totals').innerHTML = cards.map(c => `
    <div class="total-card">
      <div class="total-card__label">${c.label}</div>
      <div class="total-card__value">${c.value}</div>
    </div>
  `).join('');
}

function renderTable(rows) {
  const sortBy = document.getElementById('sortSelect').value;
  const sorted = [...rows].sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));

  document.getElementById('adsTableBody').innerHTML = sorted.map(r => `
    <tr>
      <td class="name-cell">${r.ad_name || r.ad_id}<span class="campaign">${r.adset_name || ''}</span></td>
      <td class="name-cell">${r.campaign_name || '—'}</td>
      <td>${fmt(r.spend)}</td>
      <td>${fmt(r.leads)}</td>
      <td>${fmt(r.cpl)}</td>
      <td>${fmt(r.sales)}</td>
      <td>${fmt(r.revenue)}</td>
      <td class="${(r.roas || 0) >= 1 ? 'roas-good' : 'roas-bad'}">${fmtRoas(r.roas)}</td>
    </tr>
  `).join('');
}

function renderRecommendations(recs) {
  if (!recs || recs.length === 0) {
    document.getElementById('recommendations').innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px">Пока нет данных для рекомендаций.</p>';
    return;
  }

  document.getElementById('recommendations').innerHTML = recs.map(r => {
    const top = r.items[0];
    return `
      <div class="rec-item rec-item--${top.level}">
        <div class="rec-item__ad">${r.ad_name || r.ad_id}</div>
        <div class="rec-item__campaign">${r.campaign_name || ''}</div>
        ${r.items.map(i => `<p class="rec-item__msg">${i.message}</p>`).join('')}
      </div>
    `;
  }).join('');
}

function renderChart(rows) {
  // Агрегируем по кампании для читаемого графика
  const byCampaign = {};
  rows.forEach(r => {
    const key = r.campaign_name || 'Без названия';
    if (!byCampaign[key]) byCampaign[key] = { spend: 0, revenue: 0 };
    byCampaign[key].spend += r.spend;
    byCampaign[key].revenue += r.revenue;
  });

  const labels = Object.keys(byCampaign);
  const spendData = labels.map(l => byCampaign[l].spend);
  const revenueData = labels.map(l => byCampaign[l].revenue);

  const ctx = document.getElementById('spendRevenueChart');
  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Расход', data: spendData, backgroundColor: '#6C8CFF' },
        { label: 'Выручка', data: revenueData, backgroundColor: '#3FBF8F' },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#8B94A7' } } },
      scales: {
        x: { ticks: { color: '#8B94A7' }, grid: { color: '#2A3140' } },
        y: { ticks: { color: '#8B94A7' }, grid: { color: '#2A3140' } },
      },
    },
  });
}

document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  const { since, until } = getSelectedRange();
  btn.disabled = true;
  btn.textContent = 'Синхронизация…';
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since, until }),
    });
    const result = await res.json();
    if (!result.ok) throw new Error(result.error);
    await loadDashboard();
  } catch (err) {
    alert('Ошибка синхронизации: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Обновить данные';
  }
});

document.getElementById('applyDateBtn').addEventListener('click', () => {
  loadDashboard();
});

document.getElementById('sortSelect').addEventListener('change', () => {
  if (currentReport) renderTable(currentReport.rows);
});

initDefaultDates();
loadDashboard();
