const db = require("./db");

console.log("\n=== USER PREFERENCES ===");
console.log(db.prepare("SELECT * FROM user_preferences").all());

console.log("\n=== SHOP SETTINGS ===");
console.log(db.prepare("SELECT * FROM shop_settings").all());

console.log("\n=== PREFERENCES ===");
console.log(db.prepare("SELECT * FROM preferences").all());