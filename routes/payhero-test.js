// payhero-test.js — diagnose the PayHero STK flow directly
require("dotenv").config({ override: true });
const axios = require("axios");

const PAYHERO_BASE_URL = "https://backend.payhero.co.ke/api/v2";
const { PAYHERO_API_USERNAME, PAYHERO_API_PASSWORD, PAYHERO_CHANNEL_ID } = process.env;

const auth = { username: PAYHERO_API_USERNAME, password: PAYHERO_API_PASSWORD };

const PHONE = "254727983553"; // <-- PUT YOUR REAL TEST PHONE HERE (format 2547XXXXXXXX)
const AMOUNT = 1;

(async() => {
    console.log("=== CONFIG ===");
    console.log("username set:", !!PAYHERO_API_USERNAME, "| password set:", !!PAYHERO_API_PASSWORD, "| channel_id:", PAYHERO_CHANNEL_ID);

    const reference = `TEST-${Date.now()}`;
    console.log("reference:", reference);

    // 1) STK PUSH
    try {
        const r = await axios.post(`${PAYHERO_BASE_URL}/payments`, {
            amount: AMOUNT,
            phone_number: PHONE,
            channel_id: Number(PAYHERO_CHANNEL_ID),
            provider: "m-pesa",
            external_reference: reference,
            callback_url: process.env.PAYHERO_CALLBACK_URL || "https://yourdomain.com/api/payhero/payhero-callback"
        }, { auth, timeout: 30000 });

        console.log("\n=== STK PUSH RESPONSE (FULL) ===");
        console.log("HTTP status:", r.status);
        console.log(JSON.stringify(r.data, null, 2));
    } catch (e) {
        console.log("\n=== STK PUSH FAILED ===");
        console.log("HTTP status:", e.response && e.response.status);
        console.log(JSON.stringify(e.response ? e.response.data : e.message, null, 2));
        return;
    }

    console.log("\n>>> Now COMPLETE the M-Pesa prompt on your phone, then press ENTER to check status...");
    await new Promise(resolve => process.stdin.once("data", resolve));

    // 2) Try transaction-status with every plausible identifier
    const identifiers = [reference, "the value from the STK response above"];
    for (const id of identifiers) {
        if (!id || id.startsWith("the value")) continue;
        try {
            const r = await axios.get(`${PAYHERO_BASE_URL}/transaction-status`, {
                params: { reference: id },
                auth,
                timeout: 20000
            });
            console.log(`\n=== STATUS via [${id}] ===`);
            console.log(JSON.stringify(r.data, null, 2));
        } catch (e) {
            console.log(`\n=== STATUS via [${id}] FAILED ===`);
            console.log("HTTP status:", e.response && e.response.status);
            console.log(JSON.stringify(e.response ? e.response.data : e.message, null, 2));
        }
    }
})();