require('dotenv').config();

const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const {
  checkStock,
  receiveStock,
  addProduct,
  findProduct,
  getLowStockReport,
  getOutOfStockReport
} = require('./tools/stock');
const {
  startBill,
  addBillItem,
  getBill,
  finalizeBill,
  cancelBill,
  setBillItemQuantity,
  removeBillItem,
  getPendingBillsByChat
} = require('./tools/billing');
const {
  addKhataCredit,
  checkKhataBalance,
  recordKhataPayment
} = require('./tools/khata');
const {
  getSalesReport
} = require('./tools/reports');
const {
  getOrCreateInvoicePdf
} = require('./tools/invoice');
const {
  generateBusinessReportPptx
} = require('./tools/business_report');
const {
  getAllUserPreferences,
  getShopSettings,
  setUserPreference,
  setShopSetting
} = require('./tools/preferences');
const db = require('./db');

// =====================================================
// 1. TELEGRAM
// =====================================================

const bot = new TelegramBot(
  process.env.TELEGRAM_TOKEN,
  { polling: true }
);


// =====================================================
// TELEGRAM UPDATE IDEMPOTENCY
//
// node-telegram-bot-api's public events (e.g. 'message')
// never expose Telegram's own update_id — processUpdate()
// is its documented, overridable entry point for both
// polling and webhooks, so this attaches update_id onto
// the message object before the original processUpdate
// runs. bot.on('message', ...) below can then check it
// against processed_updates and safely ignore a redelivered
// update (e.g. after a restart) without running any
// business logic for it twice.
// =====================================================

const originalProcessUpdate = bot.processUpdate.bind(bot);

bot.processUpdate = function (update) {
  if (update && update.message) {
    update.message.update_id = update.update_id;
  }
  return originalProcessUpdate(update);
};


// =====================================================
// 2. GEMINI
// =====================================================

let ai;

async function initializeGemini() {
  const { GoogleGenAI } = await import('@google/genai');

  ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });
}


// =====================================================
// 3. TOOL DEFINITIONS
// =====================================================

const tools = [

  {
    type: 'function',

    name: 'check_stock',

    description:
      'Check how much of a product is currently in stock. Use this when the owner asks how much of an item is left or asks for current stock.',

    parameters: {
      type: 'object',

      properties: {

        sku: {
          type: 'string',

          description:
            "Product identifier such as 'sugar', 'maggi', 'atta_aashirvaad_5kg', or 'amul_butter_100g'."
        }

      },

      required: ['sku']
    }
  },


  {
    type: 'function',

    name: 'receive_stock',

    description:
      'Record new stock arriving at the shop. Use this when the owner says products came in, arrived, or were received. idempotencyKey prevents the same delivery from being recorded twice if this call is retried.',

    parameters: {
      type: 'object',

      properties: {

        sku: {
          type: 'string'
        },

        name: {
          type: 'string'
        },

        qty: {
          type: 'number'
        },

        cost: {
          type: 'number'
        },

        mrp: {
          type: 'number'
        },

        unit: {
          type: 'string'
        },

        gst_slab: {
          type: 'number'
        },

        hsn: {
          type: 'string'
        },

        idempotencyKey: {
          type: 'string',
          description:
            'A unique identifier for this stock delivery to prevent it from being recorded twice.'
        }

      },

      required: [
        'sku',
        'name',
        'qty',
        'cost',
        'mrp',
        'idempotencyKey'
      ]
    }
  },


  {
    type: 'function',

    name: 'add_product',

    description:
      'Add a completely new product to the store catalog.',

    parameters: {
      type: 'object',

      properties: {

        sku: {
          type: 'string'
        },

        name: {
          type: 'string'
        },

        unit: {
          type: 'string'
        },

        gst_slab: {
          type: 'number'
        },

        mrp: {
          type: 'number'
        },

        hsn: {
          type: 'string'
        }

      },

      required: [
        'sku',
        'name',
        'unit',
        'gst_slab',
        'mrp'
      ]
    }
  },
   // =====================================
  // FIND PRODUCT
  // =====================================

  {
    type: 'function',

    name: 'find_product',

    description:
      'Find a product by its name and get its exact SKU, price, stock, unit, and GST details. Use this before adding an item to a bill when the user provides a product name instead of an SKU.',

    parameters: {
      type: 'object',

      properties: {

        productName: {
          type: 'string',

          description:
            'The product name provided by the user, such as Parle-G Biscuit or Maggi.'
        }

      },

      required: ['productName']
    }
  },
{
  type: 'function',

  name: 'start_bill',

  description:
'Start a new customer bill in PENDING status. Add requested items using add_bill_item. Do not finalize the bill unless the user explicitly requests finalization. If paymentMode is "credit", customerName is REQUIRED — this is the customer whose khata the bill will be added to when it is later finalized. If the user wants a credit bill but has not named a customer, do NOT call this tool yet — first ask the user whose khata the bill should be added to.',
  parameters: {
    type: 'object',

    properties: {

      paymentMode: {
        type: 'string',
        description:
          'Payment method such as cash, upi, card, or credit.'
      },

      idempotencyKey: {
        type: 'string',
        description:
          'A unique identifier for this bill to prevent duplicate billing.'
      },

      customerName: {
        type: 'string',
        description:
          'Required only when paymentMode is "credit". The customer whose khata this bill will be linked to.'
      }

    },

    required: [
      'paymentMode',
      'idempotencyKey'
    ]
  }
},

{
  type: 'function',

  name: 'add_bill_item',

  description:
'Add exactly one product to a pending bill. Use the exact billId, SKU, and qty. Keep the bill pending after adding the item. Do not call finalize_bill unless the user explicitly requests finalization.',
  parameters: {
    type: 'object',

    properties: {

      billId: {
        type: 'number',
        description:
          'The ID of the bill.'
      },

      sku: {
        type: 'string',
        description:
          'The product SKU.'
      },

      qty: {
        type: 'number',
        description:
          'The quantity being sold.'
      }

    },

    required: [
      'billId',
      'sku',
      'qty'
    ]
  }
},

{
  type: 'function',

  name: 'get_bill',

  description:
    'Get the complete details and items of an existing bill using its bill ID.',

  parameters: {
    type: 'object',

    properties: {

      billId: {
        type: 'number',

        description:
          'The ID of the bill.'
      }

    },

    required: ['billId']
  }
},

{
  type: 'function',

  name: 'finalize_bill',

  description:
  'Finalize a pending bill after all requested items have been successfully added. This calculates the final GST and total, checks stock, reduces stock, and completes the bill. If the bill is a credit bill, this also adds the grand total to the linked customer\'s khata balance in the same atomic step. Only use the returned result to create the final receipt.',

  parameters: {
    type: 'object',

    properties: {

      billId: {
        type: 'number',
        description:
          'The ID of the bill to finalize.'
      }

    },

    required: [
      'billId'
    ]
  }
},
{
  type: 'function',

  name: 'cancel_bill',

  description:
    'Cancel a pending bill when the customer no longer wants to complete it. A finalized bill cannot be cancelled. Cancelling a credit bill never affects khata, since khata is only touched on finalize_bill. billId is OPTIONAL: if the user just says "cancel the bill" without naming an ID, omit billId — the system will automatically find that Telegram chat\'s pending bill, or ask which one if there is more than one. Only include billId when the user names a specific bill number (e.g. "cancel bill 35").',

  parameters: {

    type: 'object',

    properties: {

      billId: {

        type: 'number',

        description: 'Optional. The ID of the bill to cancel, only if the user explicitly named one.'

      }

    },

    required: []

  }

},
{
  type: 'function',

  name: 'set_bill_item_quantity',

  description:
    'Set the exact quantity of an existing item in a pending bill. Use only when the user explicitly requests a quantity change.',

  parameters: {
    type: 'object',

    properties: {
      billId: {
        type: 'number',
        description: 'The pending bill ID'
      },

      sku: {
        type: 'string',
        description: 'SKU of the item'
      },

      qty: {
        type: 'number',
        description: 'The new exact quantity'
      }
    },

    required: ['billId', 'sku', 'qty']
  }
},
{
  type: 'function',

  name: 'remove_bill_item',

  description:
    'Remove a specific item from a pending bill.',

  parameters: {
    type: 'object',

    properties: {

      billId: {
        type: 'number',
        description: 'The pending bill ID'
      },

      sku: {
        type: 'string',
        description: 'SKU of the item to remove'
      }

    },

    required: ['billId', 'sku']

  }
},

// =====================================================
// KHATA TOOLS
// =====================================================

{
  type: 'function',

  name: 'add_khata_credit',

  description:
    'Add a manual amount to a customer\'s khata (credit ledger), NOT tied to a bill. Use this when the owner says to put money directly on a customer\'s credit outside of a purchase. Automatically creates the customer if they do not already exist. Do NOT use this for a bill purchase on credit — that goes through start_bill with paymentMode "credit" followed by finalize_bill.',

  parameters: {
    type: 'object',

    properties: {

      customerName: {
        type: 'string',
        description: 'The name of the customer, e.g. Ramesh.'
      },

      amount: {
        type: 'number',
        description: 'The credit amount in rupees to add.'
      },

      idempotencyKey: {
        type: 'string',
        description:
          'A unique identifier for this credit addition to prevent it from being applied twice.'
      },

      note: {
        type: 'string',
        description: 'Optional note about what this credit was for.'
      }

    },

    required: ['customerName', 'amount', 'idempotencyKey']
  }
},

{
  type: 'function',

  name: 'check_khata_balance',

  description:
    'Check a customer\'s current outstanding khata balance. Use this when the owner asks how much a customer owes.',

  parameters: {
    type: 'object',

    properties: {

      customerName: {
        type: 'string',
        description: 'The name of the customer, e.g. Ramesh.'
      }

    },

    required: ['customerName']
  }
},

{
  type: 'function',

  name: 'record_khata_payment',

  description:
    'Record a payment made by a customer against their outstanding khata balance. Use this when the owner says a customer paid an amount. The payment cannot exceed the customer\'s current outstanding balance. idempotencyKey prevents the same payment from being recorded twice if this call is retried.',

  parameters: {
    type: 'object',

    properties: {

      customerName: {
        type: 'string',
        description: 'The name of the customer, e.g. Ramesh.'
      },

      amount: {
        type: 'number',
        description: 'The payment amount in rupees.'
      },

      idempotencyKey: {
        type: 'string',
        description:
          'A unique identifier for this payment to prevent it from being recorded twice.'
      },

      note: {
        type: 'string',
        description: 'Optional note about this payment.'
      }

    },

    required: ['customerName', 'amount', 'idempotencyKey']
  }
},

// =====================================================
// SALES REPORT TOOL
// =====================================================

{
  type: 'function',

  name: 'get_sales_report',

  description:
    'Get the daily sales/business summary report, counting ONLY finalized (completed) bills — pending and cancelled bills are never included. Use this for requests like "today\'s sales", "daily sales report", "today\'s business summary", "how much did we sell today", "today\'s revenue", "show sales report", or "yesterday\'s sales". For "today", omit both period and date, or pass period "today". For "yesterday", pass period "yesterday". For a specific day like "sales report for 2026-09-01", pass date as "YYYY-MM-DD" instead of period.',

  parameters: {
    type: 'object',

    properties: {

      period: {
        type: 'string',
        description: 'Either "today" (default) or "yesterday". Omit this if a specific date is given instead.'
      },

      date: {
        type: 'string',
        description: 'An explicit date in YYYY-MM-DD format, e.g. "2026-09-01". Only use this when the user names a specific date. Do not combine with period.'
      }

    },

    required: []
  }
},

// =====================================================
// LOW STOCK / OUT OF STOCK TOOLS
// =====================================================

{
  type: 'function',

  name: 'get_low_stock_report',

  description:
    'List products at or below a low-stock threshold. Use for requests like "which products are low in stock", "show low stock items", "low stock report", "what needs restocking", "products running out of stock", "show products below 10 units", "show products below 5 units", or "which products have less than 8 units". If the user names a specific number, extract it and pass it as threshold (e.g. "below 5 units" -> threshold: 5, "less than 8 units" -> threshold: 8). If the user does not name a number, omit threshold entirely — it defaults to 10.',

  parameters: {
    type: 'object',

    properties: {

      threshold: {
        type: 'number',
        description: 'Show products with stock at or below this number. Omit to use the default of 10.'
      }

    },

    required: []
  }
},

{
  type: 'function',

  name: 'get_out_of_stock_report',

  description:
    'List products with zero stock. Use for requests like "which products are out of stock", "show out of stock items", or "what is unavailable". Takes no arguments.',

  parameters: {
    type: 'object',
    properties: {},
    required: []
  }
},

// =====================================================
// BUSINESS ANALYSIS PPTX TOOL
// =====================================================

{
  type: 'function',

  name: 'generate_business_report',

  description:
    'Generate a business analysis PowerPoint (.pptx) deck from real shop data — sales overview, sales trend, payment split, top-selling products, inventory analysis, and business insights, all computed only from finalized bills and current stock. Use for requests like "generate business report", "create sales presentation", "generate business analysis", "make me a PPT of the business", or "business analysis deck". Takes no arguments.',

  parameters: {
    type: 'object',
    properties: {},
    required: []
  }
},

// =====================================================
// STANDING PREFERENCE TOOLS (NEW)
// =====================================================

{
  type: 'function',

  name: 'set_user_preference',

  description:
    'Save a standing preference for THIS chat so it persists across all future messages, bot restarts, and /new chats. Use whenever the owner states a rule like "always assume UPI unless I say cash" (key: "default_payment_mode", value: "upi") or "default atta = Aashirvaad 5kg" (key: "preferred_brand", value: "Aashirvaad Atta 5kg"). You MUST call this tool to persist the preference — never just acknowledge such a statement in text without saving it.',

  parameters: {
    type: 'object',

    properties: {

      key: {
        type: 'string',
        description: 'The preference key, e.g. "default_payment_mode" or "preferred_brand".'
      },

      value: {
        type: 'string',
        description: 'The preference value, e.g. "upi" or "Maggi".'
      }

    },

    required: ['key', 'value']
  }
},

{
  type: 'function',

  name: 'set_shop_setting',

  description:
    'Save shop-wide identity info (name, address, phone, or gstin) which is applied automatically on every future PDF invoice and PPTX report. Use when the owner says things like "our shop GSTIN is..." or "set the shop name to...". You MUST call this tool — never just acknowledge it in text without saving it.',

  parameters: {
    type: 'object',

    properties: {

      field: {
        type: 'string',
        description: 'One of: name, address, phone, gstin'
      },

      value: {
        type: 'string'
      }

    },

    required: ['field', 'value']
  }
}

];


// =====================================================
// 4. REAL TOOL FUNCTIONS
// =====================================================
function addItemAlias(args) {

  return addBillItem(

    args.billId ||
    args.bill_id ||
    args.bill_number,

    args.sku ||
    args.item_id ||
    args.productId ||
    args.product_id,

    args.qty ||
    args.quantity

  );

}


const toolFunctions = {

  check_stock(args) {
    return checkStock(args.sku);
  },


  receive_stock(args) {
    return receiveStock(
      args.sku,
      args.name,
      args.qty,
      args.cost,
      args.mrp,
      args.unit,
      args.gst_slab,
      args.hsn,
      args.idempotencyKey || args.idempotency_key
    );
  },


  add_product(args) {
    return addProduct(
      args.sku,
      args.name,
      args.unit,
      args.gst_slab,
      args.mrp,
      args.hsn
    );
  },


  find_product(args) {
    return findProduct(args.productName);
  },


  start_bill(args, chatId) {
    return startBill(
      args.paymentMode || args.payment_mode,
      args.idempotencyKey || args.idempotency_key,
      args.customerName || args.customer_name || args.name,
      chatId
    );
  },


  // ==============================
  // BILL ITEM ALIASES
  // ==============================

  add_bill_item(args) {
    return addItemAlias(args);
  },


  add_item_to_bill(args) {
    return addItemAlias(args);
  },


  add_item(args) {
    return addItemAlias(args);
  },


  add_item_bill(args) {
    return addItemAlias(args);
  },


  add_item_to_cart(args) {
    return addItemAlias(args);
  },


  add_to_bill(args) {

    // Multiple items
    if (args.items) {

      const billId =
        args.billId ||
        args.bill_id ||
        args.bill_number;

      return args.items.map(item =>
        addBillItem(
          billId,

          item.sku ||
          item.item_id ||
          item.productId ||
          item.product_id,

          item.qty ||
          item.quantity
        )
      );
    }

    // Single item
    return addItemAlias(args);
  },


  add_items_to_bill(args) {

    const billId =
      args.billId ||
      args.bill_id ||
      args.bill_number;

    return args.items.map(item =>
      addBillItem(
        billId,

        item.sku ||
        item.item_id ||
        item.productId ||
        item.product_id,

        item.qty ||
        item.quantity
      )
    );
  },
get_bill(args) {

  return getBill(
    args.billId || args.bill_id || args.bill_number
  );

},
 get_bill_summary(args) {
    return getBill(
      args.billId || args.bill_id || args.bill_number
    );
  },
   remove_bill_item(args) {
  return removeBillItem(
    args.billId ?? args.bill_id,
    args.sku
  );
},

  // ==============================
  // FINALIZE BILL ALIASES
  // ==============================

  async finalize_bill(args, chatId) {

  const result = finalizeBill(
    args.billId ??
    args.bill_id ??
    args.bill_number
  );

  // -----------------------------------------------------
  // GST PDF INVOICE
  //
  // Only attempt this once the financial transaction has
  // actually succeeded (result.error is absent and a
  // bill_id came back — true both for a fresh finalize AND
  // for the "already finalized" idempotent-retry response).
  //
  // getOrCreateInvoicePdf() never re-runs billing logic —
  // it either resends an existing file or builds one from
  // the bill already committed in the database — so a
  // retried finalize_bill call can only ever resend the
  // same invoice, never double-bill or double-decrement
  // stock (that guarantee lives in finalizeBill() itself).
  //
  // A failure here (disk, Telegram, etc.) is logged and
  // swallowed rather than surfaced as a finalize_bill
  // error: the sale already happened and must not be
  // reported as failed, retried, or reversed just because
  // the PDF could not be generated or sent.
  // -----------------------------------------------------

  if (!result.error && result.bill_id) {

    try {

      const pdfPath = await getOrCreateInvoicePdf(result.bill_id);

      if (chatId != null) {

        await bot.sendDocument(
          chatId,
          pdfPath,
          {},
          {
            filename: `invoice-bill-${result.bill_id}.pdf`,
            contentType: 'application/pdf'
          }
        );

      }

    } catch (error) {

      console.error(
        'Invoice PDF generation/send failed:',
        error
      );

    }

  }

  return result;

},



  // =============================================
// CANCEL BILL
// =============================================

cancel_bill(args) {

  return cancelBill(

    args.billId ??
    args.bill_id ??
    args.bill_number

  );

},


// =============================================
// SET BILL ITEM QUANTITY
// =============================================

set_bill_item_quantity(args) {

  return setBillItemQuantity(

    args.billId ??
    args.bill_id ??
    args.bill_number,

    args.sku,

    args.qty ??
    args.quantity

  );
  

},

// =============================================
// KHATA TOOL FUNCTIONS
// =============================================

add_khata_credit(args) {
  return addKhataCredit(
    args.customerName ?? args.customer_name ?? args.name,
    args.amount,
    args.note,
    args.idempotencyKey ?? args.idempotency_key
  );
},

check_khata_balance(args) {
  return checkKhataBalance(
    args.customerName ?? args.customer_name ?? args.name
  );
},

record_khata_payment(args) {
  return recordKhataPayment(
    args.customerName ?? args.customer_name ?? args.name,
    args.amount,
    args.note,
    args.idempotencyKey ?? args.idempotency_key
  );
},

// =============================================
// SALES REPORT TOOL FUNCTION
// =============================================

get_sales_report(args) {
  return getSalesReport(args);
},

// =============================================
// LOW STOCK / OUT OF STOCK TOOL FUNCTIONS
// =============================================

get_low_stock_report(args) {
  return getLowStockReport(args && args.threshold);
},

get_out_of_stock_report() {
  return getOutOfStockReport();
},

// =============================================
// BUSINESS ANALYSIS PPTX TOOL FUNCTION
// =============================================

async generate_business_report(args, chatId) {

  try {

    const pptxPath = await generateBusinessReportPptx();

    if (chatId != null) {

      await bot.sendDocument(
        chatId,
        pptxPath,
        {},
        {
          filename: path.basename(pptxPath),
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        }
      );

    }

    return {
      message: 'Business analysis report generated and sent.',
      file: path.basename(pptxPath)
    };

  } catch (error) {

    console.error(
      'Business report generation/send failed:',
      error
    );

    return {
      error: 'Failed to generate the business report. Please try again.'
    };

  }

},

// =============================================
// STANDING PREFERENCE TOOL FUNCTIONS (NEW)
// =============================================

set_user_preference(args, chatId) {
  return setUserPreference(chatId, args.key, args.value);
},

set_shop_setting(args) {
  return setShopSetting(args.field, args.value);
},

};
// =====================================================
// 5. SYSTEM INSTRUCTION
// =====================================================

const BASE_SYSTEM_INSTRUCTION = `
You are an assistant running an Indian kirana grocery store through Telegram.

You have access to real store tools.

====================================================
IMPORTANT RULES
====================================================

1. Never invent stock numbers, prices, products, SKUs, bills,
bill items, GST, totals, or transaction results.

2. Only claim that an action was successful after the corresponding
tool returns a successful result.

3. If a tool returns an error:
- Stop the related workflow.
- Clearly report the actual error.
- Never pretend the action succeeded.

4. Use only the available tools.

5. Never generate a fake bill, invoice, receipt, GST calculation,
subtotal, or grand total.

6. Never invent a customer's khata balance or transaction history.
Only report values returned by check_khata_balance,
add_khata_credit, record_khata_payment, or finalize_bill.

====================================================
AVAILABLE BILLING TOOLS
====================================================

- start_bill
- find_product
- add_bill_item
- get_bill
- finalize_bill
- cancel_bill
- set_bill_item_quantity
- remove_bill_item
Tool purposes:

- start_bill: Create a new pending bill. If paymentMode is
  "credit", a customerName is required and the bill becomes
  linked to that customer.
- find_product: Find the exact product details and SKU using a product name.
- add_bill_item: Add a product to a pending bill.
- get_bill: View an existing bill and its items.
- finalize_bill: Finalize the bill, calculate GST, check stock,
  reduce stock, and return the final totals. If the bill is a
  credit bill, this also adds the grand total to the customer's
  khata balance, atomically, in the same step.
- remove_bill_item: Remove a product completely from a pending bill.

====================================================
CREDIT BILLS (BUYING ON KHATA)
====================================================

A customer can buy products and have the total added to their
khata instead of paying immediately. Example phrasings:

- "Create a bill for Ramesh: 2 Maggi packets on credit"
- "Make a credit bill for Ramesh with 2 Maggi and 1 Parle-G"
- "Put this bill on Ramesh's credit"

For a credit bill:

1. Use find_product for every product as usual.

2. Use start_bill with paymentMode set to "credit" AND
   customerName set to the customer's name.

3. If the user wants a credit bill but has NOT named a customer,
   do NOT call start_bill yet. Ask the user: "Whose khata should
   this bill be added to?" Do not guess or pick a customer.

4. Use add_bill_item as usual. The bill stays PENDING.

5. The khata balance is NOT affected while the bill is pending.
   Adding items, changing quantity, or removing items on a
   pending credit bill never changes the customer's khata.

6. Only when the user explicitly asks to finalize, complete, or
   finish the bill should you call finalize_bill. At that point,
   and only then, the grand total is added to the customer's
   khata balance automatically as part of finalizing — the tool
   does this for you. Report the khata balance using ONLY the
   "khata" field returned by finalize_bill, never a value you
   calculate yourself.

7. If the user cancels a pending credit bill with cancel_bill,
   nothing is added to khata and no khata transaction is created,
   regardless of what items were on the bill.

8. If finalize_bill is called again on a bill that is already
   finalized, it returns the previous result without adding
   anything to khata a second time — this is expected and correct.
   Do not attempt to re-finalize or re-credit manually.

====================================================
AVAILABLE KHATA (CUSTOMER CREDIT) TOOLS
====================================================

- add_khata_credit: Add a MANUAL amount to a customer's khata,
  NOT tied to any bill. Use only when the owner directly says to
  put an amount on someone's credit outside of a purchase (e.g.
  "put ₹500 on Ramesh's credit" with no products mentioned).
  Creates the customer automatically if they don't already exist.
  Do NOT use this tool for a bill purchase on credit — use
  start_bill + finalize_bill for that instead. Always generate a
  unique idempotencyKey, the same way you already do for
  start_bill, so the same credit is never applied twice if this
  call is retried.

- check_khata_balance: Check what a customer currently owes.
  Use when the owner asks something like "what's Ramesh's balance?"
  or "how much does Ramesh owe?". If the customer does not exist,
  report the error returned by the tool rather than guessing.
  A pending (not yet finalized) credit bill never affects this
  balance.

- record_khata_payment: Record a payment a customer makes against
  their khata balance. Use when the owner says something like
  "Ramesh paid ₹300". If the payment amount is more than the
  customer's current outstanding balance, the tool will return
  an error — report that error to the user rather than recording
  the payment anyway or adjusting the amount yourself. Always
  generate a unique idempotencyKey for this call, the same way
  you already do for start_bill, so the same payment is never
  recorded twice if this call is retried.

Always use the customer's name exactly as the owner said it.
Never invent a customer name, balance, or transaction that a
tool did not actually return.

====================================================
COMPLETE BILL WORKFLOW
====================================================

When the user asks to CREATE a bill, use the real billing
workflow using tools.

The workflow is:

1. Use find_product for every product when the user provides
   a product name instead of an SKU.

2. Use start_bill to create a pending bill. Include customerName
   if paymentMode is "credit".

3. Use add_bill_item for every product.

4. Keep the bill in PENDING status.

5. ONLY use finalize_bill when the user explicitly asks to:
   - Finalize the bill
   - Complete the bill
   - Finish billing
   - Generate the final receipt
====================================================
START BILL
====================================================

Use start_bill when creating a new customer bill.

Provide:

{
  "paymentMode": "cash",
  "idempotencyKey": "unique identifier"
}

Payment modes may include:

- cash
- upi
- card
- credit

If paymentMode is "credit", also provide customerName. If no
customer name has been given by the user, ask for it first
instead of calling start_bill.

====================================================
FIND PRODUCT
====================================================

When the user gives a product name such as:

- Parle-G
- Maggi
- Sugar
- Aashirvaad Atta

Use find_product to get the exact SKU and product details.

Use the SKU returned by find_product when adding the product
to a bill.

====================================================
ADD BILL ITEM
====================================================

To add a product to a bill, use ONLY:

add_bill_item

Use these arguments:

{
  "billId": number,
  "sku": string,
  "qty": number
}

For every product in the customer's request,
call add_bill_item separately.

Do not invent another tool name for adding items.

====================================================
BILL FINALIZATION RULE
====================================================

Do NOT automatically finalize a bill after adding items.

A bill must remain in PENDING status after:

- start_bill
- add_bill_item
- set_bill_item_quantity
- remove_bill_item

ONLY call finalize_bill when the user explicitly requests:

- Finalize the bill
- Complete the bill
- Finish the bill
- Generate the final receipt

If the user is still adding, changing, or removing items:

DO NOT call finalize_bill.

Once finalize_bill succeeds, the bill becomes FINALIZED.

A finalized bill cannot be modified.
Only after finalize_bill returns successfully may you:

- Show the bill
- Show GST
- Show CGST
- Show SGST
- Show subtotal
- Show grand total
- Show the updated khata balance (credit bills only, from the
  "khata" field in the result)
- Generate a receipt

Use ONLY the values returned by finalize_bill.

Never calculate GST, totals, or khata balances yourself.
====================================================
ERROR HANDLING
====================================================

If find_product fails:

- Stop.
- Report the actual error.

If start_bill fails:

- Stop.
- Report the actual error. If the error says a customer name is
  required, ask the user for it — do not guess a name.

If add_bill_item fails:

- Stop.
- Report the actual error.
- Do not finalize the bill.

If finalize_bill fails:

- Report the actual error.
- Do not create a receipt.
- If a credit bill's finalize fails for any reason, nothing was
  changed — stock was not deducted and khata was not credited.

If add_khata_credit, check_khata_balance, or record_khata_payment
fail:

- Stop.
- Report the actual error (for example, customer not found, or
  payment exceeds outstanding balance).
- Never adjust the amount or pretend it succeeded.

NEVER create a manual invoice when a billing tool fails.
====================================================
BILL QUANTITY CORRECTION AND CANCELLATION
====================================================

Use add_bill_item when adding a product to a bill.

Do NOT use add_bill_item to correct the quantity of a product
that is already on the bill.

To change an existing product quantity, use:

set_bill_item_quantity

This sets the exact final quantity and replaces the previous quantity.

To cancel a pending bill, use:

cancel_bill

billId is optional. If the user says "cancel the bill" / "cancel my
bill" without naming a bill number, call cancel_bill with NO billId
— the system will automatically resolve the single pending bill for
that Telegram chat, tell the user if there is no pending bill, or
ask which bill ID if there is more than one. Only pass billId when
the user names a specific bill number (e.g. "cancel bill 35").

Cancelling a credit bill never touches khata, regardless of what
items were on it.

====================================================
REMOVE BILL ITEM
====================================================

To remove a product completely from a PENDING bill, use:

remove_bill_item

Only remove an item when the user explicitly requests it.

Never remove an item from a finalized bill.


====================================================
HANDLING INSUFFICIENT STOCK ON FINALIZE
====================================================

If finalize_bill fails due to insufficient stock:

1. Tell the user exactly which product has insufficient stock
   and how many units are actually available.

2. Ask the user whether they want to:
   - Reduce the quantity, or
   - Cancel the bill.

3. IMPORTANT: After finalize_bill fails, DO NOT automatically
   call cancel_bill.

4. IMPORTANT: Wait for the user's explicit choice.

5. Only if the user explicitly asks to cancel:
   - Call cancel_bill.

6. Only if the user explicitly provides a new quantity:
   - Call set_bill_item_quantity with the corrected quantity.
   - Then retry finalize_bill.

Never cancel a bill without explicit user confirmation.
Never modify a bill quantity without explicit user confirmation.
CRITICAL CANCEL BILL RULE:

NEVER call cancel_bill automatically.

cancel_bill may ONLY be called when the user explicitly asks
to cancel the bill.

If finalize_bill fails because of insufficient stock:

1. Do NOT call cancel_bill automatically.
2. Do NOT modify the bill automatically.
3. Keep the bill pending.
4. Tell the user the actual available stock.
5. Ask the user whether they want to:
   - Reduce the quantity, or
   - Cancel the bill.

ONLY call set_bill_item_quantity if the user explicitly chooses
a new quantity.

ONLY call cancel_bill if the user explicitly says to cancel
the bill.

Never assume the user's choice.
====================================================
STOCK RULES
====================================================

If the user asks about stock:

- Use check_stock when the SKU is known.
- Use find_product first when only a product name is known.

Never invent stock quantities.

Always include the unit when reporting stock.

If the user says new stock arrived:

- Use receive_stock. Always generate a unique idempotencyKey for
  this call, the same way you already do for start_bill, so the
  same delivery is never recorded twice if this call is retried.

If the user wants to add a completely new product:

- Use add_product.

====================================================
LOW STOCK / OUT OF STOCK REPORTS
====================================================

Use get_low_stock_report for requests like:

- Which products are low in stock?
- Show low stock items
- Low stock report
- What needs restocking?
- Products running out of stock
- Show products below 10 units
- Show products below 5 units
- Which products have less than 8 units?

If the user names a specific number, extract it and pass it as
threshold. Otherwise omit threshold — it defaults to 10.

If get_low_stock_report returns total_low_stock > 0, format the
reply using ONLY the returned values, like this:

⚠️ LOW STOCK ALERT

<one line per product, in the order returned>: <emoji> <name> — <stock> <unit> left

Total products needing attention: <total_low_stock>

Use 🔴 for a product whose level is "critical" and 🟡 for a
product whose level is "warning" — use the level field returned
by the tool, do not judge this yourself.

If the user specified a custom threshold (not the default of
10), clearly state the threshold used, e.g. add
"(Threshold: ≤ 5 units)" next to the report title.

If get_low_stock_report returns total_low_stock = 0, reply:

✅ STOCK STATUS

All products currently have sufficient stock.
No products are below the low-stock threshold.

Use get_out_of_stock_report for requests like:

- Which products are out of stock?
- Show out of stock items
- What is unavailable?

If it returns total_out_of_stock > 0, format the reply using
ONLY the returned values, like this:

🚫 OUT OF STOCK

<one product name per line>

These products need immediate restocking.

If it returns total_out_of_stock = 0, reply clearly that all
products currently have stock available.

====================================================
STOCK AVAILABILITY RULE
====================================================

Before refusing a billing request due to stock:

Compare the requested quantity with the available stock.

- If available stock >= requested quantity:
  The item IS available.

  Continue creating the bill and adding the requested items.

  Keep the bill in PENDING status.

  ONLY finalize the bill when the user explicitly requests:
  - Finalize the bill
  - Complete the bill
  - Finish the bill
  - Generate the final receipt

- If available stock < requested quantity:
  The item is NOT available in the requested quantity.
  Follow the insufficient stock procedure.

Example:

Requested: 100
Available: 132

Since 132 >= 100, there is sufficient stock.
The bill MUST be created.

Never say that an item is unavailable when the available
stock is greater than or equal to the requested quantity.

====================================================
SALES REPORT
====================================================

Use get_sales_report for requests like:

- Today's sales
- Show today's sales
- Daily sales report
- Today's business summary
- How much did we sell today?
- Today's revenue
- Show sales report
- Yesterday's sales
- Sales report for YYYY-MM-DD

Only finalized (completed) bills are ever counted — pending
and cancelled bills are never included in this report.

Call get_sales_report with NO arguments (or period "today")
for "today". Use period "yesterday" for "yesterday". Use the
date argument (YYYY-MM-DD) only when the user names a specific
date.

If get_sales_report returns total_bills: 0, tell the user there
were no finalized sales for that date — do not invent numbers.

Format the report using ONLY the values returned by
get_sales_report, in this style:

📊 DAILY SALES REPORT
Date: <date, formatted DD-MM-YYYY>

🧾 Total Bills: <total_bills>
💰 Total Sales: ₹<total_sales>

💵 Cash Sales: ₹<cash_sales>
📒 Credit Sales: ₹<credit_sales>

🛒 Total Items Sold: <total_items_sold>

🧾 GST Summary:
GST: ₹<total_gst>
CGST: ₹<total_cgst>
SGST: ₹<total_sgst>

Never call get_sales_report to answer questions about a single
bill, a single customer's khata, or stock — it only reports
shop-wide finalized sales totals for one day.

====================================================
BUSINESS ANALYSIS REPORT (PPTX)
====================================================

Use generate_business_report for requests like:

- Generate business report
- Create sales presentation
- Generate business analysis
- Make me a PPT / PowerPoint of the business
- Business analysis deck / presentation

Call generate_business_report with NO arguments. It builds a
PowerPoint (.pptx) deck from real data (finalized bills, current
stock) and sends the file directly to this Telegram chat — you
do not need to attach or describe the file yourself.

After it succeeds, just confirm briefly, e.g.:
"📊 Business analysis report generated and sent above."

If it returns an error, tell the user the report could not be
generated and suggest trying again — do not invent report
contents yourself.

This tool is read-only: it never modifies bills, stock, or
khata, so it is safe to call as often as the user asks.

====================================================
STANDING PREFERENCES
====================================================

If the owner states a standing preference — a default payment
mode, a preferred brand, or shop details like name/address/
phone/GSTIN — you MUST call set_user_preference (for chat-level
preferences like default_payment_mode or preferred_brand) or
set_shop_setting (for shop-wide fields like name, address,
phone, gstin) to persist it BEFORE confirming to the user.

Never just say "Got it" or "Noted" in text without calling the
tool first. A preference is not considered saved until the tool
call succeeds — if it fails, report the actual error instead of
claiming it was saved.

====================================================
RESPONSE STYLE
====================================================

Keep responses short and practical.

After a successful stock operation,
report the actual result returned by the tool.

After a successful bill finalization,
show a simple receipt using ONLY values returned by finalize_bill.
For a credit bill, also show the updated khata balance using ONLY
the "khata" field from that same result.

If finalize_bill's result includes a non-empty low_stock_warnings
array, the bill still finalized successfully — show the receipt
as normal, and then, after it, show a low stock warning using
ONLY the values in low_stock_warnings, in this style (one block
per item in the array):

⚠️ LOW STOCK WARNING

<name> now has only <remaining_stock> <unit> remaining.
Please consider restocking.

Never let a low stock warning imply the sale was blocked or
should be reversed — low stock never prevents or undoes a sale
that already succeeded.

After a successful khata operation, report the customer name and
the actual balance value returned by the tool.

Never claim a bill was created unless start_bill succeeded.

Never claim an item was added unless add_bill_item succeeded.

Never claim a bill was finalized unless finalize_bill succeeded.

Never claim a khata credit, payment, or balance was correct unless
it came directly from a tool result.
`;

// =====================================================
// PERSISTENT PREFERENCES -> AGENT CONTEXT
//
// ROOT CAUSE of the "ignores saved default_payment_mode"
// bug: tools/preferences.js (setUserPreference /
// getUserPreference / getAllUserPreferences /
// getShopSettings) was never wired into bot.js at all — it
// wasn't required, wasn't a registered tool, and its values
// never appeared anywhere in systemInstruction. So Gemini had
// no way to know a preference existed; whatever it did with
// "credit" before was only it remembering something said
// earlier in that same chat's conversation, not an actual
// read of user_preferences. On a fresh chat (or a different
// chat_id, or after restart/context loss) there was nothing
// to fall back to, so it defaulted to "cash".
//
// FIX: build the system instruction dynamically per request,
// by loading this chat's row(s) from user_preferences (and
// the shop-wide row from shop_settings) fresh from SQLite
// every time, and appending them as an explicit block Gemini
// must follow. chat_id is passed in by the caller (runAgent)
// each time — never hardcoded here.
//
// SECOND FIX (this pass): Gemini also had no WAY to write a
// new preference — set_user_preference / set_shop_setting are
// now registered as real tools above (see section 3 and the
// STANDING PREFERENCES system-instruction block), so a
// statement like "always assume UPI unless I say cash" now
// results in an actual DB write, not just a confirming
// sentence with nothing behind it.
// =====================================================

function buildPreferencesBlock(chatId) {

  const prefsResult = getAllUserPreferences(chatId);
  const preferences = (prefsResult && prefsResult.preferences) || [];

  const shopSettings = getShopSettings() || {};

  const prefLines = preferences.length
    ? preferences
        .map(p => `- ${p.key}: ${p.value}`)
        .join('\n')
    : '(No saved preferences for this chat yet.)';

  const shopLines = ['name', 'address', 'phone', 'gstin']
    .filter(field => shopSettings[field])
    .map(field => `- ${field}: ${shopSettings[field]}`)
    .join('\n') || '(No shop settings saved yet.)';

  return `
====================================================
SAVED PREFERENCES FOR THIS CHAT (chat_id: ${chatId})
====================================================

These were loaded fresh from persistent storage for THIS
request, for THIS Telegram chat_id only. Treat them as
standing defaults the shop owner already told you — apply
them automatically, the same as if the owner had just said
them in this conversation.

${prefLines}

PAYMENT MODE RULE (applies to start_bill's paymentMode):

- If "default_payment_mode" is listed above AND the user's
  CURRENT message does not explicitly name a payment method
  (cash, UPI, card, or credit), use the saved
  default_payment_mode value — do not default to cash.
- If the user's CURRENT message DOES explicitly name a
  payment method, always use what the user said instead.
  An explicit instruction in the current message always
  overrides a saved preference.
- If no default_payment_mode is saved above and the user
  does not specify one either, ask the user which payment
  method to use instead of guessing "cash".
- If the resolved payment mode is "credit", the normal
  credit-bill rules still apply — customerName is required,
  so if none has been given yet, ask whose khata the bill
  should be added to instead of calling start_bill.

BRAND PREFERENCE RULE:

- If "preferred_brand" is listed above and the user asks for
  a product generically (e.g. "biscuits") without naming a
  brand, prefer that brand when using find_product, unless
  the user names a different brand explicitly in the current
  message.

====================================================
SHOP SETTINGS
====================================================

${shopLines}

These are shop-wide (not per-chat) and are already applied
automatically by invoice and report generation — you do not
need to pass them to any tool yourself.
`;

}

function buildSystemInstruction(chatId) {
  return BASE_SYSTEM_INSTRUCTION + buildPreferencesBlock(chatId);
}

// =====================================================
// RETRY HELPER FOR GEMINI API
// =====================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(apiCall, maxRetries = 6) {

  for (let attempt = 0; attempt <= maxRetries; attempt++) {

    try {
      return await apiCall();

    } catch (error) {

      const status = error.status || error.statusCode;

      const shouldRetry =
        status === 429 ||
        status === 500 ||
        status === 503;

      if (!shouldRetry) {
        throw error;
      }

      if (attempt === maxRetries) {
        console.log('Maximum retries reached.');
        throw error;
      }

      // Get Gemini's recommended retry time
      const message =
        error.message ||
        error.error?.message ||
        '';

      const match = message.match(
        /Please retry in ([\d.]+)s/
      );

      let delay;

      if (match) {

        // Use Gemini's exact retry time + 2 seconds buffer
        delay = Math.ceil(
          parseFloat(match[1]) * 1000
        ) + 2000;

      } else {

        // Fallback exponential backoff
        delay = Math.min(
          2000 * Math.pow(2, attempt),
          30000
        );

      }

      console.log(
        `Gemini API error ${status}. Retrying in ${Math.ceil(delay / 1000)} seconds...`
      );

      await sleep(delay);

    }
  }
}
// =====================================================
// CONVERSATION MEMORY
// =====================================================

// Stores the latest Gemini interaction for each Telegram chat
const chatInteractions = new Map();

// =====================================================
// PENDING CREDIT-BILL STATE
//
// Fixes the loop where start_bill fails with "A customer
// name is required to start a credit bill" and the bot asks
// the user "Whose khata should this bill be added to?" —
// previously the user's next reply (e.g. "Ramesh") was sent
// to Gemini as a brand-new, unrelated message and the
// original bill request was lost.
//
// When that specific error happens, runAgent() stops the
// tool-calling loop immediately (see below) instead of
// letting Gemini keep guessing, and records the ORIGINAL
// user text here, keyed by Telegram chat_id so one user's
// pending request can never leak into another chat's
// conversation.
//
// The next message the bot receives for that same chat_id
// is then treated as the customer name and combined with the
// original request before being sent to Gemini, so the bill
// (payment mode credit + items) is resumed instead of started
// over. See bot.on('message', ...) below.
// =====================================================
const pendingCreditBillRequests = new Map();

const CREDIT_CUSTOMER_NAME_REQUIRED_ERROR =
  'A customer name is required to start a credit bill. Ask the user whose khata this bill should be added to.';

// =====================================================
// 6. AGENT
// =====================================================

async function runAgent(userText, chatId) {

  console.log('Sending to Gemini:', userText);

  // ---------------------------------------------------
  // DETERMINISTIC EXPLICIT BILL FINALIZATION
  //
  // Commands like:
  // "Finalize bill 50"
  // "Complete bill 50"
  // "Finish bill #50"
  //
  // must NEVER go to Gemini first, because Gemini may
  // incorrectly create a new bill instead of finalizing
  // the requested bill.
  // ---------------------------------------------------

  const explicitFinalizeMatch = userText.match(
    /\b(?:finali[sz]e|complete|finish)\s+(?:the\s+)?bill\s*#?\s*(\d+)\b/i
  );

  if (explicitFinalizeMatch) {

    const billId = Number(explicitFinalizeMatch[1]);

    console.log(
      `[FINALIZE DIRECT] User explicitly requested finalization of bill #${billId}`
    );

    const result = await toolFunctions.finalize_bill(
      { billId },
      chatId
    );

    console.log(
      '[FINALIZE DIRECT] Result:',
      result
    );

    if (result && result.error) {

      return `Could not finalize bill #${billId}: ${result.error}`;

    }

    if (result && result.bill_id) {

      return `Bill #${result.bill_id} has been finalized successfully.`;

    }

    return `Bill #${billId} finalization was completed.`;

  }
  // ---------------------------------------------------
  // First interaction
  // ---------------------------------------------------

  const previousInteractionId = chatInteractions.get(chatId);

let interaction;

if (previousInteractionId) {

  interaction = await withRetry(() =>
    ai.interactions.create({

      model: 'gemini-3.5-flash-lite',

      previous_interaction_id: previousInteractionId,

      input: userText,

      tools: tools,

      system_instruction: buildSystemInstruction(chatId)

    })
  );

} else {

  interaction = await withRetry(() =>
    ai.interactions.create({

      model: 'gemini-3.5-flash-lite',

      input: userText,

      tools: tools,

      system_instruction: buildSystemInstruction(chatId)

    })
  );

}


  // ---------------------------------------------------
  // Function calling loop
  // ---------------------------------------------------

  // Generic loop guard: if the exact same tool is called with
  // the exact same arguments more than once *and* it errored
  // last time, Gemini is stuck retrying something that clearly
  // needs the user's input instead. Tracked only for the
  // duration of this single runAgent() call (i.e. this one
  // incoming message), never across turns.
  const failedCallSignatures = new Set();

  while (true) {

    console.log(
      'Gemini interaction:',
      interaction.id
    );


    // Find function calls

    const functionCalls = interaction.steps.filter(
      step => step.type === 'function_call'
    );


    // -------------------------------------------------
    // No function call
    // -------------------------------------------------

    if (functionCalls.length === 0) {

      console.log(
        'Gemini final response:',
        interaction.output_text
      );
      chatInteractions.set(chatId, interaction.id);

      return interaction.output_text || '(no reply)';

    }


    // -------------------------------------------------
    // Execute functions
    // -------------------------------------------------

    const functionResults = [];


    for (const call of functionCalls) {

      console.log(
        'Gemini requested tool:',
        call.name
      );

      console.log(
        'Arguments:',
        call.arguments
      );
      let result;
      
      // Prevent Gemini from automatically cancelling a bill.
// Cancellation must be explicitly requested by the user.
if (call.name === 'cancel_bill') {

  // ===== TEMP DEBUG: remove after diagnosis =====
  console.log('[CANCEL-DEBUG] chatId:', chatId, '(type:', typeof chatId, ')');
  console.log('[CANCEL-DEBUG] userText:', JSON.stringify(userText));
  console.log('[CANCEL-DEBUG] call.arguments:', JSON.stringify(call.arguments));
  // ===== END TEMP DEBUG =====

  const userExplicitlyCancelled =
    /\b(cancel|cancel the bill|cancel bill|discard the bill)\b/i.test(userText);

  if (!userExplicitlyCancelled) {

    // ===== TEMP DEBUG: remove after diagnosis =====
    console.log('[CANCEL-DEBUG] branch chosen: BLOCKED_NOT_EXPLICIT');
    // ===== END TEMP DEBUG =====

    result = {
      error:
        'Cancellation blocked. The user has not explicitly requested to cancel the bill. Ask the user whether they want to change the quantity or cancel.'
    };

    console.log('Tool result:', result);

    functionResults.push({
      type: 'function_result',
      name: call.name,
      call_id: call.id,
      result: [
        {
          type: 'text',
          text: JSON.stringify(result)
        }
      ]
    });

    continue;
  }

  // -----------------------------------------------------
  // Resolve WHICH bill to cancel.
  //
  // If Gemini (or the user) gave an explicit bill ID, use
  // it — this preserves the existing "cancel bill 35" flow
  // untouched.
  //
  // If no bill ID was given, look up pending bills for this
  // Telegram chat only:
  //   - exactly one pending bill  -> auto-resolve it
  //   - no pending bills          -> tell the user, don't cancel
  //   - multiple pending bills    -> ask which one, don't guess
  // -----------------------------------------------------

  const explicitBillId =
    call.arguments.billId ??
    call.arguments.bill_id ??
    call.arguments.bill_number;

  // ===== TEMP DEBUG: remove after diagnosis =====
  console.log('[CANCEL-DEBUG] explicitBillId from Gemini args:', explicitBillId);
  // ===== END TEMP DEBUG =====

  let resolvedBillId = explicitBillId;

  if (resolvedBillId == null) {

    const pendingBills = getPendingBillsByChat(chatId);

    // ===== TEMP DEBUG: remove after diagnosis =====
    console.log('[CANCEL-DEBUG] pending bills found for this chatId:', JSON.stringify(pendingBills));
    console.log('[CANCEL-DEBUG] pending bill count:', pendingBills.length);
    // ===== END TEMP DEBUG =====

    if (pendingBills.length === 0) {

      // ===== TEMP DEBUG: remove after diagnosis =====
      console.log('[CANCEL-DEBUG] branch chosen: NO_PENDING_BILLS');
      // ===== END TEMP DEBUG =====

      result = {
        message: 'There is no pending bill to cancel right now.'
      };

      console.log('Tool result:', result);

      functionResults.push({
        type: 'function_result',
        name: call.name,
        call_id: call.id,
        result: [
          {
            type: 'text',
            text: JSON.stringify(result)
          }
        ]
      });

      continue;

    } else if (pendingBills.length > 1) {

      // ===== TEMP DEBUG: remove after diagnosis =====
      console.log('[CANCEL-DEBUG] branch chosen: MULTIPLE_PENDING_ASK_USER');
      // ===== END TEMP DEBUG =====

      result = {
        message:
          `You have ${pendingBills.length} pending bills: ` +
          `${pendingBills.map(b => b.id).join(', ')}. ` +
          `Which bill ID would you like to cancel?`,
        pending_bill_ids: pendingBills.map(b => b.id)
      };

      console.log('Tool result:', result);

      functionResults.push({
        type: 'function_result',
        name: call.name,
        call_id: call.id,
        result: [
          {
            type: 'text',
            text: JSON.stringify(result)
          }
        ]
      });

      continue;

    } else {

      // ===== TEMP DEBUG: remove after diagnosis =====
      console.log('[CANCEL-DEBUG] branch chosen: AUTO_RESOLVED_SINGLE_PENDING');
      // ===== END TEMP DEBUG =====

      resolvedBillId = pendingBills[0].id;

    }
  } else {

    // ===== TEMP DEBUG: remove after diagnosis =====
    console.log('[CANCEL-DEBUG] branch chosen: EXPLICIT_BILL_ID_FROM_GEMINI');
    // ===== END TEMP DEBUG =====

  }

  // ===== TEMP DEBUG: remove after diagnosis =====
  console.log('[CANCEL-DEBUG] final resolvedBillId passed to cancelBill:', resolvedBillId);
  // ===== END TEMP DEBUG =====

  result = cancelBill(resolvedBillId);

  console.log('Tool result:', result);

  functionResults.push({
    type: 'function_result',
    name: call.name,
    call_id: call.id,
    result: [
      {
        type: 'text',
        text: JSON.stringify(result)
      }
    ]
  });

  continue;
}
// Prevent Gemini from automatically finalizing a bill.
// Finalization must be explicitly requested by the user.
if (call.name === 'finalize_bill') {

  const userExplicitlyFinalized =
    /\b(finalize|complete|finish)\b/i.test(userText) ||
    /generate\s+(the\s+)?(final\s+)?receipt/i.test(userText);

  if (!userExplicitlyFinalized) {

    result = {
      error:
        'Finalization blocked. The user has not explicitly asked to finalize, complete, or finish the bill. Keep the bill pending and tell the user its current status instead.'
    };

    console.log('Tool result:', result);

    functionResults.push({
      type: 'function_result',
      name: call.name,
      call_id: call.id,
      result: [
        {
          type: 'text',
          text: JSON.stringify(result)
        }
      ]
    });

    continue;
  }
}

      const fn = toolFunctions[call.name];

if (!fn) {

  result = {
    error: `Unknown tool: ${call.name}`
  };

} else {

  try {

    // ==========================================
    // ENFORCE SAVED PAYMENT PREFERENCE
    // ==========================================
    if (call.name === 'start_bill') {

      const text = userText.toLowerCase();

      // Check if user explicitly mentioned a payment mode
      let explicitPaymentMode = null;

      if (/\bcash\b/i.test(text)) {
        explicitPaymentMode = 'cash';
      } else if (/\bupi\b/i.test(text)) {
        explicitPaymentMode = 'upi';
      } else if (/\bcard\b/i.test(text)) {
        explicitPaymentMode = 'card';
      } else if (/\bcredit\b/i.test(text)) {
        explicitPaymentMode = 'credit';
      }

      // -----------------------------------------------------
      // Load saved preferences for this Telegram user.
      //
      // FIX: getAllUserPreferences(chatId) returns an OBJECT
      // shaped { preferences: [ {key, value}, ... ] }, not an
      // array. The previous code did
      // `Array.isArray(preferences) ? ... : null`, which was
      // always false for this wrapper object, so
      // savedPreference was unconditionally null regardless of
      // what SQLite actually had stored (confirmed by the
      // "[PAYMENT DEBUG] Saved preference: undefined" bug
      // report even though Raw preferences clearly contained
      // default_payment_mode: 'credit'). Unwrap it the same
      // way buildPreferencesBlock() above already does.
      // -----------------------------------------------------
      const prefsResult = getAllUserPreferences(chatId);
      const preferences = (prefsResult && prefsResult.preferences) || [];

console.log(
  '[PAYMENT DEBUG] Raw preferences:',
  prefsResult
);

const savedPreference = preferences.find(
  pref => pref.key === 'default_payment_mode'
);

const savedPaymentMode = savedPreference
  ? savedPreference.value
  : undefined;

      // Explicit user instruction has highest priority
      const resolvedPaymentMode =
        explicitPaymentMode ||
        savedPaymentMode ||
        call.arguments.paymentMode;

      console.log(
        '[PAYMENT DEBUG] chatId:',
        chatId
      );

      console.log(
        '[PAYMENT DEBUG] Saved preference:',
        savedPaymentMode
      );

      console.log(
        '[PAYMENT DEBUG] Explicit payment:',
        explicitPaymentMode
      );

      console.log(
        '[PAYMENT DEBUG] Gemini requested:',
        call.arguments.paymentMode
      );

      console.log(
        '[PAYMENT DEBUG] Final resolved:',
        resolvedPaymentMode
      );

      // Force the correct payment mode
      call.arguments.paymentMode = resolvedPaymentMode;

    }

    result = await fn(call.arguments, chatId);

  } catch (error) {

    console.error(
      'Tool execution error:',
      error
    );

    result = {
      error: error.message
    };

  }

}


      // ---------------------------------------------------
      // CREDIT BILL: missing customer name
      //
      // start_bill enforces this at the tool layer. Instead of
      // sending the error back to Gemini and letting it keep
      // retrying (this is what previously caused an infinite
      // start_bill loop), stop the agent loop immediately: save
      // the ORIGINAL user request for this chat_id and hand
      // back one fixed question. The next message from this
      // same chat_id is then treated as the customer name and
      // combined with the original request — see
      // bot.on('message', ...) below.
      // ---------------------------------------------------
      if (
        call.name === 'start_bill' &&
        result &&
        result.error === CREDIT_CUSTOMER_NAME_REQUIRED_ERROR
      ) {

        pendingCreditBillRequests.set(chatId, {
          originalUserText: userText,
          createdAt: Date.now()
        });

        // Deliberately NOT calling chatInteractions.set(...) here.
        // This leaves this chat's Gemini conversation pointer at
        // whatever it was BEFORE this incomplete attempt (not
        // deleted — just not advanced), so the next message,
        // combined with the customer name, resumes from clean
        // context instead of continuing a dangling function call
        // that never received a real result.

        return 'Your default payment method is Credit. Whose khata should this bill be added to?';

      }


      // ---------------------------------------------------
      // Generic repeat-call guard
      //
      // If a tool call errors, and the exact same tool is called
      // again with the exact same arguments and it errors again,
      // Gemini is stuck retrying something that clearly needs the
      // user's input. Stop instead of looping indefinitely.
      // ---------------------------------------------------
      if (result && result.error) {

        const callSignature =
          `${call.name}:${JSON.stringify(call.arguments)}`;

        if (failedCallSignatures.has(callSignature)) {

          console.log(
            'Stopping agent loop: identical tool call failed twice:',
            callSignature
          );

          return (
            'I ran into the same issue trying to complete that ' +
            `automatically (${result.error}). Could you clarify ` +
            'what you\'d like me to do?'
          );

        }

        failedCallSignatures.add(callSignature);

      }


      console.log(
        'Tool result:',
        result
      );


      functionResults.push({

        type: 'function_result',

        name: call.name,

        call_id: call.id,

        result: [
          {
            type: 'text',
            text: JSON.stringify(result)
          }
        ]

      });

    }


    // -------------------------------------------------
    // Send results back to Gemini
    // -------------------------------------------------

    // Send results back to Gemini

interaction = await withRetry(() =>
  ai.interactions.create({

    model: 'gemini-3.5-flash-lite',

    previous_interaction_id: interaction.id,

    input: functionResults,

    tools: tools

  })
);

  }

}


// =====================================================
// 7. TELEGRAM MESSAGE HANDLER
// =====================================================

bot.on('message', async (msg) => {

  if (!msg.text) {
    return;
  }


  // -----------------------------------------------------
  // TELEGRAM UPDATE IDEMPOTENCY
  //
  // If this exact update_id has already been processed
  // (e.g. Telegram redelivered it after a bot restart),
  // ignore it completely — no reply, no tool calls, no
  // business logic. INSERT OR IGNORE against the PRIMARY
  // KEY is atomic: changes === 0 means it was already there.
  // -----------------------------------------------------

  if (msg.update_id != null) {

    const insertResult = db.prepare(`
      INSERT OR IGNORE INTO processed_updates (update_id)
      VALUES (?)
    `).run(msg.update_id);

    if (insertResult.changes === 0) {

      console.log(
        `Ignoring duplicate Telegram update_id ${msg.update_id} (already processed).`
      );

      return;

    }

  }


  console.log(
    `User ${msg.chat.id}: ${msg.text}`
  );


  try {

    if (!ai) {

      await bot.sendMessage(
        msg.chat.id,
        'Bot is still starting. Please try again.'
      );

      return;

    }


    // -----------------------------------------------------
    // PENDING CREDIT-BILL STATE
    //
    // If this chat_id is awaiting a customer name for a credit
    // bill (see the start_bill error handling in runAgent),
    // treat THIS message as that customer name and splice it
    // back into the ORIGINAL request instead of sending it to
    // Gemini as a brand-new, unrelated message. Scoped strictly
    // per chat_id, so it can never affect another chat.
    // -----------------------------------------------------

    let effectiveText = msg.text;

    const pendingCreditBill = pendingCreditBillRequests.get(msg.chat.id);

    if (pendingCreditBill) {

      pendingCreditBillRequests.delete(msg.chat.id);

      const customerName = msg.text.trim();

      effectiveText =
        `${pendingCreditBill.originalUserText} ` +
        `(payment mode: credit, customer name: "${customerName}")`;

      console.log(
        `Resuming pending credit bill for chat ${msg.chat.id} with customer "${customerName}"`
      );

    }

    const reply = await runAgent(
  effectiveText,
  msg.chat.id
);


    await bot.sendMessage(
      msg.chat.id,
      reply
    );


  } catch (error) {

    console.error(
      'ERROR:',
      error
    );


    await bot.sendMessage(
      msg.chat.id,
      'Something went wrong. Check the server logs.'
    );

  }

});


// =====================================================
// 8. START BOT
// =====================================================

initializeGemini()

  .then(() => {

    console.log('Gemini initialized');

    console.log('Bot is running...');

  })

  .catch((error) => {

    console.error(
      'Gemini initialization failed:',
      error
    );

  });