const {
  startBill,
  addBillItem,
  finalizeBill
} = require('./tools/billing');


// Create bill

const bill = startBill(
  'cash',
  'test-bill-001'
);

console.log('START BILL:');
console.log(bill);


// Add Sugar

console.log('\nADD SUGAR:');

console.log(
  addBillItem(
    bill.bill_id,
    'sugar',
    2
  )
);


// Add Maggi

console.log('\nADD MAGGI:');

console.log(
  addBillItem(
    bill.bill_id,
    'maggi',
    3
  )
);


// Finalize

console.log('\nFINAL BILL:');

console.log(
  finalizeBill(
    bill.bill_id
  )
);