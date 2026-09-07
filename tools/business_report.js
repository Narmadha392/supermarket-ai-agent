const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const db = require('../db');
const { getShopConfig } = require('./invoice');
const { getLowStockReport, getOutOfStockReport } = require('./stock');

// =============================================
// OUTPUT LOCATION
// =============================================

const REPORT_DIR = path.join(__dirname, '..', 'reports');

function ensureReportDir() {
  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function reportPathForToday() {
  ensureReportDir();
  return path.join(REPORT_DIR, `business-analysis-${todayDateString()}.pptx`);
}

function money(n) {
  return `Rs.${Number(n || 0).toFixed(2)}`;
}

// =============================================
// DATA GATHERING
//
// Every query below reads directly from the existing
// tables (bills, bill_items, products) and only ever
// counts bills WHERE status = 'completed' — pending or
// cancelled bills are excluded everywhere, matching how
// tools/reports.js already treats "finalized" sales.
// No values are invented: an empty result set simply
// produces zeros / empty lists, which the slide-building
// code below renders as an honest "no data yet" state
// instead of a fabricated chart.
// =============================================

function getOverviewTotals() {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_bills,
      COALESCE(SUM(total), 0) AS total_sales,
      COALESCE(SUM(tax), 0) AS total_gst,
      COALESCE(SUM(CASE WHEN payment_mode = 'credit' THEN total ELSE 0 END), 0) AS credit_sales,
      COALESCE(SUM(CASE WHEN payment_mode != 'credit' THEN total ELSE 0 END), 0) AS cash_sales
    FROM bills
    WHERE status = 'completed'
  `).get();

  return {
    total_bills: row.total_bills,
    total_sales: Number(row.total_sales.toFixed(2)),
    total_gst: Number(row.total_gst.toFixed(2)),
    cash_sales: Number(row.cash_sales.toFixed(2)),
    credit_sales: Number(row.credit_sales.toFixed(2))
  };
}

// Daily sales totals, oldest to newest, capped to the most
// recent 30 days that actually have a completed bill (not
// 30 calendar days — a small shop's real sales history may
// be sparser than that, and padding with fabricated zero
// days is not real data).
function getDailySalesTrend() {
  const rows = db.prepare(`
    SELECT
      date(created_at) AS day,
      SUM(total) AS day_total
    FROM bills
    WHERE status = 'completed'
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all();

  const last30 = rows.slice(-30);

  return last30.map(r => ({
    day: r.day,
    total: Number((r.day_total || 0).toFixed(2))
  }));
}

function getTopProducts(limit = 5) {
  const rows = db.prepare(`
    SELECT
      bill_items.sku,
      products.name,
      SUM(bill_items.qty) AS qty_sold,
      SUM(bill_items.qty * bill_items.price) AS revenue
    FROM bill_items
    JOIN bills ON bill_items.bill_id = bills.id
    JOIN products ON bill_items.sku = products.sku
    WHERE bills.status = 'completed'
    GROUP BY bill_items.sku, products.name
    ORDER BY revenue DESC
    LIMIT ?
  `).all(limit);

  return rows.map(r => ({
    sku: r.sku,
    name: r.name,
    qty_sold: r.qty_sold,
    revenue: Number((r.revenue || 0).toFixed(2))
  }));
}

function getInventorySnapshot() {
  const productRow = db.prepare(`
    SELECT COUNT(*) AS total_products, COALESCE(SUM(stock), 0) AS total_stock_units
    FROM products
  `).get();

  const stockLevels = db.prepare(`
    SELECT sku, name, stock, unit
    FROM products
    ORDER BY stock DESC
    LIMIT 10
  `).all();

  return {
    total_products: productRow.total_products,
    total_stock_units: Number((productRow.total_stock_units || 0).toFixed(2)),
    stock_levels: stockLevels,
    low_stock: getLowStockReport(),
    out_of_stock: getOutOfStockReport()
  };
}

// =============================================
// PUBLIC: gather everything the deck needs, in one
// read-only pass. Exported separately from the PPTX
// renderer so the data itself can be tested/inspected
// without touching the filesystem.
// =============================================

function getBusinessReportData() {
  const overview = getOverviewTotals();
  const dailyTrend = getDailySalesTrend();
  const topProducts = getTopProducts(5);
  const inventory = getInventorySnapshot();

  let bestSellingByQty = null;
  let highestRevenueProduct = null;

  if (topProducts.length > 0) {
    highestRevenueProduct = topProducts[0]; // already sorted by revenue DESC
    bestSellingByQty = topProducts.slice().sort((a, b) => b.qty_sold - a.qty_sold)[0];
  }

  return {
    generated_at: new Date().toISOString(),
    shop: getShopConfig(),
    overview,
    daily_trend: dailyTrend,
    top_products: topProducts,
    inventory,
    insights: {
      best_selling_by_qty: bestSellingByQty,
      highest_revenue_product: highestRevenueProduct
    }
  };
}

// =============================================
// SLIDE BUILDERS
// =============================================

const BRAND_COLOR = '1F4E79';
const ACCENT_COLOR = '2E86C1';
const TEXT_COLOR = '333333';

function addTitleSlide(pptx, data) {
  const slide = pptx.addSlide();

  slide.addText(data.shop.name, {
    x: 0.5, y: 2.1, w: 12.33, h: 1,
    fontSize: 32, bold: true, align: 'center', color: BRAND_COLOR
  });

  slide.addText('Business Analysis Report', {
    x: 0.5, y: 3.1, w: 12.33, h: 0.7,
    fontSize: 22, align: 'center', color: TEXT_COLOR
  });

  const generatedDate = new Date(data.generated_at).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  slide.addText(`Generated on ${generatedDate}`, {
    x: 0.5, y: 3.9, w: 12.33, h: 0.5,
    fontSize: 13, align: 'center', color: '777777'
  });
}

function addSalesOverviewSlide(pptx, data) {
  const slide = pptx.addSlide();
  const o = data.overview;

  slide.addText('Sales Overview', {
    x: 0.5, y: 0.35, w: 12.33, h: 0.7,
    fontSize: 24, bold: true, color: BRAND_COLOR
  });

  if (o.total_bills === 0) {
    slide.addText('No finalized bills yet — this section will populate once sales are recorded.', {
      x: 0.5, y: 2.5, w: 12.33, h: 1, fontSize: 14, align: 'center', color: '777777'
    });
    return;
  }

  const cards = [
    { label: 'Total Sales', value: money(o.total_sales) },
    { label: 'Finalized Bills', value: String(o.total_bills) },
    { label: 'Cash Sales', value: money(o.cash_sales) },
    { label: 'Credit Sales', value: money(o.credit_sales) },
    { label: 'Total GST Collected', value: money(o.total_gst) }
  ];

  const cardWidth = 2.35;
  const gap = 0.2;
  const startX = 0.5;

  cards.forEach((card, i) => {
    const x = startX + i * (cardWidth + gap);
    slide.addShape(pptx.ShapeType.roundRect, {
      x, y: 1.6, w: cardWidth, h: 1.5,
      fill: { color: 'EAF2F8' },
      line: { color: ACCENT_COLOR, width: 1 },
      rectRadius: 0.08
    });
    slide.addText(card.value, {
      x, y: 1.75, w: cardWidth, h: 0.7,
      fontSize: 16, bold: true, align: 'center', color: BRAND_COLOR
    });
    slide.addText(card.label, {
      x, y: 2.45, w: cardWidth, h: 0.5,
      fontSize: 10, align: 'center', color: TEXT_COLOR
    });
  });
}

function addSalesTrendSlide(pptx, data) {
  const slide = pptx.addSlide();

  slide.addText('Sales Trend', {
    x: 0.5, y: 0.35, w: 12.33, h: 0.7,
    fontSize: 24, bold: true, color: BRAND_COLOR
  });

  const trend = data.daily_trend;

  if (trend.length === 0) {
    slide.addText('No sales data available yet to plot a trend.', {
      x: 0.5, y: 2.5, w: 12.33, h: 1, fontSize: 14, align: 'center', color: '777777'
    });
    return;
  }

  slide.addChart(
    pptx.ChartType.bar,
    [{
      name: 'Daily Sales (Rs.)',
      labels: trend.map(t => t.day),
      values: trend.map(t => t.total)
    }],
    {
      x: 0.5, y: 1.3, w: 12.33, h: 5.5,
      barDir: 'col',
      showLegend: false,
      showValue: trend.length <= 10,
      chartColors: [ACCENT_COLOR],
      catAxisLabelFontSize: 9,
      valAxisTitle: 'Sales (Rs.)'
    }
  );
}

function addPaymentAnalysisSlide(pptx, data) {
  const slide = pptx.addSlide();
  const o = data.overview;

  slide.addText('Payment Analysis', {
    x: 0.5, y: 0.35, w: 12.33, h: 0.7,
    fontSize: 24, bold: true, color: BRAND_COLOR
  });

  if (o.cash_sales === 0 && o.credit_sales === 0) {
    slide.addText('No payment data available yet.', {
      x: 0.5, y: 2.5, w: 12.33, h: 1, fontSize: 14, align: 'center', color: '777777'
    });
    return;
  }

  slide.addChart(
    pptx.ChartType.pie,
    [{
      name: 'Payment Split',
      labels: ['Cash', 'Credit'],
      values: [o.cash_sales, o.credit_sales]
    }],
    {
      x: 2.5, y: 1.3, w: 8, h: 5.3,
      showLegend: true,
      legendPos: 'b',
      showPercent: true,
      chartColors: [ACCENT_COLOR, 'E67E22']
    }
  );
}

function addTopProductsSlide(pptx, data) {
  const slide = pptx.addSlide();

  slide.addText('Top Selling Products', {
    x: 0.5, y: 0.35, w: 12.33, h: 0.7,
    fontSize: 24, bold: true, color: BRAND_COLOR
  });

  const top = data.top_products;

  if (top.length === 0) {
    slide.addText('No products have been sold yet.', {
      x: 0.5, y: 2.5, w: 12.33, h: 1, fontSize: 14, align: 'center', color: '777777'
    });
    return;
  }

  const tableRows = [
    [
      { text: 'Product', options: { bold: true, fill: { color: BRAND_COLOR }, color: 'FFFFFF' } },
      { text: 'Qty Sold', options: { bold: true, fill: { color: BRAND_COLOR }, color: 'FFFFFF' } },
      { text: 'Revenue', options: { bold: true, fill: { color: BRAND_COLOR }, color: 'FFFFFF' } }
    ]
  ];

  top.forEach(p => {
    tableRows.push([
      { text: p.name },
      { text: String(p.qty_sold) },
      { text: money(p.revenue) }
    ]);
  });

  slide.addTable(tableRows, {
    x: 0.5, y: 1.3, w: 6.5, h: 3,
    fontSize: 11,
    border: { type: 'solid', color: 'CCCCCC', pt: 0.5 },
    autoPage: false
  });

  slide.addChart(
    pptx.ChartType.bar,
    [{
      name: 'Revenue (Rs.)',
      labels: top.map(p => p.name),
      values: top.map(p => p.revenue)
    }],
    {
      x: 7.3, y: 1.3, w: 5.5, h: 5.3,
      barDir: 'bar',
      showLegend: false,
      chartColors: [ACCENT_COLOR],
      catAxisLabelFontSize: 9
    }
  );
}

function addInventorySlide(pptx, data) {
  const slide = pptx.addSlide();
  const inv = data.inventory;

  slide.addText('Inventory Analysis', {
    x: 0.5, y: 0.35, w: 12.33, h: 0.7,
    fontSize: 24, bold: true, color: BRAND_COLOR
  });

  slide.addText(
    `${inv.total_products} products tracked   |   ${inv.total_stock_units} total stock units`,
    { x: 0.5, y: 1.1, w: 12.33, h: 0.4, fontSize: 13, color: TEXT_COLOR }
  );

  if (inv.stock_levels.length > 0) {
    slide.addChart(
      pptx.ChartType.bar,
      [{
        name: 'Current Stock',
        labels: inv.stock_levels.map(p => p.name),
        values: inv.stock_levels.map(p => p.stock)
      }],
      {
        x: 0.5, y: 1.6, w: 6.3, h: 5.2,
        barDir: 'bar',
        showLegend: false,
        chartColors: [ACCENT_COLOR],
        catAxisLabelFontSize: 9,
        valAxisTitle: 'Stock (units)'
      }
    );
  }

  const listX = 7.1;
  slide.addText(`Low Stock (${inv.low_stock.total_low_stock})`, {
    x: listX, y: 1.6, w: 5.7, h: 0.4, fontSize: 14, bold: true, color: 'C0392B'
  });

  const lowStockText = inv.low_stock.items.length > 0
    ? inv.low_stock.items.slice(0, 8).map(i => `${i.name}: ${i.stock} ${i.unit}`).join('\n')
    : 'None — all products are above the low-stock threshold.';

  slide.addText(lowStockText, {
    x: listX, y: 2.05, w: 5.7, h: 2.1, fontSize: 11, color: TEXT_COLOR, valign: 'top'
  });

  slide.addText(`Out of Stock (${inv.out_of_stock.total_out_of_stock})`, {
    x: listX, y: 4.3, w: 5.7, h: 0.4, fontSize: 14, bold: true, color: 'C0392B'
  });

  const outOfStockText = inv.out_of_stock.items.length > 0
    ? inv.out_of_stock.items.slice(0, 8).map(i => i.name).join('\n')
    : 'None — no products are currently out of stock.';

  slide.addText(outOfStockText, {
    x: listX, y: 4.75, w: 5.7, h: 2, fontSize: 11, color: TEXT_COLOR, valign: 'top'
  });
}

function addInsightsSlide(pptx, data) {
  const slide = pptx.addSlide();
  const o = data.overview;
  const insights = data.insights;
  const inv = data.inventory;

  slide.addText('Business Insights', {
    x: 0.5, y: 0.35, w: 12.33, h: 0.7,
    fontSize: 24, bold: true, color: BRAND_COLOR
  });

  const bullets = [];

  if (o.total_bills === 0) {
    bullets.push('No finalized sales yet — insights will appear here once bills are completed.');
  } else {
    if (insights.highest_revenue_product) {
      bullets.push(
        `Highest revenue product: ${insights.highest_revenue_product.name} ` +
        `(${money(insights.highest_revenue_product.revenue)} from ${insights.highest_revenue_product.qty_sold} units sold).`
      );
    }

    if (insights.best_selling_by_qty) {
      bullets.push(
        `Best-selling product by quantity: ${insights.best_selling_by_qty.name} ` +
        `(${insights.best_selling_by_qty.qty_sold} units sold).`
      );
    }

    const cashPct = o.total_sales > 0 ? Math.round((o.cash_sales / o.total_sales) * 100) : 0;
    const creditPct = o.total_sales > 0 ? 100 - cashPct : 0;
    bullets.push(`Payment split: ${cashPct}% cash, ${creditPct}% credit (by sales value).`);

    bullets.push(`Total GST collected so far: ${money(o.total_gst)}.`);
  }

  if (inv.low_stock.total_low_stock > 0) {
    bullets.push(`${inv.low_stock.total_low_stock} product(s) are currently low on stock and may need restocking.`);
  }

  if (inv.out_of_stock.total_out_of_stock > 0) {
    bullets.push(`${inv.out_of_stock.total_out_of_stock} product(s) are completely out of stock.`);
  }

  if (inv.low_stock.total_low_stock === 0 && inv.out_of_stock.total_out_of_stock === 0) {
    bullets.push('No low-stock or out-of-stock warnings at this time.');
  }

  slide.addText(
    bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
    { x: 0.5, y: 1.3, w: 12.33, h: 5.5, fontSize: 15, color: TEXT_COLOR, lineSpacingMultiple: 1.4, valign: 'top' }
  );
}

// =============================================
// PUBLIC ENTRY POINT
//
// Read-only report generation — unlike the GST PDF
// invoice, this never touches bills/stock/khata, so there
// is no financial transaction to protect against being
// re-run. Regenerating on request simply overwrites today's
// snapshot with a fresh one, which is the desired behavior
// for a report (not a receipt).
// =============================================

async function generateBusinessReportPptx() {
  const data = getBusinessReportData();

  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = `${data.shop.name} - Business Analysis Report`;

  addTitleSlide(pptx, data);
  addSalesOverviewSlide(pptx, data);
  addSalesTrendSlide(pptx, data);
  addPaymentAnalysisSlide(pptx, data);
  addTopProductsSlide(pptx, data);
  addInventorySlide(pptx, data);
  addInsightsSlide(pptx, data);

  const outPath = reportPathForToday();
  await pptx.writeFile({ fileName: outPath });

  return outPath;
}

module.exports = {
  getBusinessReportData,
  generateBusinessReportPptx
};
