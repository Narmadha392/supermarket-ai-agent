# 🛒 Supermarket AI Agent

A Telegram-based supermarket management system that uses natural language and AI to handle everyday shop operations such as billing, inventory checking, customer credit (khata), payment preferences, and invoice generation.

The goal of this project is to make supermarket operations easier by allowing the user to interact with the system using normal messages instead of filling out multiple forms.

---

## 📌 Project Overview

The user communicates with the supermarket system through Telegram.

For example:

```text
Create a bill with 1 Maggi packet
````

The AI agent understands the request and uses backend tools to perform the required operations.

```text
User Message
     ↓
Telegram Bot
     ↓
AI Agent
     ↓
Business Tools
     ↓
SQLite Database
     ↓
Bill / Stock / Khata / Invoice
```

The AI is mainly responsible for understanding the user's request and selecting the appropriate tools. Important business rules such as stock validation and bill finalization are handled by the backend.

---
## 🎥 Demo Video

[▶ Watch the complete project demo](https://www.loom.com/share/387724771fcb4540a22093a864c5f9f5)

---

## ✨ Features

### 🧾 Billing

The system can handle billing operations using natural language.

Examples include:

* Creating a bill
* Adding products to a bill
* Creating pending bills
* Viewing bill information
* Finalizing bills
* Generating invoices

Example:

```text
Create a bill with 1 Maggi packet
```

Bills are created first and important actions such as finalization are handled separately.

---

### 💳 Payment Methods

The system supports different payment methods, including:

* Cash
* UPI
* Card
* Credit

Users can also save a default payment preference.

Example:

```text
Remember my default payment method is Credit
```

When creating a future bill, the saved preference can be used automatically.

An explicit instruction from the user can override the saved preference:

```text
Create a cash bill with 1 Maggi packet
```

---

## 📒 Customer Khata Management

Credit bills can be associated with a customer.

For example, when a credit bill is created without customer information, the bot can ask:

```text
Whose khata should this bill be added to?
```

Example response:

```text
Ramesh
```

The khata system can be used for operations such as:

* Checking customer balances
* Managing credit bills
* Recording customer payments
* Updating outstanding balances

---

## 📦 Inventory Management

The project also includes inventory-related operations.

These include:

* Checking product stock
* Searching for products
* Receiving stock
* Checking low-stock items
* Checking out-of-stock items

Example:

```text
Check stock of Maggi
```

The system returns the currently available stock.

---

## 🛡️ Stock Validation

One important business rule in the project is preventing bills from being finalized when sufficient stock is not available.

For example:

```text
Available Stock: 35

Requested Quantity: 100
```

The bill cannot be finalized because the requested quantity is greater than the available stock.

Example result:

```text
Could not finalize bill: Insufficient stock.

Available: 35
Requested: 100
```

This prevents the system from reducing inventory below zero.

---

## 🧾 GST Billing

The billing system supports GST-related calculations.

Generated invoices can include:

* Taxable value
* GST percentage
* CGST
* SGST
* Grand total

GST values are calculated using product information stored in the database.

---

## 🧠 Persistent Preferences

Some user preferences can be stored in the SQLite database.

Examples:

```text
Remember my default payment method is Credit
```

```text
Remember that my preferred brand is Maggi
```

```text
Set shop name to Narmadha Supermarket
```

Because these preferences are stored in the database, they can persist beyond a normal conversation.

---

## 📄 Invoice Generation

After a bill is successfully finalized, the system can generate an invoice.

The invoice contains important billing information such as:

* Bill number
* Customer name
* Products
* Quantity
* Price
* GST details
* Payment type
* Grand total

Example:

```text
Invoice No: 50
Customer: Ramesh
Payment Type: Credit
Grand Total: Rs.14.00
```

---

## 🧠 How the AI Agent Works

The system follows this general flow:

```text
User sends a message on Telegram
              ↓
AI understands the request
              ↓
Appropriate backend tool is selected
              ↓
Database operation is performed
              ↓
Business rules are validated
              ↓
Result is sent back to the user
```

For example:

```text
Create a bill with 1 Maggi packet
```

The system can:

1. Find the product
2. Check the product details
3. Create a pending bill
4. Apply the payment preference
5. Ask for customer information if required
6. Validate stock during finalization
7. Update the database
8. Generate an invoice

---

## 🔐 Important Business Rules

The project separates AI-based language understanding from critical backend validation.

The backend is responsible for important operations such as:

* Stock validation
* Bill finalization
* GST calculation
* Database updates
* Khata updates

This means the AI does not directly bypass important business rules.

Some examples of protected operations are:

* Stock should not become negative
* Insufficient stock should block bill finalization
* Important billing actions require user intent
* Database-backed tools provide the actual business data

---

## 🏗️ Technology Stack

| Technology       | Purpose                                               |
| ---------------- | ----------------------------------------------------- |
| Node.js          | Application runtime                                   |
| JavaScript       | Application logic                                     |
| Telegram Bot API | User interaction                                      |
| Google Gemini    | Natural language understanding and tool orchestration |
| SQLite           | Database and persistent storage                       |
| dotenv           | Environment variable configuration                    |
| PDF Generation   | Invoice generation                                    |
| PPTX Generation  | Business reports                                      |

---

## 📁 Project Structure

```text
supermarket-agent/
│
├── invoices/              # Generated invoices
├── reports/               # Generated reports
├── tools/                 # Business logic tools
│
├── bot.js                 # Telegram bot and AI integration
├── db.js                  # Database setup and operations
├── check.js               # Project checking/testing utilities
├── package.json           # Project dependencies
├── package-lock.json
├── shop.db                # SQLite database
├── README.md
└── .env                   # Environment variables
```

> The `tools` folder contains the backend functions used by the AI agent for supermarket operations.

---

## ⚙️ Installation

### 1. Clone or download the project

Open the project folder in VS Code.

---

### 2. Install dependencies

Run:

```bash
npm install
```

---

### 3. Configure environment variables

Create a `.env` file in the project folder.

Add your required credentials:

```env
TELEGRAM_TOKEN=your_telegram_bot_token
GEMINI_API_KEY=your_gemini_api_key
```

Do not share your actual API keys publicly.

---

### 4. Start the application

Run:

```bash
node bot.js
```

Once the bot starts successfully, you can interact with it through Telegram.

---

## 💬 Example Commands

Here are some example messages that can be tested with the bot:

```text
Create a bill with 1 Maggi packet
```

```text
Check stock of Maggi
```

```text
Remember my default payment method is Credit
```

```text
Create a cash bill with 1 Maggi packet
```

```text
Finalize bill 50
```

These examples demonstrate how the project uses natural language as the interface for supermarket operations.

---

## 🧪 Tested Scenarios

The following scenarios were tested during development:

| Scenario                         | Status   |
| -------------------------------- | -------- |
| Default payment preference       | ✅ Tested |
| Explicit payment method override | ✅ Tested |
| Credit bill customer flow        | ✅ Tested |
| Stock checking                   | ✅ Tested |
| Product not found handling       | ✅ Tested |
| Insufficient stock protection    | ✅ Tested |
| Bill finalization                | ✅ Tested |
| GST calculation                  | ✅ Tested |
| Invoice generation               | ✅ Tested |
| Persistent preferences           | ✅ Tested |

### Example Stock Protection Test

```text
Available stock: 35 Maggi packets

Requested: 100 Maggi packets
```

Result:

```text
Bill finalization blocked due to insufficient stock.
```

This test confirms that inventory is validated before the bill is finalized.

---

## 📸 Screenshots


* Credit bill flow
* Stock checking
* invoice

Example:

```text
screenshots/
├── billing-flow.png
├── stock-check.png
└── invoice.png
```

---

## ⚙️ Design Decisions

### AI for understanding, backend for validation

The AI agent is used to understand natural language requests and choose the appropriate business tools.

Critical operations are still validated by backend code.

This approach helps prevent the AI from directly making unsafe database changes.

### Database-backed preferences

User preferences are stored in SQLite instead of depending completely on conversation memory.

This allows preferences to persist and be reused later.

### Stock validation before finalization

Inventory is checked before a bill is finalized.

If sufficient stock is unavailable, the finalization process is blocked.

---

## 🔮 Future Improvements

Possible improvements for the project include:

* Barcode scanning
* Supplier management
* Purchase orders
* Multi-shop support
* Web dashboard
* WhatsApp integration
* Sales forecasting
* Automatic restocking suggestions
* Employee roles and permissions

---

## 👩‍💻 Author

**Narmadha**

---

## 🏁 Conclusion

Supermarket AI Agent is a project that combines natural language interaction with practical supermarket business operations.

Instead of using multiple forms and menus, the user can interact with the system through Telegram using normal language.

The overall approach is:

```text
Natural Language
       ↓
AI Agent
       ↓
Backend Business Tools
       ↓
Database Validation
       ↓
Supermarket Operation
```

The project demonstrates how AI can be used as a user-friendly interface while important business rules remain controlled by backend logic.




