const db = require('../db');

// =============================================
// SALES REPORT
//
// Uses only existing tables (bills, bill_items) —
// no schema changes needed. Only 'completed' bills
// are ever counted: pending and cancelled bills are
// excluded by the WHERE clause below.
//
// NOTE ON "TODAY": bills.created_at is set once, when
// the bill is STARTED (start_bill), not when it is
// finalized. There is no separate "finalized_at"
// column in the existing schema, so "today's sales"
// is matched against created_at — the same timestamp
// the rest of the project already relies on. This
// also means the report is stored/compared using the
// server's date (SQLite's date() function operates on
// the stored UTC timestamp), consistent with how
// created_at is already populated everywhere else.
//
// CGST/SGST: finalizeBill() always splits GST exactly
// 50/50 into CGST and SGST (see tools/billing.js), so
// they are derived here as half of the stored tax
// total rather than re-deriving them from bill_items —
// this matches the existing calculation exactly and
// avoids a second GST computation path.
// =============================================

function isValidDateString(str) {
  if (typeof str !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayDateString() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// =============================================
// RESOLVE the target date string (YYYY-MM-DD) from
// tool arguments. Accepts either:
//   - date: an explicit "YYYY-MM-DD" string, or
//   - period: "today" (default) or "yesterday"
// =============================================

function resolveReportDate(args = {}) {

  if (args.date) {
    if (!isValidDateString(args.date)) {
      return { error: 'date must be a valid calendar date in YYYY-MM-DD format.' };
    }
    return { dateStr: args.date };
  }

  const period = (args.period || 'today').toLowerCase();

  if (period === 'yesterday') {
    return { dateStr: yesterdayDateString() };
  }

  if (period === 'today') {
    return { dateStr: todayDateString() };
  }

  return { error: `Unknown period "${args.period}". Use "today", "yesterday", or provide an explicit date.` };
}

// =============================================
// GET SALES REPORT
//
// dateStr must be "YYYY-MM-DD". Returns the full
// daily sales report for that date, counting ONLY
// bills with status = 'completed'.
// =============================================

function getSalesReportForDate(dateStr) {

  const bills = db.prepare(`
    SELECT id, payment_mode, total, tax
    FROM bills
    WHERE status = 'completed'
    AND date(created_at) = date(?)
  `).all(dateStr);

  const totalBills = bills.length;

  let totalSales = 0;
  let cashSales = 0;
  let creditSales = 0;
  let totalGst = 0;

  for (const bill of bills) {
    const billTotal = bill.total || 0;
    const billTax = bill.tax || 0;

    totalSales += billTotal;
    totalGst += billTax;

    if (bill.payment_mode === 'credit') {
      creditSales += billTotal;
    } else {
      cashSales += billTotal;
    }
  }

  let totalItemsSold = 0;

  if (totalBills > 0) {
    const billIds = bills.map(b => b.id);
    const placeholders = billIds.map(() => '?').join(',');

    const itemRow = db.prepare(`
      SELECT COALESCE(SUM(qty), 0) AS total_qty
      FROM bill_items
      WHERE bill_id IN (${placeholders})
    `).get(...billIds);

    totalItemsSold = itemRow.total_qty || 0;
  }

  totalSales = Number(totalSales.toFixed(2));
  cashSales = Number(cashSales.toFixed(2));
  creditSales = Number(creditSales.toFixed(2));
  totalGst = Number(totalGst.toFixed(2));

  const totalCgst = Number((totalGst / 2).toFixed(2));
  const totalSgst = Number((totalGst / 2).toFixed(2));

  return {
    date: dateStr,
    total_bills: totalBills,
    total_sales: totalSales,
    cash_sales: cashSales,
    credit_sales: creditSales,
    total_gst: totalGst,
    total_cgst: totalCgst,
    total_sgst: totalSgst,
    total_items_sold: totalItemsSold
  };
}

// =============================================
// PUBLIC ENTRY POINT (used by the Gemini tool)
//
// Accepts raw tool arguments, resolves the date,
// then returns the report.
// =============================================

function getSalesReport(args = {}) {

  const resolved = resolveReportDate(args);

  if (resolved.error) {
    return { error: resolved.error };
  }

  return getSalesReportForDate(resolved.dateStr);
}

module.exports = {
  getSalesReport,
  getSalesReportForDate,
  resolveReportDate
};