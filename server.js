require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const { runSync, buildJoinedReport } = require('./src/sync');
const { fetchAmoMeta } = require('./src/amoClient');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function defaultRange() {
  const today = new Date();
  const monthAgo = new Date();
  monthAgo.setDate(today.getDate() - 30);
  return { since: monthAgo.toISOString().slice(0, 10), until: today.toISOString().slice(0, 10) };
}

// Основной эндпоинт — данные для дэшборда за период (?since=2026-09-01&until=2026-09-09)
app.get('/api/dashboard', (req, res) => {
  try {
    const def = defaultRange();
    const since = req.query.since || def.since;
    const until = req.query.until || def.until;
    const report = buildJoinedReport(since, until);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Запустить синхронизацию вручную за период (например, при смене даты в интерфейсе)
app.post('/api/sync', async (req, res) => {
  try {
    const since = req.body.since;
    const until = req.body.until;
    const result = await runSync(since, until);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Вспомогательное: узнать ID полей/воронок amoCRM для настройки .env
app.get('/api/amo-meta', async (req, res) => {
  try {
    const meta = await fetchAmoMeta();
    if (req.query.format === 'json') return res.json(meta);

    // По умолчанию — простая читаемая HTML-страница: список полей и воронок с их ID.
    // Открой в браузере и используй Cmd+F (поиск на странице), чтобы быстро найти нужное поле.
    const fieldsRows = meta.fieldsList.map((f) =>
      `<tr><td>${f.id}</td><td>${f.name}</td><td>${f.code || ''}</td></tr>`
    ).join('');
    const pipelinesHtml = meta.pipelinesList.map((p) => `
      <h3>Воронка: ${p.name} (pipeline_id = ${p.id})</h3>
      <table border="1" cellpadding="6" style="border-collapse:collapse">
        <tr><th>ID статуса</th><th>Название этапа</th><th>Порядок (sort)</th></tr>
        ${p.statuses.map((s) => `<tr><td>${s.id}</td><td>${s.name}</td><td>${s.sort}</td></tr>`).join('')}
      </table>`
    ).join('<br>');

    res.send(`
      <html><head><meta charset="utf-8"><title>amoCRM: поля и воронки</title></head>
      <body style="font-family: sans-serif; padding: 20px;">
        <p>Ссылка на JSON-версию: <a href="/api/amo-meta?format=json">/api/amo-meta?format=json</a></p>
        <h2>Кастомные поля сделок (ID для настроек AMO_FIELD_...)</h2>
        <table border="1" cellpadding="6" style="border-collapse:collapse">
          <tr><th>ID поля</th><th>Название</th><th>Код</th></tr>
          ${fieldsRows}
        </table>
        <h2>Воронки и этапы (ID для AMO_PIPELINE_ID / AMO_STATUS_...)</h2>
        ${pipelinesHtml}
      </body></html>
    `);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервис запущен: http://localhost:${PORT}`);

  if (process.env.RUN_CRON === 'true') {
    const schedule = process.env.CRON_SCHEDULE || '0 6 * * *';
    cron.schedule(schedule, () => {
      console.log('[cron] Запуск плановой синхронизации');
      runSync().catch(() => {});
    });
    console.log(`[cron] Автосинхронизация включена: "${schedule}"`);
  }
});
