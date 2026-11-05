const Database = require("better-sqlite3");
const db = new Database("./data.db");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    user_key TEXT PRIMARY KEY,
    balance REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT NOT NULL,
    reference TEXT UNIQUE NOT NULL,
    provider_ref TEXT,
    mpesa_receipt TEXT,
    phone TEXT,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key TEXT NOT NULL,
    reference TEXT UNIQUE NOT NULL,
    method TEXT NOT NULL,
    amount REAL NOT NULL,
    destination TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);
`);

module.exports = db;