const express = require("express");
const axios = require("axios");
const db = require("../db");

const router = express.Router();

const PAYHERO_BASE_URL = "https://backend.payhero.co.ke/api/v2";
const { PAYHERO_API_USERNAME, PAYHERO_API_PASSWORD, PAYHERO_CHANNEL_ID } = process.env;

if (!PAYHERO_API_USERNAME || !PAYHERO_API_PASSWORD || !PAYHERO_CHANNEL_ID) {
    console.warn("⚠️ PayHero credentials missing in .env");
}

const payheroAuth = {
    username: PAYHERO_API_USERNAME,
    password: PAYHERO_API_PASSWORD
};

function isValidKenyanPhone(phone) {
    return typeof phone === "string" && /^254(7|1)\d{8}$/.test(phone);
}

/* ============ GET BALANCE ============ */
router.get("/balance", (req, res) => {
    const userKey = String(req.query.key || "").trim();
    if (!userKey) return res.status(400).json({ success: false, message: "key required" });

    let row = db.prepare("SELECT balance FROM users WHERE user_key = ?").get(userKey);
    if (!row) {
        db.prepare("INSERT OR IGNORE INTO users (user_key, balance) VALUES (?, 0)").run(userKey);
        row = { balance: 0 };
    }
    res.json({ success: true, balance: row.balance });
});

/* ============ STK PUSH ============ */
router.post("/stk-push", async(req, res) => {
    try {
        const { phone_number, amount, user_key } = req.body;

        if (!user_key) return res.status(400).json({ success: false, message: "user_key required" });
        if (!phone_number || !amount) {
            return res.status(400).json({ success: false, message: "Phone number and amount are required" });
        }

        const phone = String(phone_number).replace(/\D/g, "");
        if (!isValidKenyanPhone(phone)) {
            return res.status(400).json({ success: false, message: "Invalid phone number." });
        }

        const numericAmount = Number(amount);
        if (!Number.isInteger(numericAmount) || numericAmount < 1) {
            return res.status(400).json({ success: false, message: "Amount must be a positive whole number (KES)." });
        }

        // ensure user row exists
        db.prepare("INSERT OR IGNORE INTO users (user_key, balance) VALUES (?, 0)").run(user_key);

        const reference = `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

        // record pending deposit FIRST
        db.prepare(
            `INSERT INTO deposits (user_key, reference, phone, amount, status) VALUES (?, ?, ?, ?, 'pending')`
        ).run(user_key, reference, phone, numericAmount);

        const payload = {
            amount: numericAmount,
            phone_number: phone,
            channel_id: PAYHERO_CHANNEL_ID,
            provider: "m-pesa",
            external_reference: reference,
            callback_url: process.env.PAYHERO_CALLBACK_URL || "https://yourdomain.com/api/payhero/payhero-callback",
            metadata: { source: "crashgame-web-deposit", user_key, reference }
        };

        const response = await axios.post(`${PAYHERO_BASE_URL}/payments`, payload, {
            auth: payheroAuth,
            timeout: 30000
        });

        // DEBUG: log the FULL PayHero response so we can see the exact field names
        console.log("PayHero STK response:", JSON.stringify(response.data));

        // PayHero STK response shape (verified live):
        // { success, status: "QUEUED", reference: "bfe8-...", CheckoutRequestID: "ws_CO_...", external_reference: "TXN-..." }
        // /transaction-status must be queried with PayHero's OWN "reference" (or CheckoutRequestID),
        // NOT our TXN-... external reference.
        const d = response.data || {};
        const inner = d.data || {};
        const providerRef =
            d.reference || inner.reference ||
            d.CheckoutRequestID || inner.CheckoutRequestID ||
            d.merchant_reference || inner.merchant_reference ||
            null;

        db.prepare("UPDATE deposits SET provider_ref = ? WHERE reference = ?").run(providerRef, reference);

        console.log(`STK push queued | ref=${reference} | provider_ref=${providerRef}`);

        return res.json({
            success: true,
            message: "STK Push sent successfully.",
            data: { reference, provider_ref: providerRef }
        });

    } catch (error) {
        const errorMessage =
            (error.response && error.response.data && error.response.data.message) ||
            (error.response && error.response.data && error.response.data.errorMessage);
        console.error("STK ERROR:", errorMessage || error.message);
        return res.status(error.response && error.response.status === 400 ? 400 : 500).json({
            success: false,
            message: errorMessage || "Payment initiation failed"
        });
    }
});

/* ============================================================
   RECONCILIATION — query PayHero directly for a deposit's status
   and credit the balance if successful. Guarantees the balance
   updates even if the callback never reaches the server.
============================================================ */
async function reconcileDeposit(reference) {
    const deposit = db.prepare("SELECT * FROM deposits WHERE reference = ?").get(reference);
    if (!deposit || deposit.status !== "pending") return;

    // /transaction-status needs PayHero's own reference (the "bfe8-..." value
    // returned by the STK push), stored in provider_ref.
    const identifier = deposit.provider_ref;
    if (!identifier) {
        console.warn(`Reconcile ${reference}: no provider_ref stored — cannot query PayHero`);
        return;
    }

    try {
        const r = await axios.get(`${PAYHERO_BASE_URL}/transaction-status`, {
            params: { reference: identifier },
            auth: payheroAuth,
            timeout: 20000
        });

        const t = r.data || {};
        console.log(`Reconcile ${reference} via [${identifier}]:`, JSON.stringify(t));

        const status = String(t.status || "").toUpperCase();

        if (status === "SUCCESS" || t.success === true) {
            const result = db.prepare(
                `UPDATE deposits SET status = 'completed', mpesa_receipt = ?, completed_at = datetime('now')
                 WHERE reference = ? AND status = 'pending'`
            ).run(t.mpesa_receipt || t.provider_reference || t.third_party_reference || null, reference);

            if (result.changes > 0) {
                db.prepare("UPDATE users SET balance = balance + ? WHERE user_key = ?")
                    .run(deposit.amount, deposit.user_key);
                console.log(`✅ Balance credited (reconciled): user=${deposit.user_key} +KES ${deposit.amount} (${reference})`);
            }
        } else if (status === "FAILED" || status === "CANCELLED") {
            db.prepare("UPDATE deposits SET status = 'failed' WHERE reference = ? AND status = 'pending'").run(reference);
            console.log(`Deposit ${reference} marked FAILED (reconciled)`);
        }
        // QUEUED / PENDING → leave as pending, the poller will try again
    } catch (e) {
        console.warn(`Reconcile ${reference} via [${identifier}] failed:`,
            e.response ? JSON.stringify(e.response.data) : e.message);
    }
}

/* ============ CALLBACK — balance is credited here when PayHero reaches us ============ */
router.post("/payhero-callback", async(req, res) => {
    console.log("PayHero Callback:", JSON.stringify(req.body));

    try {
        const callback = req.body || {};

        const resp =
            callback.response || // PayHero format
            (callback.Body && callback.Body.stkCallback) || // raw Safaricom STK format
            callback;

        let reference =
            req.query.reference ||
            resp.ExternalReference || // PayHero format
            callback.external_reference ||
            resp.CheckoutRequestID ||
            null;

        if (!reference && (callback.OrderTrackingId || resp.OrderTrackingId)) {
            const otid = callback.OrderTrackingId || resp.OrderTrackingId;
            const row = db.prepare("SELECT reference FROM deposits WHERE provider_ref = ?").get(otid);
            if (row) reference = row.reference;
        }

        if (!reference && (callback.CheckoutRequestID || resp.CheckoutRequestID)) {
            const crid = callback.CheckoutRequestID || resp.CheckoutRequestID;
            const row = db.prepare("SELECT reference FROM deposits WHERE provider_ref = ?").get(crid);
            if (row) reference = row.reference;
        }

        if (!reference) {
            console.error("Callback: could not match reference", req.body);
            return res.sendStatus(200);
        }

        const statusOk =
            callback.status === true ||
            String(resp.Status || "").toLowerCase() === "success" ||
            (resp.ResultCode !== undefined && Number(resp.ResultCode) === 0);

        if (!statusOk) {
            db.prepare("UPDATE deposits SET status = 'failed' WHERE reference = ? AND status = 'pending'").run(reference);
            console.log(`Deposit ${reference} marked FAILED`);
            return res.sendStatus(200);
        }

        const receipt =
            resp.MpesaReceiptNumber ||
            resp.TransactionID ||
            (resp.CallbackMetadata && resp.CallbackMetadata.MpesaReceiptNumber) ||
            null;

        const result = db.prepare(
            `UPDATE deposits SET status = 'completed', mpesa_receipt = ?, completed_at = datetime('now')
             WHERE reference = ? AND status = 'pending'`
        ).run(receipt, reference);

        if (result.changes === 0) {
            console.log(`Deposit ${reference} already processed — skipping`);
            return res.sendStatus(200);
        }

        const deposit = db.prepare("SELECT user_key, amount FROM deposits WHERE reference = ?").get(reference);
        if (!deposit) return res.sendStatus(200);

        db.prepare("UPDATE users SET balance = balance + ? WHERE user_key = ?").run(deposit.amount, deposit.user_key);

        console.log(`✅ Balance credited: user=${deposit.user_key} +KES ${deposit.amount} (${reference})`);
        res.sendStatus(200);
    } catch (err) {
        console.error("Callback processing error:", err.message);
        res.sendStatus(200);
    }
});

/* ============ STATUS POLLING for the deposit page ============
   Always reconcile with PayHero first, so success is detected
   even when the callback URL is unreachable.
============================================================ */
router.get("/status/:reference", async(req, res) => {
    const reference = req.params.reference;

    await reconcileDeposit(reference);

    const row = db.prepare("SELECT status, amount FROM deposits WHERE reference = ?").get(reference);
    if (!row) return res.json({ success: true, status: "pending" });
    res.json({ success: true, status: row.status, amount: row.amount });
});

/* ============ WITHDRAWALS ============ */
router.post("/withdraw", (req, res) => {
    const { user_key, amount, method, destination } = req.body;
    const amt = Number(amount);

    if (!user_key || !amt || amt <= 0 || !method || !destination) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const user = db.prepare("SELECT balance FROM users WHERE user_key = ?").get(user_key);
    if (!user || user.balance < amt) {
        return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    const reference = 'WD' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10);

    db.prepare("UPDATE users SET balance = balance - ? WHERE user_key = ?").run(amt, user_key);
    db.prepare(
        `INSERT INTO withdrawals (user_key, reference, method, amount, destination, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(user_key, reference, method, amt, destination);

    console.log(`Withdrawal queued: ${reference} | user=${user_key} | ${amt} KES via ${method}`);

    res.json({ success: true, reference });
});

router.get("/withdraw/history", (req, res) => {
    const userKey = String(req.query.key || "").trim();
    if (!userKey) return res.status(400).json({ success: false, message: "key required" });

    const rows = db.prepare(
        "SELECT reference, method, amount, destination, status, created_at FROM withdrawals WHERE user_key = ? ORDER BY id DESC LIMIT 100"
    ).all(userKey);

    res.json({ success: true, items: rows });
});

router.get("/deposit/history", (req, res) => {
    const userKey = String(req.query.key || "").trim();
    if (!userKey) return res.status(400).json({ success: false, message: "key required" });

    const rows = db.prepare(
        "SELECT reference, amount, status, created_at, phone FROM deposits WHERE user_key = ? ORDER BY id DESC LIMIT 100"
    ).all(userKey);

    res.json({ success: true, items: rows });
});

module.exports = router;