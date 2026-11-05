const { createClient } = require("@libsql/client");

// Connects to Turso cloud in production, or falls back to local file for testing
const db = createClient({
    url: process.env.DATABASE_URL || "file:data.db",
    authToken: process.env.DATABASE_AUTH_TOKEN,
});

// Initialize tables asynchronously
async function initDb() {
    await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
        user_key TEXT PRIMARY KEY,
        balance REAL NOT NULL DEFAULT 0
    );
  `);

    await db.execute(`
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
  `);

    await db.execute(`
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
}

initDb().catch(err => console.error("Database initialization error:", err));

module.exports = db;