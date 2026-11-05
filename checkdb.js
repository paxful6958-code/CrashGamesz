// checkdb.js
const db = require("./db"); // same module your server uses

console.log("=== LAST 5 DEPOSITS ===");
const deposits = db.prepare(
    "SELECT reference, provider_ref, amount, status, created_at FROM deposits ORDER BY id DESC LIMIT 5"
).all();
console.table(deposits);

console.log("=== USER BALANCES ===");
const users = db.prepare(
    "SELECT user_key, balance FROM users ORDER BY user_key LIMIT 10"
).all();
console.table(users);