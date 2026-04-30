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
const CONSUMER_SECRET = "DbBVaSy2ADcyLPACeEECAQXTjX2HBzu6NEF2vXduuXzQlV8JLNxSixaVAGqciVHg";
const PASSKEY = "aaf9e6dbd80cd3d15ca74dbdf5052c918b551a37aff60a26cdaac38db2d7d2f0";
const SHORT_CODE = "4574431"; // Your Business Short Code (Store/Organization)
const TILL_NUMBER = "5414043"; // Your M-PESA Till Number
const OAUTH_URL = "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
const STK_PUSH_URL = "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

// In-memory transaction store (simple, no database needed)
const transactions = {};

// ─── HELPER: GET ACCESS TOKEN ─────────────────────────────────────────────────
async function getAccessToken() {
  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  try {
    const response = await axios.get(OAUTH_URL, {
      headers: { Authorization: `Basic ${credentials}` },
    });
    return response.data.access_token;
  } catch (error) {
    console.error("OAuth Token Error:", error.response?.data || error.message);
    throw error;
  }
}

// ─── HELPER: GENERATE TIMESTAMP ──────────────────────────────────────────────
function getTimestamp() {
  // Safaricom requires East African Time (GMT+3)
  const now = new Date();
  const eatOffset = 3 * 60; // 3 hours in minutes
  const eatTime = new Date(now.getTime() + (eatOffset + now.getTimezoneOffset()) * 60000);
  
  const pad = (n) => String(n).padStart(2, "0");
  return (
    eatTime.getFullYear().toString() +
    pad(eatTime.getMonth() + 1) +
    pad(eatTime.getDate()) +
    pad(eatTime.getHours()) +
    pad(eatTime.getMinutes()) +
    pad(eatTime.getSeconds())
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
app.post("/stk-push", async (req, res) => {
  try {
    const { phone, amount, accountRef, transactionType } = req.body;

    if (!phone || !amount || !accountRef) {
      return res.status(400).json({ error: "phone, amount and accountRef are required" });
    }

    // Task 2: Ensure Amount is a strict integer
    const strictAmount = parseInt(amount);

    const token = await getAccessToken();
    const timestamp = getTimestamp();
    // Use SHORT_CODE (4574431) for password/auth, TILL_NUMBER (5414043) for receiving money
    const password = Buffer.from(`${SHORT_CODE}${PASSKEY}${timestamp}`).toString("base64");

    const callbackUrl = `${process.env.RENDER_URL || "https://hillxora-mpesa-backend.onrender.com"}/callback`;

    const payload = {
      BusinessShortCode: SHORT_CODE, // The Store ID / Org Shortcode
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: strictAmount,
      PartyA: phone,
      PartyB: TILL_NUMBER, // The actual Till Number
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef.replace(/[^a-zA-Z0-9]/g, "").substring(0, 12) || "Rent",
      TransactionDesc: "Rent",
    };

    console.log("Sending STK Push Payload:", JSON.stringify(payload, null, 2));

    const response = await axios.post(STK_PUSH_URL, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    // Task 1: Expose Raw Response
    console.log("Safaricom Raw Response:", JSON.stringify(response.data, null, 2));

    const checkoutRequestId = response.data.CheckoutRequestID;

    transactions[checkoutRequestId] = {
      status: "PENDING",
      phone,
      amount: strictAmount,
      accountRef,
      timestamp: new Date().toISOString(),
    };

    console.log(`STK Push sent to ${phone} - CheckoutRequestID: ${checkoutRequestId}`);

    res.json({
      success: true,
      checkoutRequestId,
      message: response.data.CustomerMessage || "STK Push sent successfully. Waiting for customer to enter PIN.",
    });
  } catch (error) {
    // Task 3: Error Handling Refactor
    const errData = error.response?.data || { message: error.message };
    console.error("STK Push error details:", JSON.stringify(errData, null, 2));
    
    // Extracting the real cause (e.g., ResultDesc or errorMessage)
    const specificError = errData.errorMessage || errData.ResultDesc || "Failed to initiate payment";
    
    res.status(500).json({
      success: false,
      error: specificError,
      details: errData
    });
  }
});

// ─── ROUTE: SAFARICOM CALLBACK ────────────────────────────────────────────────
app.post("/callback", (req, res) => {
  try {
    console.log("Callback received:", JSON.stringify(req.body, null, 2));
    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;

    if (!stkCallback) {
      return res.status(400).json({ error: "Invalid callback" });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;

    if (resultCode === 0) {
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
