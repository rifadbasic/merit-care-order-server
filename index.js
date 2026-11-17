require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5000;

const PDFDocument = require("pdfkit");
const FormData = require("form-data");

const path = require("path");

const FONT_REGULAR = path.join(
  __dirname,
  "fonts",
  "NotoSansBengali-Regular.ttf",
);

const FONT_BOLD = path.join(__dirname, "fonts", "NotoSansBengali-Bold.ttf");

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
// SEND INVOICE PDF TO TELEGRAM
// ======================================

async function sendTelegramInvoice(chatId, orderId, messageText) {
  const pdfBuffer = await createInvoicePdf(messageText);

  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new Error("Generated PDF is empty");
  }

  console.log("PDF generated:", pdfBuffer.length, "bytes");

  const form = new FormData();

  form.append("chat_id", String(chatId));
  form.append("caption", `📄 Invoice - ${orderId}`);

  form.append("document", pdfBuffer, {
    filename: `${orderId}-invoice.pdf`,
    contentType: "application/pdf",
    knownLength: pdfBuffer.length,
  });

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`;

  const response = await axios.post(url, form, {
    headers: {
      ...form.getHeaders(),
    },
    timeout: 60000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (!response.data?.ok) {
    throw new Error(
      response.data?.description || "Telegram PDF sending failed",
    );
  }

  console.log("PDF successfully sent:", orderId);

  return response.data.result;
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
// GENERATE INVOICE PDF
// ======================================

function createInvoicePdf(messageText) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [280.63, 595.28],
        margin: 0,
      });

      const chunks = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Compress the entire invoice horizontally
      const SCALE_X = 280.63 / 420;
      doc.scale(SCALE_X, 1);

      doc.registerFont("Bangla", FONT_REGULAR);
      doc.registerFont("Bangla-Bold", FONT_BOLD);

      const X = 26;
      const W = 368;
      const GAP = 14;
      const CW = (W - GAP) / 2;
      const RIGHT = X + CW + GAP;

      const lines = String(messageText).split("\n");

      // Extract information from Telegram message
      function getField(label) {
        const regex = new RegExp(
          `${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.*)`,
          "i",
        );

        const line = lines.find((item) => regex.test(item));
        return line ? line.match(regex)[1].trim() : "-";
      }

      function money(value) {
        const amount = String(value || "").match(/[\d,]+/);
        return amount
          ? "BDT " + Number(amount[0].replace(/,/g, "")).toLocaleString("en-US")
          : "BDT 0";
      }

      // Extract product lines
      const productStart = lines.findIndex((line) => /Products:/i.test(line));

      const productEnd = lines.findIndex((line) => /Subtotal:/i.test(line));

      const productLines =
        productStart !== -1 && productEnd > productStart
          ? lines
              .slice(productStart + 1, productEnd)
              .filter((line) => line.trim())
          : [];

      const products = productLines.map((line) => {
        const clean = line.replace(/^\s*/, "");

        const match = clean.match(
          /^(.*?)\s*[×x]\s*(\d+)\s*=\s*৳?\s*([\d,]+)$/i,
        );

        return {
          name: match ? match[1].trim() : clean,
          quantity: match ? match[2] : "-",
          amount: match ? money(match[3]) : "-",
        };
      });

      const orderId = getField("Order");
      const customerName = getField("Customer");
      const phone = getField("Phone");
      const division = getField("Division");
      const district = getField("District");
      const upazila = getField("Upazila");
      const address = getField("Address");

      const paymentMethod =
        getField("Payment Method") !== "-"
          ? getField("Payment Method")
          : getField("Advance Method");

      const total = money(getField("Total"));
      const advance = money(getField("Advance Paid"));
      const due = money(getField("Due Amount"));

      const status = messageText.includes("🟩 CONFIRMED ORDER")
        ? "CONFIRMED"
        : messageText.includes("🟥 CANCELLED ORDER")
          ? "CANCELLED"
          : "PENDING";

      // =====================================
      // COMMON DRAWING FUNCTIONS
      // =====================================

      function text(value, x, y, width, options = {}) {
        doc.save();

        // Keep font characters at their original proportions
        doc.translate(x, 0);
        doc.scale(1 / SCALE_X, 1);
        doc.translate(-x, 0);

        doc
          .font(options.bold ? "Bangla-Bold" : "Bangla")
          .fontSize(options.size || 8)
          .fillColor(options.color || "#172033")
          .text(String(value || "-"), x, y, {
            width: width * SCALE_X,
            lineGap: 1,
            ...options,
          });

        doc.restore();
      }

      function section(title, y) {
        text(title, X, y, W, {
          bold: true,
          size: 9,
          color: "#183153",
        });

        doc
          .moveTo(X, y + 14)
          .lineTo(X + W, y + 14)
          .lineWidth(0.5)
          .strokeColor("#dbe2ea")
          .stroke();

        return y + 20;
      }

      function field(label, value, x, y, width) {
        text(label, x, y, width, {
          size: 7,
          color: "#64748b",
        });

        text(value, x, y + 11, width, {
          size: 8.5,
          bold: true,
        });
      }

      // =====================================
      // HEADER
      // =====================================

      text("MERIT CARE", X, 22, W, {
        bold: true,
        size: 20,
        color: "#183153",
        align: "center",
      });

      text("ACADEMY & PUBLICATIONS", X, 46, W, {
        size: 8,
        color: "#64748b",
        align: "center",
      });

      text("ORDER INVOICE", X, 65, W, {
        bold: true,
        size: 13,
        color: "#183153",
        align: "center",
      });

      doc
        .moveTo(X, 88)
        .lineTo(X + W, 88)
        .lineWidth(1)
        .strokeColor("#183153")
        .stroke();

      // =====================================
      // ORDER ID + STATUS - SINGLE ROW
      // =====================================

      text("ORDER ID", X, 101, 55, {
        size: 7,
        color: "#64748b",
      });

      text(orderId, X + 54, 100, 215, {
        bold: true,
        size: 8.5,
      });

      text("STATUS", 310, 101, 38, {
        size: 7,
        color: "#64748b",
      });

      text(status, 348, 100, 46, {
        bold: true,
        size: 7.5,
        color:
          status === "CONFIRMED"
            ? "#15803d"
            : status === "CANCELLED"
              ? "#dc2626"
              : "#b45309",
      });

      // =====================================
      // CUSTOMER INFORMATION
      // =====================================

      let y = section("CUSTOMER INFORMATION", 124);

      // Row 1
      field("Customer Name", customerName, X, y, CW);
      field("Phone Number", phone, RIGHT, y, CW);

      y += 34;

      // Row 2
      field("Division", division, X, y, CW);
      field("District", district, RIGHT, y, CW);

      y += 34;

      // Row 3
      field("Upazila", upazila, X, y, CW);
      field("Payment Method", paymentMethod, RIGHT, y, CW);

      y += 34;

      // Address - single full-width row
      text("DELIVERY ADDRESS", X, y, W, {
        size: 7,
        color: "#64748b",
      });

      text(address, X, y + 11, W, {
        size: 8.5,
        bold: true,
      });

      y += 35;

      // =====================================
      // PRODUCT TABLE
      // =====================================

      y = section("ORDER DETAILS", y);

      const headerY = y;

      doc.roundedRect(X, headerY, W, 21, 3).fill("#183153");

      text("PRODUCT DESCRIPTION", X + 8, headerY + 7, 210, {
        bold: true,
        size: 7.5,
        color: "#ffffff",
      });

      text("QTY", 255, headerY + 7, 35, {
        bold: true,
        size: 7.5,
        color: "#ffffff",
        align: "center",
      });

      text("AMOUNT", 302, headerY + 7, 84, {
        bold: true,
        size: 7.5,
        color: "#ffffff",
        align: "right",
      });

      y += 27;

      products.forEach((product, index) => {
        const nameHeight = doc
          .font("Bangla")
          .fontSize(8)
          .heightOfString(product.name, {
            width: 205,
          });

        const rowHeight = Math.max(23, nameHeight + 9);

        if (index % 2 === 0) {
          doc.rect(X, y - 3, W, rowHeight).fill("#f1f5f9");
        }

        text(product.name, X + 7, y + 2, 205, {
          size: 8,
        });

        text(product.quantity, 255, y + 2, 35, {
          size: 8,
          align: "center",
        });

        text(product.amount, 302, y + 2, 84, {
          size: 8,
          align: "right",
        });

        y += rowHeight;
      });

      y += 9;

      // =====================================
      // PAYMENT SUMMARY
      // =====================================

      y = section("PAYMENT SUMMARY", y);

      // Total card
      doc.roundedRect(X, y, CW, 43, 4).fill("#eff6ff");

      text("TOTAL AMOUNT", X + 9, y + 7, CW - 18, {
        size: 7,
        color: "#64748b",
      });

      text(total, X + 9, y + 21, CW - 18, {
        bold: true,
        size: 11,
        color: "#183153",
      });

      // Advance card
      doc.roundedRect(RIGHT, y, CW, 43, 4).fill("#ecfdf5");

      text("ADVANCE PAID", RIGHT + 9, y + 7, CW - 18, {
        size: 7,
        color: "#64748b",
      });

      text(advance, RIGHT + 9, y + 21, CW - 18, {
        bold: true,
        size: 11,
        color: "#15803d",
      });

      y += 51;

      // Due amount
      doc.roundedRect(X, y, W, 25, 4).fill("#fff7ed");

      text("DUE AMOUNT", X + 9, y + 8, 100, {
        bold: true,
        size: 8,
        color: "#9a3412",
      });

      text(due, 270, y + 6, 115, {
        bold: true,
        size: 10,
        color: "#9a3412",
        align: "right",
      });

      y += 38;

      // =====================================
      // FOOTER
      // =====================================

      doc
        .moveTo(X, y)
        .lineTo(X + W, y)
        .lineWidth(0.6)
        .strokeColor("#cbd5e1")
        .stroke();

      text("Thank you for choosing Merit Care!", X, y + 9, W, {
        bold: true,
        size: 9,
        color: "#183153",
        align: "center",
      });

      text("Committed to fulfilling Dreams", X, y + 24, W, {
        size: 7,
        color: "#64748b",
        align: "center",
      });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
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

// ======================================
// TELEGRAM: UPDATE ORDER MESSAGE
// ======================================

async function updateTelegramOrderMessage(message, status, orderId) {
  const heading =
    status === "Confirmed" ? "🟩 CONFIRMED ORDER" : "🟥 CANCELLED ORDER";

  const cleanText = (message.text || "")
    .replace(/\n📌 Status:.*$/m, "")
    .replace(/\n*🟩 CONFIRMED ORDER/g, "")
    .replace(/\n*🟥 CANCELLED ORDER/g, "")
    .trim();

  const updatedText = `${cleanText}\n\n${heading}`;

  // Confirmed = PDF + Delete
  // Cancelled = Delete only
  const keyboard =
    status === "Confirmed"
      ? [
          [
            {
              text: "📄 Download Invoice PDF",
              callback_data: `invoice:${orderId}`,
            },
          ],
        ]
      : [
          [
            {
              text: "🗑️ Delete Order Message",
              callback_data: `delete:${orderId}`,
            },
          ],
        ];

  await telegramRequest("editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: updatedText,
  });

  await telegramRequest("editMessageReplyMarkup", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });

  return true;
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
    if (!callbackId || !data || !message) {
      return res.status(200).send("Invalid callback");
    }

    // Parse callback data
    const match = data.match(/^(confirm|cancel|invoice|delete):(.+)$/);

    if (!match) {
      await answerTelegramCallback(callbackId, "Invalid order action!");

      return res.status(200).send("Invalid action");
    }

    const action = match[1];
    const orderId = match[2];

    // ==================================
    // 1. DOWNLOAD INVOICE PDF
    // ==================================

    if (action === "invoice") {
      if (!message.text?.includes("🟩 CONFIRMED ORDER")) {
        await answerTelegramCallback(
          callbackId,
          "Invoice is only available for confirmed orders.",
        );

        return res.status(200).send("Invalid invoice request");
      }

      await answerTelegramCallback(callbackId, "Generating invoice PDF...");

      try {
        await sendTelegramInvoice(message.chat.id, orderId, message.text);

        console.log(`✅ Invoice sent: ${orderId}`);
      } catch (error) {
        console.error("❌ Invoice Error:", {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status,
        });

        // Show failure in Telegram
        await telegramRequest("sendMessage", {
          chat_id: message.chat.id,
          text: `❌ Invoice generation failed!\nOrder: ${orderId}\nError: ${error.response?.data?.description || error.message}`,
        });
      }

      return res.status(200).send("Invoice processed");
    }

    // ==================================
    // 2. DELETE CANCELLED ORDER MESSAGE
    // ==================================

    if (action === "delete") {
      if (!message.text?.includes("🟥 CANCELLED ORDER")) {
        await answerTelegramCallback(
          callbackId,
          "Only cancelled order messages can be deleted.",
        );

        return res.status(200).send("Invalid delete request");
      }

      await answerTelegramCallback(callbackId, "Deleting Telegram message...");

      await telegramRequest("deleteMessage", {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });

      console.log(`🗑️ Telegram message deleted: ${orderId}`);

      return res.status(200).send("Message deleted");
    }

    // ==================================
    // 3. CONFIRM / CANCEL ORDER
    // ==================================

    // ==================================
    // 3. CONFIRM / CANCEL ORDER
    // ==================================

    const statusMap = {
      confirm: "Confirmed",
      cancel: "Cancelled",
    };

    const status = statusMap[action];

    if (!status) {
      await answerTelegramCallback(callbackId, "Invalid action");
      return res.status(200).send("Invalid action");
    }

    // Prevent repeated confirmation/cancellation
    const currentText = message.text || "";

    if (!currentText.includes("📌 Status: Pending")) {
      await answerTelegramCallback(
        callbackId,
        "This order has already been processed.",
      );

      return res.status(200).send("Order already processed");
    }

    await answerTelegramCallback(callbackId, "Processing order...");

    // 1. Update Google Sheet
    const sheetResult = await updateGoogleSheetStatus(orderId, status);

    console.log("Google Sheet Update Result:", sheetResult);

    // 2. Update Telegram message and buttons
    await updateTelegramOrderMessage(message, status, orderId);

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
    const { customer, products: cartProducts, advancePayment } = req.body;

    console.log("📦 Incoming Order:", req.body);

    // ===============================
    // CUSTOMER VALIDATION
    // ===============================
    if (
      !customer ||
      !customer.name ||
      !customer.phone ||
      !customer.division ||
      !customer.district ||
      !customer.upazila ||
      !customer.address ||
      !customer.payment
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

    // ===============================
    // PRODUCTS VALIDATION
    // ===============================
    if (!Array.isArray(cartProducts) || cartProducts.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cart is empty",
      });
    }

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

    // ===============================
    // CALCULATE ORDER TOTAL
    // ===============================
    const subtotal = verifiedProducts.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    const delivery =
      String(customer.district).trim() === "ঢাকা সিটি" ? 80 : 120;

    const total = subtotal + delivery;

    // ===============================
    // ADVANCE PAYMENT VALIDATION
    // ===============================
    if (customer.payment === "Advance") {
      if (
        !advancePayment ||
        !["Nagad", "Bank"].includes(advancePayment.method)
      ) {
        throw new Error("Invalid advance payment method");
      }

      const amount = Number(advancePayment.amount);

      // Validate advance amount
      if (!Number.isInteger(amount) || amount <= 0 || amount > total) {
        throw new Error("Invalid advance payment amount");
      }

      // Nagad validation
      if (advancePayment.method === "Nagad") {
        const transactionId = String(advancePayment.transactionId || "")
          .trim()
          .toUpperCase();

        const senderNumber = String(advancePayment.senderNumber || "").trim();

        // Transaction ID must be exactly 8 alphanumeric characters
        if (!/^[A-Z0-9]{8}$/.test(transactionId)) {
          throw new Error("Nagad Transaction ID must be exactly 8 characters");
        }

        // Validate Bangladesh mobile number
        if (!/^01[3-9]\d{8}$/.test(senderNumber)) {
          throw new Error("Invalid Bangladesh mobile number");
        }
      }

      // Bank validation
      if (advancePayment.method === "Bank") {
        const senderBankName = String(
          advancePayment.senderBankName || "",
        ).trim();

        const senderBankAccount = String(
          advancePayment.senderBankAccount || "",
        ).trim();

        if (!senderBankName || !senderBankAccount) {
          throw new Error("Bank payment information is incomplete");
        }
      }
    } else if (customer.payment === "COD") {
      if (advancePayment) {
        throw new Error("COD orders cannot contain advance payment details");
      }
    } else {
      throw new Error("Invalid payment method");
    }

    // ===============================
    // CALCULATE ADVANCE & DUE
    // ===============================
    const advanceAmount =
      customer.payment === "Advance" ? Number(advancePayment.amount) : 0;

    const dueAmount = total - advanceAmount;

    // ===============================
    // GENERATE ORDER ID
    // ===============================
    const orderId = `MCA-2027-${Date.now().toString().slice(-6)}`;

    // ===============================
    // COMPLETE ORDER OBJECT
    // ===============================
    const order = {
      orderId,

      customer: {
        name: String(customer.name).trim(),
        phone,
        division: String(customer.division).trim(),
        district: String(customer.district).trim(),
        upazila: String(customer.upazila).trim(),
        address: String(customer.address).trim(),
        payment: customer.payment,
      },

      // IMPORTANT: Apps Script needs this products array
      products: verifiedProducts,

      advancePayment:
        customer.payment === "Advance"
          ? {
              ...advancePayment,
              amount: advanceAmount,
            }
          : null,

      subtotal,
      delivery,
      total,

      advanceAmount,
      dueAmount,

      status: "Pending",
      createdAt: new Date().toISOString(),
    };

    // console.log("✅ Final Order Data:", order);

    // ===============================
    // SAVE ORDER TO GOOGLE SHEETS
    // ===============================
    await saveToGoogleSheet(order);

    // ===============================
    // TELEGRAM PRODUCT DETAILS
    // ===============================
    const productText = verifiedProducts
      .map(
        (item) =>
          `${item.name} × ${item.quantity} = ৳${item.price * item.quantity}`,
      )
      .join("\n");

    // ===============================
    // TELEGRAM PAYMENT DETAILS
    // ===============================
    let advancePaymentText = "";

    if (order.customer.payment === "Advance") {
      if (order.advancePayment.method === "Nagad") {
        advancePaymentText = `
💳 Advance Method: Nagad
🧾 Transaction ID: ${order.advancePayment.transactionId}
📱 Sender Number: ${order.advancePayment.senderNumber}
💰 Advance Amount: ৳${advanceAmount}
`;
      } else if (order.advancePayment.method === "Bank") {
        advancePaymentText = `
💳 Advance Method: Bank
🏦 Sender Bank: ${order.advancePayment.senderBankName}
🔢 Sender Account: ${order.advancePayment.senderBankAccount}
💰 Advance Amount: ৳${advanceAmount}
`;
      }
    } else {
      advancePaymentText = `
💳 Payment Method: Cash on Delivery
`;
    }

    // ===============================
    // TELEGRAM MESSAGE
    // ===============================
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

💳 Advance Paid: ৳${advanceAmount}
⏳ Due Amount: ৳${dueAmount}

${advancePaymentText}

📌 Status: Pending
`;

    // ===============================
    // SEND TELEGRAM MESSAGE
    // ===============================
    await sendTelegramMessage(message, order.orderId);

    // ===============================
    // SUCCESS RESPONSE
    // ===============================
    return res.status(201).json({
      success: true,
      message: "Order placed successfully",
      orderId,
      subtotal,
      delivery,
      total,
      advanceAmount,
      dueAmount,
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
      message:
        error.response?.data?.message ||
        error.message ||
        "Order could not be completed.",
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
