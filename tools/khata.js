const db = require('../db');

// =============================================
// FIND OR CREATE CUSTOMER (case-insensitive)
// =============================================

function findCustomer(name) {
  return db.prepare(`
    SELECT * FROM customers WHERE LOWER(name) = LOWER(?)
  `).get(name);
}

function getOrCreateCustomer(name) {
  const existing = findCustomer(name);
  if (existing) return existing;

  const result = db.prepare(`
    INSERT INTO customers (name) VALUES (?)
  `).run(name);

  return {
    id: Number(result.lastInsertRowid),
    name,
    created_at: new Date().toISOString()
  };
}

// =============================================
// CALCULATE OUTSTANDING BALANCE
// =============================================

function calculateBalance(customerId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS total_credit,
      COALESCE(SUM(CASE WHEN type = 'payment' THEN amount ELSE 0 END), 0) AS total_payment
    FROM khata_transactions
    WHERE customer_id = ?
  `).get(customerId);

  return Number((row.total_credit - row.total_payment).toFixed(2));
}

// =============================================
// ADD KHATA CREDIT (standalone, e.g. manual credit
// via "put ₹500 on Ramesh's credit")
//
// This wraps its own transaction and is safe to call
// directly as a tool.
// =============================================

function addKhataCredit(customerName, amount, note = '', idempotencyKey) {

  amount = Number(amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'Credit amount must be a positive number.' };
  }

  if (!idempotencyKey) {
    return { error: 'idempotencyKey is required to add khata credit.' };
  }

  // If this exact request was already processed (e.g. a retried
  // Telegram update), return the customer's current balance
  // instead of applying the credit a second time.
  const already = db.prepare(`
    SELECT * FROM khata_transactions WHERE idempotency_key = ?
  `).get(idempotencyKey);

  if (already) {
    return {
      message: 'This credit was already recorded.',
      customer: customerName,
      amount_added: already.amount,
      balance: calculateBalance(already.customer_id)
    };
  }

  const transaction = db.transaction(() => {

    const customer = getOrCreateCustomer(customerName);

    db.prepare(`
      INSERT INTO khata_transactions (customer_id, type, amount, note, idempotency_key)
      VALUES (?, 'credit', ?, ?, ?)
    `).run(customer.id, amount, note, idempotencyKey);

    const balance = calculateBalance(customer.id);

    return {
      message: 'Credit added successfully.',
      customer: customer.name,
      amount_added: amount,
      balance
    };
  });

  return transaction();
}

// =============================================
// ADD KHATA CREDIT BY CUSTOMER ID (NEW)
//
// Used internally by finalizeBill() for credit bills.
// Unlike addKhataCredit, this does NOT wrap its own
// db.transaction() — it is meant to be called from
// INSIDE another function's existing transaction
// (better-sqlite3 runs synchronously, so calling this
// from within finalizeBill's transaction callback makes
// it part of that same atomic unit — if anything later
// fails, this insert rolls back too).
//
// It throws instead of returning { error } so that a
// failure here correctly aborts the enclosing transaction.
// =============================================

function addKhataCreditByCustomerId(customerId, amount, note = '', billId = null) {

  amount = Number(amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Credit amount must be a positive number.');
  }

  const customer = db.prepare(`
    SELECT * FROM customers WHERE id = ?
  `).get(customerId);

  if (!customer) {
    throw new Error('Customer for this credit bill no longer exists.');
  }

  db.prepare(`
    INSERT INTO khata_transactions (customer_id, type, amount, note, bill_id)
    VALUES (?, 'credit', ?, ?, ?)
  `).run(customerId, amount, note, billId);

  return {
    customer: customer.name,
    amount_added: amount,
    balance: calculateBalance(customerId)
  };
}

// =============================================
// CHECK KHATA BALANCE
// =============================================

function checkKhataBalance(customerName) {

  const customer = findCustomer(customerName);

  if (!customer) {
    return { error: `No customer found with name "${customerName}".` };
  }

  const balance = calculateBalance(customer.id);

  return {
    customer: customer.name,
    balance
  };
}

// =============================================
// RECORD KHATA PAYMENT
// =============================================

function recordKhataPayment(customerName, amount, note = '', idempotencyKey) {

  amount = Number(amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'Payment amount must be a positive number.' };
  }

  if (!idempotencyKey) {
    return { error: 'idempotencyKey is required to record a khata payment.' };
  }

  const customer = findCustomer(customerName);

  if (!customer) {
    return { error: `No customer found with name "${customerName}". Cannot record a payment for a customer with no khata record.` };
  }

  // If this exact payment was already processed (e.g. a retried
  // Telegram update), return the customer's current balance
  // instead of applying the payment a second time.
  const already = db.prepare(`
    SELECT * FROM khata_transactions WHERE idempotency_key = ?
  `).get(idempotencyKey);

  if (already) {
    return {
      message: 'This payment was already recorded.',
      customer: customer.name,
      amount_paid: already.amount,
      balance: calculateBalance(customer.id)
    };
  }

  const transaction = db.transaction(() => {

    const currentBalance = calculateBalance(customer.id);

    if (amount > currentBalance) {
      throw new Error(
        `Payment of ₹${amount} exceeds outstanding balance of ₹${currentBalance} for ${customer.name}.`
      );
    }

    db.prepare(`
      INSERT INTO khata_transactions (customer_id, type, amount, note, idempotency_key)
      VALUES (?, 'payment', ?, ?, ?)
    `).run(customer.id, amount, note, idempotencyKey);

    const newBalance = calculateBalance(customer.id);

    return {
      message: 'Payment recorded successfully.',
      customer: customer.name,
      amount_paid: amount,
      balance: newBalance
    };
  });

  try {
    return transaction();
  } catch (error) {
    return { error: error.message };
  }
}

module.exports = {
  findCustomer,
  getOrCreateCustomer,
  calculateBalance,
  addKhataCredit,
  addKhataCreditByCustomerId,
  checkKhataBalance,
  recordKhataPayment
};