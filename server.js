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
    res.json(meta);
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
