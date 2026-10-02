const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Обычный файл SQLite на диске сервера — сервер постоянный (не Render), диск не сбрасывается,
// поэтому внешняя база (Postgres/Supabase) больше не нужна. Путь настраивается через DB_PATH,
// по умолчанию — data/ads.db внутри проекта (эту папку нужно добавить в .gitignore).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ads.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS fb_insights (
  ad_id TEXT,
  date TEXT,
  ad_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  segment TEXT,
  spend REAL DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc REAL DEFAULT 0,
  fb_leads INTEGER DEFAULT 0,
  fb_cpl REAL,
  synced_at TEXT,
  PRIMARY KEY (ad_id, date)
);

CREATE TABLE IF NOT EXISTS amo_leads (
  id INTEGER PRIMARY KEY,
  name TEXT,
  price REAL DEFAULT 0,
  status_id INTEGER,
  created_at INTEGER,
  closed_at INTEGER,
  campaign_id TEXT,
  adset_id TEXT,
  ad_id TEXT,
  fb_campaign_name TEXT,
  fb_adset_name TEXT,
  fb_ad_name TEXT,
  klass TEXT,
  segment TEXT,
  department TEXT,
  tags TEXT,
  is_qualified INTEGER DEFAULT 0,
  is_success INTEGER DEFAULT 0,
  is_full_payment INTEGER DEFAULT 0,
  qualified_at INTEGER,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS general_sales (
  id TEXT PRIMARY KEY,
  name TEXT,
  amount REAL DEFAULT 0,
  klass TEXT,
  segment TEXT,
  payment_type TEXT,
  is_new INTEGER DEFAULT 0,
  is_from_ads INTEGER DEFAULT 0,
  ad_name TEXT,
  date TEXT,
  manager TEXT,
  synced_at TEXT
);

-- Сделки, дошедшие до успешной оплаты, по дате ЗАКЛЮЧЕНИЯ ДОГОВОРА — источник для "Общих
-- продаж" и блока "С рекламы" (см. fetchAmoSalesByContractDate в amoClient.js).
CREATE TABLE IF NOT EXISTS amo_sales (
  id INTEGER PRIMARY KEY,
  price REAL DEFAULT 0,
  klass TEXT,
  segment TEXT,
  tags TEXT,
  fb_ad_name TEXT,
  contract_date INTEGER,
  synced_at TEXT
);

-- Сделки, которые хоть раз доходили до этапа квалификации или дальше (из истории amoCRM).
CREATE TABLE IF NOT EXISTS amo_reached_qual (
  id INTEGER PRIMARY KEY
);

-- Закрытые сделки (Закрыто и не реализовано): с какого этапа их закрыли.
CREATE TABLE IF NOT EXISTS amo_lost_from (
  id INTEGER PRIMARY KEY,
  status_id INTEGER
);

-- Простые настройки/справочники (например, этапы воронки).
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT,
  since TEXT,
  until TEXT,
  fb_rows INTEGER,
  amo_rows INTEGER,
  sheet_rows INTEGER,
  status TEXT,
  error TEXT
);
`);

// upsertAmoLeads и upsertGeneralSales создавались раньше — миграция на случай, если база уже
// существует с более старой версией схемы (CREATE TABLE IF NOT EXISTS не добавляет колонки
// в уже существующую таблицу).
const migrations = [
  `ALTER TABLE amo_leads ADD COLUMN qualified_at INTEGER`,
  `ALTER TABLE amo_leads ADD COLUMN fb_campaign_name TEXT`,
  `ALTER TABLE amo_leads ADD COLUMN fb_adset_name TEXT`,
  `ALTER TABLE amo_leads ADD COLUMN fb_ad_name TEXT`,
  `ALTER TABLE general_sales ADD COLUMN is_from_ads INTEGER DEFAULT 0`,
  `ALTER TABLE general_sales ADD COLUMN ad_name TEXT`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* колонка уже есть — нормально */ }
}

// Функции ниже объявлены как async, хотя better-sqlite3 работает синхронно — это специально,
// чтобы не переписывать вызовы в sync.js/server.js (там уже стоит await из времён Postgres),
// а async-функция с синхронным телом работает точно так же, просто оборачивает результат в Promise.

async function upsertFbInsights(rows) {
  if (!rows || rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO fb_insights (ad_id, date, ad_name, adset_id, adset_name, campaign_id, campaign_name, segment,
      spend, impressions, reach, clicks, ctr, cpc, fb_leads, fb_cpl, synced_at)
    VALUES (@ad_id, @date, @ad_name, @adset_id, @adset_name, @campaign_id, @campaign_name, @segment,
      @spend, @impressions, @reach, @clicks, @ctr, @cpc, @fb_leads, @fb_cpl, @synced_at)
    ON CONFLICT(ad_id, date) DO UPDATE SET
      ad_name=excluded.ad_name, adset_id=excluded.adset_id, adset_name=excluded.adset_name,
      campaign_id=excluded.campaign_id, campaign_name=excluded.campaign_name, segment=excluded.segment,
      spend=excluded.spend, impressions=excluded.impressions, reach=excluded.reach,
      clicks=excluded.clicks, ctr=excluded.ctr, cpc=excluded.cpc,
      fb_leads=excluded.fb_leads, fb_cpl=excluded.fb_cpl, synced_at=excluded.synced_at
  `);
  const insertMany = db.transaction((items) => { for (const item of items) stmt.run(item); });
  insertMany(rows);
}

async function upsertAmoLeads(leads) {
  if (!leads || leads.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO amo_leads (id, name, price, status_id, created_at, closed_at, campaign_id, adset_id, ad_id,
      fb_campaign_name, fb_adset_name, fb_ad_name,
      klass, segment, department, tags, is_qualified, is_success, is_full_payment, qualified_at, synced_at)
    VALUES (@id, @name, @price, @status_id, @created_at, @closed_at, @campaign_id, @adset_id, @ad_id,
      @fb_campaign_name, @fb_adset_name, @fb_ad_name,
      @klass, @segment, @department, @tags, @is_qualified, @is_success, @is_full_payment, @qualified_at, @synced_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, price=excluded.price, status_id=excluded.status_id,
      created_at=excluded.created_at, closed_at=excluded.closed_at,
      campaign_id=excluded.campaign_id, adset_id=excluded.adset_id, ad_id=excluded.ad_id,
      fb_campaign_name=excluded.fb_campaign_name, fb_adset_name=excluded.fb_adset_name, fb_ad_name=excluded.fb_ad_name,
      klass=excluded.klass, segment=excluded.segment, department=excluded.department, tags=excluded.tags,
      is_qualified=excluded.is_qualified, is_success=excluded.is_success, is_full_payment=excluded.is_full_payment,
      qualified_at=excluded.qualified_at, synced_at=excluded.synced_at
  `);
  const insertMany = db.transaction((items) => {
    for (const item of items) stmt.run({ qualified_at: null, fb_campaign_name: null, fb_adset_name: null, fb_ad_name: null, ...item });
  });
  insertMany(leads);
}

async function upsertGeneralSales(rows) {
  if (!rows || rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO general_sales (id, name, amount, klass, segment, payment_type, is_new, is_from_ads, ad_name, date, manager, synced_at)
    VALUES (@id, @name, @amount, @klass, @segment, @payment_type, @is_new, @is_from_ads, @ad_name, @date, @manager, @synced_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, amount=excluded.amount, klass=excluded.klass, segment=excluded.segment,
      payment_type=excluded.payment_type, is_new=excluded.is_new, is_from_ads=excluded.is_from_ads,
      ad_name=excluded.ad_name, date=excluded.date, manager=excluded.manager, synced_at=excluded.synced_at
  `);
  const insertMany = db.transaction((items) => { for (const item of items) stmt.run({ is_from_ads: 0, ad_name: null, ...item }); });
  insertMany(rows);
}

async function upsertAmoSales(rows) {
  if (!rows || rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO amo_sales (id, price, klass, segment, tags, fb_ad_name, contract_date, synced_at)
    VALUES (@id, @price, @klass, @segment, @tags, @fb_ad_name, @contract_date, @synced_at)
    ON CONFLICT(id) DO UPDATE SET
      price=excluded.price, klass=excluded.klass, segment=excluded.segment, tags=excluded.tags,
      fb_ad_name=excluded.fb_ad_name, contract_date=excluded.contract_date, synced_at=excluded.synced_at
  `);
  const insertMany = db.transaction((items) => { for (const item of items) stmt.run(item); });
  insertMany(rows);
}

// Удаляет из базы сделки, которые больше не относятся к отделу Online
// (например, клиент оставил заявку онлайн, а потом его перевели в офлайн).
function deleteByIds(table, ids) {
  if (!ids || ids.length === 0) return 0;
  const stmt = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  let removed = 0;
  db.transaction((list) => { for (const id of list) removed += stmt.run(id).changes; })(ids);
  return removed;
}
async function deleteAmoLeadsByIds(ids) { return deleteByIds('amo_leads', ids); }
async function deleteAmoSalesByIds(ids) { return deleteByIds('amo_sales', ids); }

async function addReachedQual(ids) {
  if (!ids || ids.length === 0) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO amo_reached_qual (id) VALUES (?)');
  db.transaction((list) => { for (const id of list) stmt.run(id); })(ids);
}
async function getReachedQualSet() {
  return new Set(db.prepare('SELECT id FROM amo_reached_qual').all().map((r) => r.id));
}
async function saveLostFrom(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return;
  const stmt = db.prepare('INSERT INTO amo_lost_from (id, status_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET status_id = excluded.status_id');
  db.transaction((list) => { for (const [id, st] of list) stmt.run(Number(id), st); })(entries);
}
async function getLostFromMap() {
  const m = new Map();
  for (const r of db.prepare('SELECT id, status_id FROM amo_lost_from').all()) m.set(r.id, r.status_id);
  return m;
}
async function getMinLeadCreatedAt() {
  const r = db.prepare('SELECT MIN(created_at) AS m FROM amo_leads').get();
  return r ? r.m : null;
}
async function setKv(k, value) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(value));
}
async function getKv(k) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return row ? JSON.parse(row.v) : null;
}
// Сделки, СОЗДАННЫЕ в периоде (границы — unix-время, уже с учётом часового пояса Алматы).
async function getAmoLeadsCreatedInRange(sinceTs, untilTs) {
  return db.prepare('SELECT * FROM amo_leads WHERE created_at BETWEEN ? AND ?').all(sinceTs, untilTs);
}

async function logSync({ since, until, fbRows, amoRows, sheetRows, status, error }) {
  db.prepare(`
    INSERT INTO sync_log (ran_at, since, until, fb_rows, amo_rows, sheet_rows, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), since || null, until || null, fbRows || 0, amoRows || 0, sheetRows || 0, status, error || null);
}

async function getFbInsightsInRange(since, until) {
  return db.prepare(`
    SELECT ad_id, MAX(ad_name) as ad_name, MAX(adset_id) as adset_id, MAX(adset_name) as adset_name,
           MAX(campaign_id) as campaign_id, MAX(campaign_name) as campaign_name, MAX(segment) as segment,
           SUM(spend) as spend, SUM(impressions) as impressions, SUM(reach) as reach,
           SUM(clicks) as clicks, SUM(fb_leads) as fb_leads
    FROM fb_insights WHERE date BETWEEN ? AND ? GROUP BY ad_id
  `).all(since, until);
}

async function getAmoLeadsInRange(since, until) {
  const sinceTs = Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000);
  const untilTs = Math.floor(new Date(until + 'T23:59:59Z').getTime() / 1000);
  // Берём сделки, СОЗДАННЫЕ в периоде (для метрики "лиды"), ИЛИ КВАЛИФИЦИРОВАННЫЕ в периоде
  // (для метрики "квалы" — важно даже если сделка была создана раньше периода).
  return db.prepare(`
    SELECT * FROM amo_leads
    WHERE (created_at BETWEEN ? AND ?) OR (qualified_at BETWEEN ? AND ?)
  `).all(sinceTs, untilTs, sinceTs, untilTs);
}

async function getGeneralSalesInRange(since, until) {
  return db.prepare(`SELECT * FROM general_sales WHERE date BETWEEN ? AND ?`).all(since, until);
}

async function getAmoSalesInRange(sinceTs, untilTs) {
  return db.prepare(`SELECT * FROM amo_sales WHERE contract_date BETWEEN ? AND ?`).all(sinceTs, untilTs);
}

// Читает уже сохранённые ранее (при прошлых синках) значения is_from_ads/ad_name по списку ID —
// нужно, чтобы при новом синке не затирать нулями флаги у платежей, которые сейчас вне
// проверяемого периода (их просто не трогаем, оставляем как было).
async function getAdsFlagsByIds(ids) {
  if (!ids || ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, is_from_ads, ad_name FROM general_sales WHERE id IN (${placeholders})`).all(...ids);
  const result = {};
  for (const r of rows) result[String(r.id)] = { is_from_ads: r.is_from_ads, ad_name: r.ad_name };
  return result;
}

async function getLastSync() {
  return db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get() || null;
}

module.exports = {
  upsertFbInsights, upsertAmoLeads, upsertGeneralSales, upsertAmoSales, logSync,
  deleteAmoLeadsByIds, deleteAmoSalesByIds,
  addReachedQual, getReachedQualSet, setKv, getKv, getAmoLeadsCreatedInRange,
  saveLostFrom, getLostFromMap, getMinLeadCreatedAt,
  getFbInsightsInRange, getAmoLeadsInRange, getGeneralSalesInRange, getAmoSalesInRange, getAdsFlagsByIds, getLastSync,
};
