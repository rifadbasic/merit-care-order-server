require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5000;

// ======================================
// MIDDLEWARE & CORS
// ======================================

const allowedOrigins = ["http://localhost:5173", process.env.CLIENT_URL].filter(
  Boolean,
);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("CORS blocked origin:", origin);

    return callback(null, false);
  },

  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "20kb" }));

// ======================================
// CONFIGURATION
// ======================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

const products = [
  {
    id: 1,
    name: "SSC 2027 Science Complete Package",
    price: 1950,
  },
  {
    id: 2,
    name: "SSC 2027 Commerce Complete Package",
    price: 1750,
  },
  {
    id: 3,
    name: "SSC 2027 Humanities Complete Package",
    price: 1750,
  },
];

// ======================================
// BASIC ROUTES
// ======================================

app.get("/", (req, res) => {
  res.json({
    message: "Merit Care Academy Order Server Running",
    status: "success",
  });
});

app.get("/api/test", (req, res) => {
  res.json({
    success: true,
    message: "API is working successfully!",
  });
});

// ======================================
// TELEGRAM API HELPER
// ======================================

async function telegramRequest(method, data) {
  if (!TELEGRAM_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN missing");
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;

  const response = await axios.post(url, data, {
    timeout: 20000,
  });

  if (!response.data.ok) {
    throw new Error(response.data.description || "Telegram API request failed");
  }

  return response.data.result;
}

// ======================================
// SEND NEW ORDER TO TELEGRAM
// ======================================

async function sendTelegramMessage(message, orderId) {
  if (!TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID missing");
  }

  return telegramRequest("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ Confirm Order",
            callback_data: `confirm:${orderId}`,
          },
          {
            text: "❌ Cancel Order",
            callback_data: `cancel:${orderId}`,
          },
        ],
      ],
    },
  });
}

// ======================================
// GOOGLE SHEETS: SAVE ORDER
// ======================================

async function saveToGoogleSheet(order) {
  if (!GOOGLE_SCRIPT_URL) {
    throw new Error("GOOGLE_SCRIPT_URL missing");
  }

  const response = await axios.post(GOOGLE_SCRIPT_URL, order, {
    timeout: 20000,
  });

  if (!response.data?.success) {
    throw new Error(response.data?.message || "Google Sheets save failed");
  }

  return response.data;
}

// ======================================
// GOOGLE SHEETS: UPDATE ORDER STATUS
// ======================================

async function updateGoogleSheetStatus(orderId, status) {
  if (!GOOGLE_SCRIPT_URL) {
    throw new Error("GOOGLE_SCRIPT_URL missing");
  }

  const response = await axios.post(
    GOOGLE_SCRIPT_URL,
    {
      action: "updateStatus",
      orderId,
      status,
    },
    { timeout: 20000 },
  );

  if (!response.data?.success) {
    throw new Error(
      response.data?.message || "Google Sheets status update failed",
    );
  }

  return response.data;
}

// ======================================
// TELEGRAM: ANSWER CALLBACK
// ======================================

async function answerTelegramCallback(callbackId, text) {
  return telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: false,
  });
}

// ======================================
// TELEGRAM: UPDATE MESSAGE + REMOVE BUTTONS
// ======================================

async function updateTelegramOrderMessage(message, status) {
  const heading =
    status === "Confirmed" ? "🟩 CONFIRMED ORDER" : "🟥 CANCELLED ORDER";

  const oldText = message.text || "";

  // Remove the old status and any previous result heading
  const cleanText = oldText
    .replace(/\n📌 Status:.*$/m, "")
    .replace(/\n*🟩 CONFIRMED ORDER/g, "")
    .replace(/\n*🟥 CANCELLED ORDER/g, "")
    .trim();

  const updatedText = `${cleanText}\n\n${heading}`;

  // Edit message and remove inline buttons in the same request
  return telegramRequest("editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: updatedText,
    reply_markup: {
      inline_keyboard: [],
    },
  });
}

// ======================================
// TELEGRAM WEBHOOK
// ======================================

app.post("/api/telegram/webhook", async (req, res) => {
  console.log("🔥 TELEGRAM WEBHOOK RECEIVED");

  const callback = req.body?.callback_query;

  // Ignore normal Telegram updates
  if (!callback) {
    return res.status(200).send("OK");
  }

  const callbackId = callback.id;
  const message = callback.message;
  const data = callback.data;

  try {
    console.log("Telegram Callback Data:", data);

    // Validate callback
    if (!callbackId || !data) {
      return res.status(200).send("Invalid callback");
    }

    // Parse callback data
    const match = data.match(/^(confirm|cancel):(.+)$/);

    if (!match) {
      await answerTelegramCallback(callbackId, "Invalid order action!");

      return res.status(200).send("Invalid action");
    }

    const action = match[1];
    const orderId = match[2];

    const statusMap = {
      confirm: "Confirmed",
      cancel: "Cancelled",
    };

    const status = statusMap[action];

    // Stop Telegram loading indicator
    await answerTelegramCallback(callbackId, "Processing order...");

    console.log(`Processing ${orderId}: ${status}`);

    // 1. Update Google Sheets
    const sheetResult = await updateGoogleSheetStatus(orderId, status);

    console.log("Google Sheet Update Result:", sheetResult);

    // 2. Update Telegram message and remove buttons
    if (message) {
      await updateTelegramOrderMessage(message, status);
    }

    console.log(`✅ Order ${orderId} => ${status}`);

    return res.status(200).send("Order status updated");
  } catch (error) {
    console.error(
      "❌ Telegram Webhook Error:",
      error.response?.data || error.message,
    );

    return res.status(200).send("Webhook processing failed");
  }
});

// ======================================
// ORDER API
// ======================================

app.post("/api/orders", async (req, res) => {
  try {
    const { customer, products: cartProducts } = req.body;

    // Customer validation
    if (
      !customer ||
      !customer.name ||
      !customer.phone ||
      !customer.division ||
      !customer.district ||
      !customer.upazila ||
      !customer.address
    ) {
      return res.status(400).json({
        success: false,
        message: "Customer information is incomplete",
      });
    }

    const phone = String(customer.phone).trim();

    if (!/^01[3-9]\d{8}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Bangladesh mobile number",
      });
    }

    if (!Array.isArray(cartProducts) || cartProducts.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty",
      });
    }

    // Validate products and quantities
    const verifiedProducts = cartProducts.map((item) => {
      const product = products.find((p) => p.id === Number(item.id));

      const quantity = Number(item.quantity);

      if (
        !product ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 20
      ) {
        throw new Error("Invalid product or quantity");
      }

      return {
        id: product.id,
        name: product.name,
        price: product.price,
        quantity,
      };
    });

    const subtotal = verifiedProducts.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    // Delivery Charge
    const delivery =
      String(customer.district).trim() === "ঢাকা সিটি" ? 80 : 120;

    const total = subtotal + delivery;

    const orderId = `MCA-2027-${Date.now().toString().slice(-6)}`;

    const order = {
      orderId,

      customer: {
        name: String(customer.name).trim(),
        phone,
        division: String(customer.division || "").trim(),
        district: String(customer.district).trim(),
        upazila: String(customer.upazila).trim(),
        address: String(customer.address).trim(),
        payment: customer.payment === "Advance" ? "Advance" : "COD",
      },

      products: verifiedProducts,
      subtotal,
      delivery,
      total,
      status: "Pending",
      createdAt: new Date().toISOString(),
    };

    // 1. Save order in Google Sheets
    await saveToGoogleSheet(order);

    // 2. Prepare Telegram message
    const productText = verifiedProducts
      .map(
        (item) =>
          `${item.name} × ${item.quantity} = ৳${item.price * item.quantity}`,
      )
      .join("\n");

    const message = `
🛒 NEW ORDER - MERIT CARE

🆔 Order: ${order.orderId}

👤 Customer: ${order.customer.name}
📞 Phone: ${order.customer.phone}
📍 Division: ${order.customer.division}
📍 District: ${order.customer.district}
📍 Upazila: ${order.customer.upazila}
🏠 Address: ${order.customer.address}

📚 Products:
${productText}

💰 Subtotal: ৳${subtotal}
🚚 Delivery: ৳${delivery}
💵 Total: ৳${total}

💳 Payment: ${order.customer.payment}
📌 Status: Pending
`;

    // 3. Send Telegram notification
    await sendTelegramMessage(message, order.orderId);

    return res.status(201).json({
      success: true,
      message: "Order placed successfully",
      orderId,
      total,
    });
  } catch (error) {
    console.error("❌ Order Error:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: error.message || "Order could not be completed.",
    });
  }
});

// ======================================
// SERVER START / VERCEL EXPORT
// ======================================

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
