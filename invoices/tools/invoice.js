const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getBillInvoiceData } = require('./billing');
const { getShopSettings } = require('./preferences');

// =============================================
// SHOP CONFIGURATION
//
// Priority: persistent DB setting (tools/preferences.js) >
// environment variable > hardcoded default. A value set via
// "Set shop name to X" is stored in shop_settings and always
// takes priority, so it is applied automatically to every
// future invoice/report without asking again — even after a
// bot restart or a brand-new chat session. Env vars remain
// as a fallback for anyone who configured them the old way
// and never sent a "set shop ..." message.
// =============================================

function getShopConfig() {
  const stored = getShopSettings();

  return {
    name: (stored.name && stored.name.trim()) || process.env.SHOP_NAME || 'Your Supermarket',
    address: (stored.address && stored.address.trim()) || process.env.SHOP_ADDRESS || '',
    phone: (stored.phone && stored.phone.trim()) || process.env.SHOP_PHONE || '',
    gstin: (stored.gstin && stored.gstin.trim()) || process.env.SHOP_GSTIN || ''
  };
}

const INVOICE_DIR = path.join(__dirname, '..', 'invoices');

function ensureInvoiceDir() {
  if (!fs.existsSync(INVOICE_DIR)) {
    fs.mkdirSync(INVOICE_DIR, { recursive: true });
  }
}

function invoicePathForBill(billId) {
  ensureInvoiceDir();
  return path.join(INVOICE_DIR, `invoice-bill-${billId}.pdf`);
}

function formatMoney(n) {
  return `Rs.${Number(n).toFixed(2)}`;
}

function formatDateTime(isoOrSqlString) {
  // bills.created_at is stored as SQLite CURRENT_TIMESTAMP,
  // e.g. "2026-09-06 10:22:31" (UTC, space-separated).
  // Normalize to something Date() can parse reliably.
  if (!isoOrSqlString) return new Date().toLocaleString('en-IN');
  const normalized = isoOrSqlString.includes('T')
    ? isoOrSqlString
    : isoOrSqlString.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return isoOrSqlString;
  return d.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

// =============================================
// TABLE COLUMN LAYOUT
//
// Fixed-width columns summing to the usable page width
// (A4, 40pt margins -> 595.28 - 80 = ~515pt usable).
// =============================================

const COLUMNS = [
  { key: 'name', label: 'Item', width: 108, align: 'left' },
  { key: 'hsn', label: 'HSN', width: 48, align: 'center' },
  { key: 'qty', label: 'Qty', width: 32, align: 'center' },
  { key: 'price', label: 'Unit Price', width: 58, align: 'right' },
  { key: 'taxable_amount', label: 'Taxable', width: 62, align: 'right' },
  { key: 'gst_rate', label: 'GST%', width: 34, align: 'center' },
  { key: 'cgst', label: 'CGST', width: 55, align: 'right' },
  { key: 'sgst', label: 'SGST', width: 55, align: 'right' },
  { key: 'line_total', label: 'Total', width: 63, align: 'right' }
];

const TABLE_LEFT = 40;
const PAGE_BOTTOM = 760;

function drawTableRow(doc, y, values, opts = {}) {
  let x = TABLE_LEFT;
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.fontSize || 8);
  for (let i = 0; i < COLUMNS.length; i++) {
    const col = COLUMNS[i];
    doc.text(String(values[i] != null ? values[i] : ''), x, y, {
      width: col.width,
      align: col.align
    });
    x += col.width;
  }
}

function drawTableHeader(doc, y) {
  drawTableRow(doc, y, COLUMNS.map(c => c.label), { bold: true, fontSize: 8 });
  doc
    .moveTo(TABLE_LEFT, y + 14)
    .lineTo(TABLE_LEFT + COLUMNS.reduce((s, c) => s + c.width, 0), y + 14)
    .strokeColor('#333333')
    .lineWidth(0.75)
    .stroke();
  return y + 20;
}

// =============================================
// RENDER THE PDF
//
// `data` is the shape returned by getBillInvoiceData():
// items[], subtotal, cgst, sgst, gst, grand_total,
// payment_mode, customer, created_at, bill_id.
// =============================================

function renderInvoicePdf(data, outPath) {
  const shop = getShopConfig();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(outPath);

    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
    doc.on('error', reject);

    doc.pipe(stream);

    // ---------- Header ----------
    doc.font('Helvetica-Bold').fontSize(18).text(shop.name, { align: 'center' });

    if (shop.address) {
      doc.font('Helvetica').fontSize(9).text(shop.address, { align: 'center' });
    }

    const contactBits = [];
    if (shop.phone) contactBits.push(`Phone: ${shop.phone}`);
    if (shop.gstin) contactBits.push(`GSTIN: ${shop.gstin}`);
    if (contactBits.length) {
      doc.font('Helvetica').fontSize(9).text(contactBits.join('    '), { align: 'center' });
    }

    doc.moveDown(0.5);
    doc
      .moveTo(40, doc.y)
      .lineTo(555, doc.y)
      .strokeColor('#999999')
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(13).text('TAX INVOICE', { align: 'center' });
    doc.moveDown(0.75);

    // ---------- Bill meta ----------
    doc.font('Helvetica').fontSize(10);

    const metaTop = doc.y;
    doc.text(`Invoice / Bill No: ${data.bill_id}`, 40, metaTop);
    doc.text(`Date & Time: ${formatDateTime(data.created_at)}`, 40, metaTop + 14);
    doc.text(
      `Payment Type: ${data.payment_mode === 'credit' ? 'Credit' : 'Cash'}`,
      40,
      metaTop + 28
    );

    if (data.payment_mode === 'credit') {
      doc.text(`Customer: ${data.customer || 'N/A'}`, 320, metaTop);
    }

    doc.y = metaTop + 48;
    doc.moveDown(0.5);

    // ---------- Table ----------
    let y = drawTableHeader(doc, doc.y);

    for (const item of data.items) {
      if (y > PAGE_BOTTOM) {
        doc.addPage();
        y = 40;
        y = drawTableHeader(doc, y);
      }

      const lineTotal = Number(item.amount).toFixed(2);

      drawTableRow(doc, y, [
        item.name,
        item.hsn || '-',
        item.qty,
        formatMoney(item.price),
        formatMoney(item.taxable_amount),
        `${item.gst_rate}%`,
        formatMoney(item.cgst),
        formatMoney(item.sgst),
        formatMoney(lineTotal)
      ]);

      y += 18;
    }

    doc
      .moveTo(TABLE_LEFT, y)
      .lineTo(TABLE_LEFT + COLUMNS.reduce((s, c) => s + c.width, 0), y)
      .strokeColor('#333333')
      .lineWidth(0.75)
      .stroke();

    y += 14;

    if (y > PAGE_BOTTOM - 100) {
      doc.addPage();
      y = 40;
    }

    // ---------- Totals ----------
    const totalsX = 360;
    const totalsLabelWidth = 110;
    const totalsValueWidth = 85;

    function totalsRow(label, value, opts = {}) {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.bold ? 11 : 10);
      doc.text(label, totalsX, y, { width: totalsLabelWidth, align: 'left' });
      doc.text(value, totalsX + totalsLabelWidth, y, {
        width: totalsValueWidth,
        align: 'right'
      });
      y += opts.bold ? 18 : 15;
    }

    totalsRow('Subtotal (Taxable):', formatMoney(data.subtotal));
    totalsRow('Total CGST:', formatMoney(data.cgst));
    totalsRow('Total SGST:', formatMoney(data.sgst));
    totalsRow('Total GST:', formatMoney(data.gst));

    doc
      .moveTo(totalsX, y)
      .lineTo(totalsX + totalsLabelWidth + totalsValueWidth, y)
      .strokeColor('#999999')
      .lineWidth(0.75)
      .stroke();
    y += 6;

    totalsRow('Grand Total:', formatMoney(data.grand_total), { bold: true });

    // ---------- Footer ----------
    doc.font('Helvetica-Oblique').fontSize(8).text(
      'This is a computer-generated invoice.',
      40,
      780,
      { align: 'center', width: 515 }
    );

    doc.end();
  });
}

// =============================================
// GET-OR-CREATE INVOICE PDF (idempotent)
//
// - If a PDF already exists on disk for this bill, it is
//   returned as-is — the file is never regenerated from a
//   retried/duplicate request, so a retry can only ever
//   RESEND the same file, never re-run any financial math.
// - Otherwise it is built fresh from getBillInvoiceData(),
//   which reads only from the already-committed, finalized
//   bill in the database.
// =============================================

async function getOrCreateInvoicePdf(billId) {
  const outPath = invoicePathForBill(billId);

  if (fs.existsSync(outPath)) {
    return outPath;
  }

  const data = getBillInvoiceData(billId);

  if (data.error) {
    throw new Error(data.error);
  }

  return renderInvoicePdf(data, outPath);
}

module.exports = {
  getOrCreateInvoicePdf,
  invoicePathForBill,
  getShopConfig
};
