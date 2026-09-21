const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
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
  date TEXT,
  manager TEXT,
  synced_at TEXT
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

// Миграция для БД, которые уже существуют на диске (Render) со старой схемой —
// CREATE TABLE IF NOT EXISTS не добавляет новые колонки в уже существующую таблицу.
try {
  db.exec(`ALTER TABLE general_sales ADD COLUMN is_from_ads INTEGER DEFAULT 0`);
} catch (e) {
  // колонка уже есть — это нормально, ничего не делаем
}
try {
  db.exec(`ALTER TABLE amo_leads ADD COLUMN qualified_at INTEGER`);
} catch (e) {
  // колонка уже есть — это нормально, ничего не делаем
}
try {
  db.exec(`ALTER TABLE amo_leads ADD COLUMN fb_campaign_name TEXT`);
  db.exec(`ALTER TABLE amo_leads ADD COLUMN fb_adset_name TEXT`);
  db.exec(`ALTER TABLE amo_leads ADD COLUMN fb_ad_name TEXT`);
} catch (e) {
  // колонки уже есть — это нормально, ничего не делаем
}

function upsertFbInsights(rows) {
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

function upsertAmoLeads(leads) {
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

function upsertGeneralSales(rows) {
  const stmt = db.prepare(`
    INSERT INTO general_sales (id, name, amount, klass, segment, payment_type, is_new, is_from_ads, date, manager, synced_at)
    VALUES (@id, @name, @amount, @klass, @segment, @payment_type, @is_new, @is_from_ads, @date, @manager, @synced_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, amount=excluded.amount, klass=excluded.klass, segment=excluded.segment,
      payment_type=excluded.payment_type, is_new=excluded.is_new, is_from_ads=excluded.is_from_ads, date=excluded.date,
      manager=excluded.manager, synced_at=excluded.synced_at
  `);
  const insertMany = db.transaction((items) => { for (const item of items) stmt.run({ is_from_ads: 0, ...item }); });
  insertMany(rows);
}

function logSync({ since, until, fbRows, amoRows, sheetRows, status, error }) {
  db.prepare(`INSERT INTO sync_log (ran_at, since, until, fb_rows, amo_rows, sheet_rows, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), since || null, until || null, fbRows || 0, amoRows || 0, sheetRows || 0, status, error || null);
}

function getFbInsightsInRange(since, until) {
  return db.prepare(`
    SELECT ad_id, MAX(ad_name) as ad_name, MAX(adset_id) as adset_id, MAX(adset_name) as adset_name,
           MAX(campaign_id) as campaign_id, MAX(campaign_name) as campaign_name, MAX(segment) as segment,
           SUM(spend) as spend, SUM(impressions) as impressions, SUM(reach) as reach,
           SUM(clicks) as clicks, SUM(fb_leads) as fb_leads
    FROM fb_insights WHERE date BETWEEN ? AND ? GROUP BY ad_id
  `).all(since, until);
}

function getAmoLeadsInRange(since, until) {
  const sinceTs = Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000);
  const untilTs = Math.floor(new Date(until + 'T23:59:59Z').getTime() / 1000);
  // Берём сделки, СОЗДАННЫЕ в периоде (для метрики "лиды"), ИЛИ КВАЛИФИЦИРОВАННЫЕ в периоде
  // (для метрики "квалы" — важно даже если сделка была создана раньше периода).
  // Точная фильтрация "что именно считать" происходит дальше в buildSegmentReport по каждой дате отдельно.
  return db.prepare(`
    SELECT * FROM amo_leads
    WHERE (created_at BETWEEN ? AND ?) OR (qualified_at BETWEEN ? AND ?)
  `).all(sinceTs, untilTs, sinceTs, untilTs);
}

function getGeneralSalesInRange(since, until) {
  return db.prepare(`SELECT * FROM general_sales WHERE date BETWEEN ? AND ?`).all(since, until);
}

function getLastSync() {
  return db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
}

module.exports = {
  upsertFbInsights, upsertAmoLeads, upsertGeneralSales, logSync,
  getFbInsightsInRange, getAmoLeadsInRange, getGeneralSalesInRange, getLastSync,
};
