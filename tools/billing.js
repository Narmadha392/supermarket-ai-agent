const db = require('../db');
const { getOrCreateCustomer, addKhataCreditByCustomerId } = require('./khata');
const { DEFAULT_LOW_STOCK_THRESHOLD } = require('./stock');


// =============================================
// PURE GST MATH (single source of truth)
//
// MRP is treated as GST-inclusive. Extracted out of
// finalizeBill() unchanged (same formula, same rounding
// behavior) so that invoice generation can reuse the exact
// same calculation instead of re-implementing it — this is
// what keeps the PDF invoice numbers guaranteed consistent
// with the numbers finalizeBill() actually charged.
// =============================================

function computeItemGst(itemAmount, gstRate) {

  gstRate = gstRate || 0;

  const taxableAmount =
    gstRate === 0
      ? itemAmount
      : itemAmount / (1 + gstRate / 100);

  const gstAmount = itemAmount - taxableAmount;

  const cgst = gstAmount / 2;
  const sgst = gstAmount / 2;

  return { taxableAmount, gstAmount, cgst, sgst };
}


// =============================================
// START BILL
//
// NEW: accepts an optional customerName. Required
// when paymentMode is 'credit' — enforced here at
// the tool layer, not just in the system prompt.
// =============================================

function startBill(paymentMode = 'cash', idempotencyKey, customerName, chatId) {

  if (!idempotencyKey) {
    return {
      error: 'idempotency_key is required'
    };
  }

  if (paymentMode === 'credit' && !customerName) {
    return {
      error: 'A customer name is required to start a credit bill. Ask the user whose khata this bill should be added to.'
    };
  }


  // If this exact request was already processed,
  // return the existing bill instead of creating another.

  const existingBill = db.prepare(`
    SELECT *
    FROM bills
    WHERE idempotency_key = ?
  `).get(idempotencyKey);


  if (existingBill) {

    return {
      message: 'This bill already exists.',
      bill_id: existingBill.id,
      status: existingBill.status
    };

  }


  let customerId = null;
  let resolvedCustomerName = null;

  if (paymentMode === 'credit') {
    const customer = getOrCreateCustomer(customerName);
    customerId = customer.id;
    resolvedCustomerName = customer.name;
  }


  const result = db.prepare(`
    INSERT INTO bills (
      status,
      payment_mode,
      total,
      tax,
      idempotency_key,
      customer_id,
      chat_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'pending',
    paymentMode,
    0,
    0,
    idempotencyKey,
    customerId,
    chatId != null ? String(chatId) : null
  );


  return {

    message: 'Bill started successfully.',

    bill_id: Number(result.lastInsertRowid),

    status: 'pending',

    payment_mode: paymentMode,

    customer: resolvedCustomerName

  };

}



// =============================================
// ADD BILL ITEM
// =============================================

function addBillItem(billId, sku, qty) {

  qty = Number(qty);

  if (
    !Number.isInteger(qty) ||
    qty <= 0
  ) {
    return {
      error: 'Quantity must be a positive whole number.'
    };
  }


  // Check bill

  const bill = db.prepare(`
    SELECT *
    FROM bills
    WHERE id = ?
  `).get(billId);


  if (!bill) {

    return {
      error: 'Bill not found.'
    };

  }


  if (bill.status !== 'pending') {

    return {
      error: 'This bill is already finalized.'
    };

  }


  // Check product

  const product = db.prepare(`
    SELECT *
    FROM products
    WHERE sku = ?
  `).get(sku);


  if (!product) {

    return {
      error: `Product not found: ${sku}`
    };

  }


  // Add item to bill

  db.prepare(`
    INSERT INTO bill_items (
      bill_id,
      sku,
      qty,
      price
    )
    VALUES (?, ?, ?, ?)
  `).run(
    billId,
    sku,
    qty,
    product.mrp
  );


  return {

    message: 'Item added successfully.',

    bill_id: billId,

    sku: product.sku,

    name: product.name,

    qty: qty,

    price: product.mrp

  };

}



// =============================================
// FINALIZE BILL
//
// IMPORTANT:
// Everything happens inside ONE transaction.
//
// If anything fails:
// - Bill is not completed
// - Stock is not reduced
// - Khata is not credited
//
// NEW: if the bill's payment_mode is 'credit', the
// grand total is credited to the linked customer's
// khata as the LAST step inside this same
// transaction, so stock deduction and khata credit
// either both happen or neither does.
// =============================================

function finalizeBill(billId) {


  const transaction = db.transaction(() => {


    // -----------------------------------------
    // 1. Get bill
    // -----------------------------------------

    const bill = db.prepare(`
      SELECT *
      FROM bills
      WHERE id = ?
    `).get(billId);


    if (!bill) {

      throw new Error('Bill not found.');

    }


    // -----------------------------------------
    // 2. Idempotency protection
    //
    // If already completed, we return early WITHOUT
    // re-running any of the logic below — this is what
    // guarantees a retried finalize_bill call can never
    // deduct stock twice or credit khata twice.
    // -----------------------------------------

    if (bill.status === 'completed') {

      return {

        message: 'Bill was already finalized.',

        bill_id: bill.id,

        total: bill.total,

        tax: bill.tax

      };

    }


    // -----------------------------------------
    // 3. Get bill items + products
    // -----------------------------------------

    const items = db.prepare(`
  SELECT
    bill_items.sku,

    SUM(bill_items.qty) AS qty,

    bill_items.price,

    products.name,
    products.stock,
    products.gst_slab,
    products.unit,
    products.hsn

  FROM bill_items

  JOIN products
  ON bill_items.sku = products.sku

  WHERE bill_items.bill_id = ?

  GROUP BY
    bill_items.sku,
    bill_items.price,
    products.name,
    products.stock,
    products.gst_slab,
    products.unit,
    products.hsn
`).all(billId);
      

    if (items.length === 0) {

      throw new Error('Cannot finalize an empty bill.');

    }


    // -----------------------------------------
    // 4. OVERSALE CHECK
    //
    // Check ALL stock before changing anything.
    // -----------------------------------------

    for (const item of items) {

      if (item.stock < item.qty) {

        throw new Error(
          `Insufficient stock for ${item.name}. ` +
          `Available: ${item.stock}, ` +
          `Requested: ${item.qty}`
        );

      }

    }


    let subtotal = 0;

    let totalTax = 0;

    let totalCGST = 0;

    let totalSGST = 0;


    const invoiceItems = [];

    const lowStockWarnings = [];


    // -----------------------------------------
    // 5. Calculate GST + reduce stock
    // -----------------------------------------

    for (const item of items) {


      // Selling price × quantity

      const itemAmount = item.qty * item.price;


      /*
       MRP is treated as GST-INCLUSIVE.

       Example:

       ₹112 at 12% GST

       Taxable value = 112 / 1.12 = ₹100

       GST = ₹12

       CGST = ₹6
       SGST = ₹6
      */


      const gstRate = item.gst_slab || 0;


      const { taxableAmount, gstAmount, cgst, sgst } =
        computeItemGst(itemAmount, gstRate);


      subtotal += taxableAmount;

      totalTax += gstAmount;

      totalCGST += cgst;

      totalSGST += sgst;


      // ---------------------------------------
      // Reduce stock
      // ---------------------------------------

      db.prepare(`
        UPDATE products
        SET stock = stock - ?
        WHERE sku = ?
      `).run(
        item.qty,
        item.sku
      );


      // -----------------------------------------
      // Low stock warning
      //
      // item.stock is the PRE-deduction value from
      // the SELECT above, so subtracting item.qty
      // gives the exact remaining stock after this
      // sale — computed here rather than re-querying,
      // since we already hold the correct numbers
      // inside this same transaction.
      // -----------------------------------------

      const remainingStock = item.stock - item.qty;

      if (remainingStock <= DEFAULT_LOW_STOCK_THRESHOLD) {

        lowStockWarnings.push({
          sku: item.sku,
          name: item.name,
          remaining_stock: remainingStock,
          unit: item.unit
        });

      }


      invoiceItems.push({

        sku: item.sku,

        name: item.name,

        hsn: item.hsn || '',

        unit: item.unit,

        qty: item.qty,

        price: item.price,

        amount: itemAmount,

        gst_rate: gstRate,

        taxable_amount:
          Number(taxableAmount.toFixed(2)),

        gst:
          Number(gstAmount.toFixed(2)),

        cgst:
          Number(cgst.toFixed(2)),

        sgst:
          Number(sgst.toFixed(2))

      });

    }


    // -----------------------------------------
    // 6. Round money values
    // -----------------------------------------

    subtotal =
      Number(subtotal.toFixed(2));

    totalTax =
      Number(totalTax.toFixed(2));

    totalCGST =
      Number(totalCGST.toFixed(2));

    totalSGST =
      Number(totalSGST.toFixed(2));


    // Customer pays MRP total

    const grandTotal =
      Number(
        (subtotal + totalTax).toFixed(2)
      );


    // -----------------------------------------
    // 7. Complete bill
    // -----------------------------------------

    db.prepare(`
      UPDATE bills

      SET
        status = ?,
        total = ?,
        tax = ?

      WHERE id = ?
    `).run(
      'completed',
      grandTotal,
      totalTax,
      billId
    );


    // -----------------------------------------
    // 8. CREDIT BILL: add grand total to khata
    //
    // Runs as part of THIS SAME transaction.
    // If this throws, stock deduction and the
    // status update above are rolled back too.
    // -----------------------------------------

    let khataResult = null;

    if (bill.payment_mode === 'credit') {

      if (!bill.customer_id) {
        throw new Error('This credit bill has no linked customer. Cannot finalize.');
      }

      khataResult = addKhataCreditByCustomerId(
        bill.customer_id,
        grandTotal,
        `Bill #${billId}`,
        billId
      );

    }


    return {

      message: 'Bill finalized successfully.',

      bill_id: billId,

      payment_mode: bill.payment_mode,

      subtotal,

      cgst: totalCGST,

      sgst: totalSGST,

      gst: totalTax,

      grand_total: grandTotal,

      items: invoiceItems,

      khata: khataResult,

      low_stock_warnings: lowStockWarnings

    };

  });


  // Execute the complete transaction

  try {

    return transaction();

  } catch (error) {

    return {
      error: error.message
    };

  }

}

function getBill(billId) {

  const bill = db.prepare(`
    SELECT *
    FROM bills
    WHERE id = ?
  `).get(billId);

  if (!bill) {
    return {
      error: 'Bill not found.'
    };
  }

  const items = db.prepare(`
    SELECT *
    FROM bill_items
    WHERE bill_id = ?
  `).all(billId);

  let customerName = null;

  if (bill.customer_id) {
    const customer = db.prepare(`
      SELECT name FROM customers WHERE id = ?
    `).get(bill.customer_id);
    customerName = customer ? customer.name : null;
  }

  return {
    bill,
    items,
    customer: customerName
  };
}

// =============================================
// GET BILL INVOICE DATA (NEW)
//
// Rebuilds the full invoice breakdown (items, HSN, GST
// per line, totals) for an ALREADY-FINALIZED bill, purely
// from what is stored in the database:
//   - bill_items.qty / bill_items.price (the historical,
//     already-charged amounts — never re-priced)
//   - products.gst_slab / products.hsn / products.unit
//     (current product master, joined for display fields)
//   - computeItemGst(), the exact same tax formula
//     finalizeBill() itself uses
//
// This performs NO writes and touches no stock, khata, or
// bill status — it is safe to call any number of times,
// including for a bill finalized minutes/days ago (e.g. if
// the server restarted before the invoice PDF was written,
// or the owner asks to resend an invoice). It is what lets
// PDF generation be retried without ever re-running the
// financial transaction in finalizeBill().
// =============================================

function getBillInvoiceData(billId) {

  const bill = db.prepare(`
    SELECT *
    FROM bills
    WHERE id = ?
  `).get(billId);

  if (!bill) {
    return { error: 'Bill not found.' };
  }

  if (bill.status !== 'completed') {
    return { error: 'Bill is not finalized yet; cannot generate an invoice for it.' };
  }

  const items = db.prepare(`
    SELECT
      bill_items.sku,
      SUM(bill_items.qty) AS qty,
      bill_items.price,
      products.name,
      products.gst_slab,
      products.unit,
      products.hsn
    FROM bill_items
    JOIN products ON bill_items.sku = products.sku
    WHERE bill_items.bill_id = ?
    GROUP BY
      bill_items.sku,
      bill_items.price,
      products.name,
      products.gst_slab,
      products.unit,
      products.hsn
  `).all(billId);

  let subtotal = 0;
  let totalTax = 0;
  let totalCGST = 0;
  let totalSGST = 0;

  const invoiceItems = [];

  for (const item of items) {

    const itemAmount = item.qty * item.price;
    const gstRate = item.gst_slab || 0;

    const { taxableAmount, gstAmount, cgst, sgst } =
      computeItemGst(itemAmount, gstRate);

    subtotal += taxableAmount;
    totalTax += gstAmount;
    totalCGST += cgst;
    totalSGST += sgst;

    invoiceItems.push({
      sku: item.sku,
      name: item.name,
      hsn: item.hsn || '',
      unit: item.unit,
      qty: item.qty,
      price: item.price,
      amount: Number(itemAmount.toFixed(2)),
      gst_rate: gstRate,
      taxable_amount: Number(taxableAmount.toFixed(2)),
      gst: Number(gstAmount.toFixed(2)),
      cgst: Number(cgst.toFixed(2)),
      sgst: Number(sgst.toFixed(2))
    });
  }

  subtotal = Number(subtotal.toFixed(2));
  totalTax = Number(totalTax.toFixed(2));
  totalCGST = Number(totalCGST.toFixed(2));
  totalSGST = Number(totalSGST.toFixed(2));

  const grandTotal = Number((subtotal + totalTax).toFixed(2));

  let customerName = null;

  if (bill.customer_id) {
    const customer = db.prepare(`
      SELECT name FROM customers WHERE id = ?
    `).get(bill.customer_id);
    customerName = customer ? customer.name : null;
  }

  return {
    bill_id: bill.id,
    status: bill.status,
    payment_mode: bill.payment_mode,
    created_at: bill.created_at,
    customer: customerName,
    items: invoiceItems,
    subtotal,
    cgst: totalCGST,
    sgst: totalSGST,
    gst: totalTax,
    grand_total: grandTotal
  };
}


// =============================================
// CANCEL BILL
//
// Unchanged. Only ever touches bills.status.
// Never touches khata — a cancelled credit bill
// never creates a khata transaction, which is
// exactly the required behavior.
// =============================================

// =============================================
// GET PENDING BILLS FOR A TELEGRAM CHAT
//
// Used to resolve "cancel the bill" (no explicit
// bill ID given) to the correct pending bill for
// the Telegram user who sent the message, without
// touching any other chat's bills.
// =============================================

function getPendingBillsByChat(chatId) {

  if (chatId == null) {
    return [];
  }

  return db.prepare(`
    SELECT *
    FROM bills
    WHERE status = 'pending'
    AND chat_id = ?
    ORDER BY id ASC
  `).all(String(chatId));

}

function cancelBill(billId) {

  const bill = db.prepare(`
    SELECT *
    FROM bills
    WHERE id = ?
  `).get(billId);


  if (!bill) {

    return {
      error: 'Bill not found.'
    };

  }


  if (bill.status === 'completed') {

    return {
      error: 'Cannot cancel a bill that has already been finalized.'
    };

  }


  if (bill.status === 'cancelled') {

    return {
      message: 'Bill is already cancelled.',
      bill_id: billId
    };

  }


  db.prepare(`
    UPDATE bills
    SET status = ?
    WHERE id = ?
  `).run(
    'cancelled',
    billId
  );


  return {

    message: 'Bill cancelled successfully.',

    bill_id: billId

  };

}
// =============================================
// SET BILL ITEM QUANTITY
// =============================================

function setBillItemQuantity(billId, sku, qty) {

  qty = Number(qty);


  // ---------------------------------------------
  // Validate quantity
  // ---------------------------------------------

  if (!Number.isInteger(qty) || qty <= 0) {

    return {
      error: 'Quantity must be a positive whole number.'
    };

  }


  // ---------------------------------------------
  // Check bill
  // ---------------------------------------------

  const bill = db.prepare(`
    SELECT *
    FROM bills
    WHERE id = ?
  `).get(billId);


  if (!bill) {

    return {
      error: 'Bill not found.'
    };

  }


  if (bill.status !== 'pending') {

    return {
      error: 'This bill is not pending and cannot be modified.'
    };

  }


  // ---------------------------------------------
  // Check product
  // ---------------------------------------------

  const product = db.prepare(`
    SELECT *
    FROM products
    WHERE sku = ?
  `).get(sku);


  if (!product) {

    return {
      error: `Product not found: ${sku}`
    };

  }


  // ---------------------------------------------
  // Replace existing quantity
  //
  // Delete all old rows for this SKU,
  // then insert exactly one new row.
  // ---------------------------------------------

  const transaction = db.transaction(() => {

    db.prepare(`
      DELETE FROM bill_items
      WHERE bill_id = ?
      AND sku = ?
    `).run(
      billId,
      sku
    );


    db.prepare(`
      INSERT INTO bill_items (
        bill_id,
        sku,
        qty,
        price
      )
      VALUES (?, ?, ?, ?)
    `).run(
      billId,
      sku,
      qty,
      product.mrp
    );

  });


  transaction();


  return {

    message: 'Item quantity set successfully.',

    bill_id: billId,

    sku: product.sku,

    name: product.name,

    qty,

    price: product.mrp

  };

}
// =============================================
// REMOVE BILL ITEM
// =============================================

function removeBillItem(billId, sku) {

  // Check bill
  const bill = db.prepare(`
    SELECT *
    FROM bills
    WHERE id = ?
  `).get(billId);


  if (!bill) {

    return {
      error: 'Bill not found.'
    };

  }


  // Only pending bills can be modified
  if (bill.status !== 'pending') {

    return {
      error: 'This bill is not pending and cannot be modified.'
    };

  }


  // Delete the item
  const result = db.prepare(`
    DELETE FROM bill_items
    WHERE bill_id = ?
    AND sku = ?
  `).run(
    billId,
    sku
  );


  // Check whether anything was deleted
  if (result.changes === 0) {

    return {
      error: `Item not found in this bill: ${sku}`
    };

  }


  return {

    message: 'Item removed successfully.',

    bill_id: billId,

    sku: sku

  };

}

// =============================================
// EXPORTS
// =============================================

module.exports = {

  startBill,

  addBillItem,

  finalizeBill,

  getBill,

  getBillInvoiceData,

  cancelBill,

  getPendingBillsByChat,

  setBillItemQuantity,

  removeBillItem

};