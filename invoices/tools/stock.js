const db = require('../db');

function checkStock(sku) {
  const row = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  if (!row) return { error: `No product found with sku "${sku}"` };
  return { sku: row.sku, name: row.name, stock: row.stock, unit: row.unit };
}

function receiveStock(sku, name, qty, cost, mrp, unit = 'packet', gst_slab = 0, hsn = '', idempotencyKey) {

  if (!idempotencyKey) {
    return { error: 'idempotencyKey is required to record a stock delivery.' };
  }

  // If this exact delivery was already recorded (e.g. a retried
  // Telegram update), return the current stock state instead of
  // applying the delta a second time.
  const alreadyReceived = db.prepare(`
    SELECT * FROM stock_receipts WHERE idempotency_key = ?
  `).get(idempotencyKey);

  if (alreadyReceived) {
    return {
      message: 'This stock delivery was already recorded.',
      ...checkStock(alreadyReceived.sku)
    };
  }

  const transaction = db.transaction(() => {

    const existing = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
    if (existing) {
      db.prepare('UPDATE products SET stock = stock + ?, cost = ? WHERE sku = ?')
        .run(qty, cost, sku);
    } else {
      db.prepare(`INSERT INTO products (sku, name, unit, cost, mrp, gst_slab, hsn, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sku, name, unit, cost, mrp, gst_slab, hsn, qty);
    }

    db.prepare(`
      INSERT INTO stock_receipts (idempotency_key, sku, qty)
      VALUES (?, ?, ?)
    `).run(idempotencyKey, sku, qty);

    return checkStock(sku);
  });

  return transaction();
}

// =============================================
// LOW STOCK / OUT OF STOCK REPORTS
//
// DEFAULT_LOW_STOCK_THRESHOLD is exported so finalizeBill()
// in billing.js can use the exact same default when deciding
// whether to attach a low-stock warning to a receipt.
// =============================================

const DEFAULT_LOW_STOCK_THRESHOLD = 10;

function getLowStockReport(threshold) {

  const t = (typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0)
    ? threshold
    : DEFAULT_LOW_STOCK_THRESHOLD;

  const rows = db.prepare(`
    SELECT sku, name, stock, unit
    FROM products
    WHERE stock <= ?
    ORDER BY stock ASC
  `).all(t);

  const items = rows.map(r => ({
    sku: r.sku,
    name: r.name,
    stock: r.stock,
    unit: r.unit,
    level: r.stock <= Math.floor(t / 2) ? 'critical' : 'warning'
  }));

  return {
    threshold: t,
    total_low_stock: items.length,
    items
  };
}

function getOutOfStockReport() {

  const rows = db.prepare(`
    SELECT sku, name, unit
    FROM products
    WHERE stock <= 0
    ORDER BY name ASC
  `).all();

  return {
    total_out_of_stock: rows.length,
    items: rows
  };
}

function addProduct(sku, name, unit, gst_slab, mrp, hsn) {
  db.prepare(`INSERT OR REPLACE INTO products (sku, name, unit, cost, mrp, gst_slab, hsn, stock)
    VALUES (?, ?, ?, 0, ?, ?, ?, 0)`)
    .run(sku, name, unit, mrp, gst_slab, hsn);
  return checkStock(sku);
}

// =============================================
// FIND PRODUCT
// =============================================

function findProduct(productName) {

  const product = db.prepare(`
    SELECT
      sku,
      name,
      stock,
      mrp,
      unit,
      gst_slab
    FROM products
    WHERE LOWER(name) LIKE LOWER(?)
       OR LOWER(sku) LIKE LOWER(?)
    LIMIT 1
  `).get(
    `%${productName}%`,
    `%${productName}%`
  );


  if (!product) {

    return {
      error: `Product not found: ${productName}`
    };

  }


  return product;

}

module.exports = {
  checkStock,
  receiveStock,
  addProduct,
  findProduct,
  getLowStockReport,
  getOutOfStockReport,
  DEFAULT_LOW_STOCK_THRESHOLD
};