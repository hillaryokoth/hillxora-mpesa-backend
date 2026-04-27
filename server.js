const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// ─── CONFIGURATION ───────────────────────────────────────────────────────────
const CONSUMER_KEY = "vJkP76ozIxQzD3QnPJUGBCnVjTtkr5QK6g5MwAGMGGEKAlmp";
const CONSUMER_SECRET = "DbBVaSy2ADcyLPACeEECAQXTjX2HBzu6NEF2vXduurXzQlV8JLNxSixaVAGqciVHg";
const PASSKEY = "aaf9e6dbd80cd3d15ca74dbdf5052c918b551a37aff60a26cdaac38db2d7d2f0";
const SHORT_CODE = "4574431"; // HO Number
const OAUTH_URL = "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
const STK_PUSH_URL = "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

// In-memory transaction store (simple, no database needed)
const transactions = {};

// ─── HELPER: GET ACCESS TOKEN ─────────────────────────────────────────────────
async function getAccessToken() {
  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  const response = await axios.get(OAUTH_URL, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  return response.data.access_token;
}

// ─── HELPER: GENERATE TIMESTAMP ──────────────────────────────────────────────
function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

// ─── ROUTE: HEALTH CHECK ──────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Hillxora Homes M-PESA Backend is running ✅" });
});

// ─── ROUTE: TEST ACCESS TOKEN ─────────────────────────────────────────────────
app.get("/test-token", async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ success: true, token: token.substring(0, 20) + "..." });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.response?.data || error.message,
      status: error.response?.status
    });
  }
});

// ─── ROUTE: INITIATE STK PUSH ─────────────────────────────────────────────────
// Called from your Android app
// POST /stk-push
// Body: { phone: "2547XXXXXXXX", amount: 1000, accountRef: "RENT-123" }
app.post("/stk-push", async (req, res) => {
  try {
    const { phone, amount, accountRef } = req.body;

    if (!phone || !amount || !accountRef) {
      return res.status(400).json({ error: "phone, amount and accountRef are required" });
    }

    const token = await getAccessToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(`${SHORT_CODE}${PASSKEY}${timestamp}`).toString("base64");

    // Use your Render URL as callback - update this after deploying
    const callbackUrl = `${process.env.RENDER_URL || "https://your-app.onrender.com"}/callback`;

    const payload = {
      BusinessShortCode: SHORT_CODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: SHORT_CODE,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef,
      TransactionDesc: "Rent Payment - Hillxora Homes",
    };

    const response = await axios.post(STK_PUSH_URL, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const checkoutRequestId = response.data.CheckoutRequestID;

    // Store transaction as pending
    transactions[checkoutRequestId] = {
      status: "PENDING",
      phone,
      amount,
      accountRef,
      timestamp: new Date().toISOString(),
    };

    console.log(`STK Push sent to ${phone} - CheckoutRequestID: ${checkoutRequestId}`);

    res.json({
      success: true,
      checkoutRequestId,
      message: "STK Push sent successfully. Waiting for customer to enter PIN.",
    });
  } catch (error) {
    const errData = error.response?.data || error.message;
    console.error("STK Push error:", JSON.stringify(errData));
    res.status(500).json({
      success: false,
      error: errData,
      details: error.response?.data
    });
  }
});

// ─── ROUTE: SAFARICOM CALLBACK ────────────────────────────────────────────────
// Safaricom calls this URL after customer enters PIN
app.post("/callback", (req, res) => {
  try {
    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;

    if (!stkCallback) {
      return res.status(400).json({ error: "Invalid callback" });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;

    if (resultCode === 0) {
      // Payment successful
      const items = stkCallback.CallbackMetadata?.Item || [];
      const amount = items.find((i) => i.Name === "Amount")?.Value;
      const mpesaCode = items.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
      const phone = items.find((i) => i.Name === "PhoneNumber")?.Value;

      transactions[checkoutRequestId] = {
        ...transactions[checkoutRequestId],
        status: "SUCCESS",
        mpesaCode,
        amount,
        phone,
        completedAt: new Date().toISOString(),
      };

      console.log(`✅ Payment SUCCESS - Code: ${mpesaCode} | Amount: ${amount}`);
    } else {
      // Payment failed or cancelled
      transactions[checkoutRequestId] = {
        ...transactions[checkoutRequestId],
        status: "FAILED",
        reason: resultDesc,
        completedAt: new Date().toISOString(),
      };

      console.log(`❌ Payment FAILED - Reason: ${resultDesc}`);
    }

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    console.error("Callback error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── ROUTE: CHECK TRANSACTION STATUS ─────────────────────────────────────────
// Your Android app polls this to know if payment was successful
// GET /transaction/:checkoutRequestId
app.get("/transaction/:checkoutRequestId", (req, res) => {
  const { checkoutRequestId } = req.params;
  const transaction = transactions[checkoutRequestId];

  if (!transaction) {
    return res.status(404).json({ status: "NOT_FOUND" });
  }

  res.json(transaction);
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hillxora Homes backend running on port ${PORT}`);
});
