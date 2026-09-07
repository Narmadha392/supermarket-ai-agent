const Database = require('better-sqlite3');
const db = new Database('shop.db');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT,
  unit TEXT,
  cost REAL,
  mrp REAL,
  gst_slab REAL,
  hsn TEXT,
  stock REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT,
  payment_mode TEXT,
  total REAL,
  tax REAL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bill_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER,
  sku TEXT,
  qty REAL,
  price REAL
);

CREATE TABLE IF NOT EXISTS khata (
  customer TEXT PRIMARY KEY,
  balance REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS khata_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'payment')),
  amount REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS stock_receipts (
  idempotency_key TEXT PRIMARY KEY,
  sku TEXT,
  qty REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PERSISTENT MEMORY (survives restarts / new sessions)
--
-- user_preferences: standing preferences the AI should
-- keep applying automatically for a given Telegram chat,
-- e.g. a default payment mode. Scoped per chat_id so one
-- shop owner's preference never leaks into another chat.
--
-- shop_settings: shop-wide identity fields (name, address,
-- phone, GSTIN) used automatically by GST PDF invoices and
-- the business-analysis PPTX report. Not chat-scoped — a
-- shop has one identity regardless of who is chatting.
-- =====================================================

CREATE TABLE IF NOT EXISTS user_preferences (
  chat_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, key)
);

CREATE TABLE IF NOT EXISTS shop_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// =====================================================
// SAFE MIGRATIONS
//
// SQLite has no "ADD COLUMN IF NOT EXISTS", so we check
// PRAGMA table_info first. This is safe to run every time
// the app starts, and safe against an existing shop.db
// that predates the credit-bill feature — existing rows
// simply get NULL for the new columns.
// =====================================================

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

if (!columnExists('bills', 'customer_id')) {
  db.exec(`ALTER TABLE bills ADD COLUMN customer_id INTEGER REFERENCES customers(id)`);
  console.log('Migration applied: bills.customer_id added.');
}

if (!columnExists('khata_transactions', 'bill_id')) {
  db.exec(`ALTER TABLE khata_transactions ADD COLUMN bill_id INTEGER REFERENCES bills(id)`);
  console.log('Migration applied: khata_transactions.bill_id added.');
}

// Needed so a "cancel the bill" request (no explicit bill ID) can be
// resolved to the correct pending bill for the Telegram chat that
// asked, instead of guessing across all shop bills.
if (!columnExists('bills', 'chat_id')) {
  db.exec(`ALTER TABLE bills ADD COLUMN chat_id TEXT`);
  console.log('Migration applied: bills.chat_id added.');
}

if (!columnExists('khata_transactions', 'idempotency_key')) {
  db.exec(`ALTER TABLE khata_transactions ADD COLUMN idempotency_key TEXT`);
  console.log('Migration applied: khata_transactions.idempotency_key added.');
}

// Belt-and-suspenders DB-level guarantee: a given bill can
// never receive more than one 'credit' khata transaction,
// even if application logic somehow tries to.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_credit_per_bill
  ON khata_transactions(bill_id, type)
  WHERE type = 'credit' AND bill_id IS NOT NULL;
`);

// Belt-and-suspenders DB-level guarantee: a given manual khata
// credit or payment idempotencyKey can never be applied twice,
// even if the application-layer check below is ever bypassed.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_khata_idempotency
  ON khata_transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`);

const seed = db.prepare(`
  INSERT OR IGNORE INTO products (sku, name, unit, cost, mrp, gst_slab, hsn, stock)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
seed.run('sugar', 'Sugar', 'kg', 40, 45, 5, '1701', 50);
seed.run('maggi', 'Maggi 70g', 'packet', 10, 14, 12, '1902', 30);
seed.run('atta_aashirvaad_5kg', 'Aashirvaad Atta 5kg', 'packet', 220, 250, 0, '1101', 20);
seed.run('amul_butter_100g', 'Amul Butter 100g', 'packet', 50, 62, 12, '0405', 15);

console.log('Database ready: shop.db');

module.exports = db;