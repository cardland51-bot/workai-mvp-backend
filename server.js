import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";
import webpush from "web-push";
import puppeteer from "puppeteer";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";

dotenv.config();

// ES module path setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- PRICING CONFIG (optional, if you're loading these here) ----
const pricingDir = path.join(__dirname, "data", "pricing");
// (only if states.json / trades.json exist)
const statesConfig = JSON.parse(fs.readFileSync(path.join(pricingDir, "states.json"), "utf-8"));
const tradesConfig = JSON.parse(fs.readFileSync(path.join(pricingDir, "trades.json"), "utf-8"));

// ---- CORE ENV ----
const PORT = process.env.PORT || 10000;
const DEV_MODE = (process.env.DEV_MODE || "false").toLowerCase() === "true";
const FREE_PHOTO_LIMIT = parseInt(process.env.FREE_PHOTO_LIMIT || "2", 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "25", 10);
const ALLOWED_MIME_PREFIX = (process.env.ALLOWED_MIME_PREFIX || "image/,video/").split(",");
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ---- PATHS / DATA FILES ----
const uploadsDir = path.join(__dirname, "uploads");
const exportsDir = path.join(uploadsDir, "exports");
const dataDir = path.join(__dirname, "data");
const jobsFile = path.join(dataDir, "jobs.json");
const usersFile = path.join(dataDir, "users.json");

// 🔴 THIS IS THE PART YOU’RE ASKING ABOUT 🔴
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(jobsFile)) {
  fs.writeFileSync(jobsFile, "[]");
}

if (!fs.existsSync(usersFile)) {
  fs.writeFileSync(usersFile, "{}");
}
// 🔴 END OF THAT PART 🔴


console.log("[pricing] states.json loaded from:", path.join(pricingDir, "states.json"));
console.log("[pricing] trades.json loaded from:", path.join(pricingDir, "trades.json"));


// ---- CORE ENV ----
const PORT = process.env.PORT || 10000;
const DEV_MODE = (process.env.DEV_MODE || "false").toLowerCase() === "true";
const FREE_PHOTO_LIMIT = parseInt(process.env.FREE_PHOTO_LIMIT || "2", 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "25", 10);
const ALLOWED_MIME_PREFIX = (process.env.ALLOWED_MIME_PREFIX || "image/,video/").split(",");
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ---- PATHS / FILES ----
const uploadsDir = path.join(__dirname, "uploads");
const exportsDir = path.join(uploadsDir, "exports");
const dataDir = path.join(__dirname, "data");
const jobsFile = path.join(dataDir, "jobs.json");
const usersFile = path.join(dataDir, "users.json");

for (const p of [uploadsDir, exportsDir, dataDir]) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ---- MULTER (UPLOADS) ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) =>
    cb(
      null,
      Date.now() +
        "-" +
        (file.originalname || "file")
          .replace(/[^a-zA-Z0-9_.-]/g, "_")
          .slice(-100)
    )
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_MIME_PREFIX.some((p) =>
      (file.mimetype || "").startsWith(p)
    );
    if (!ok) return cb(new Error("mime-not-allowed"), false);
    cb(null, true);
  }
});

// ---- APP INIT ----
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadsDir));

// ---- SWAGGER (BEST-EFFORT) ----
try {
  const doc = YAML.load(path.join(__dirname, "openapi.yaml"));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(doc));
} catch {
  // silently ignore if missing
}

// ---- DEVICE COOKIE ----
function ensureDevice(req, res, next) {
  let d = req.cookies["wa_device"];
  if (!d) {
    d = uuidv4();
    res.cookie("wa_device", d, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
  }
  req.deviceId = d;
  next();
}
app.use(ensureDevice);

// ---- FILE HELPERS ----
const read = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8") || JSON.stringify(fb));
  } catch {
    return fb;
  }
};
const write = (f, o) =>
  fs.writeFileSync(f, JSON.stringify(o, null, 2));

// ---- BASIC ENDPOINTS ----
app.get("/api/health", (req, res) =>
  res.json({ ok: true, service: "workai-mvp", dev: DEV_MODE })
);

app.get("/api/config", (req, res) =>
  res.json({
    paypalClientId: process.env.PAYPAL_CLIENT_ID || "",
    paypalPlanId: process.env.PAYPAL_PLAN_ID || "",
    paypalEnv: process.env.PAYPAL_ENV || "sandbox",
    paywallPrice: parseFloat(process.env.PAYWALL_PRICE || "13"),
    freePhotoLimit: FREE_PHOTO_LIMIT,
    dev: DEV_MODE,
    vapidPublicKeyBase64: process.env.VAPID_PUBLIC_KEY || "",
    legalCompany: process.env.LEGAL_COMPANY_NAME || ""
  })
);

app.get("/api/me", (req, res) => {
  const u = read(usersFile, {});
  const me = u[req.deviceId] || { pro: false, uploads: 0 };
  res.json({
    device: req.deviceId,
    pro: !!me.pro,
    uploads: me.uploads || 0
  });
});

app.get("/api/jobs/list", (req, res) => {
  const jobs = read(jobsFile, [])
    .filter((j) => j.deviceId === req.deviceId)
    .sort((a, b) =>
      (b.createdAt || "").localeCompare(a.createdAt || "")
    );
  res.json(jobs);
});

// ---- PAYWALL ----
function enforcePaywall(req, res, next) {
  if (DEV_MODE) return next();
  const u = read(usersFile, {});
  const me = u[req.deviceId] || {};
  if (me.pro || (me.uploads || 0) < FREE_PHOTO_LIMIT) return next();
  return res.status(402).json({
    error: "payment-required",
    message: `Free limit of ${FREE_PHOTO_LIMIT} photos reached.`
  });
}

// ---- JOB UPLOAD ----
app.post("/api/jobs/upload", enforcePaywall, (req, res) => {
  upload.single("media")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { price, description, scopeType } = req.body;
    const p = Number(price) || 0;

    let aiLow = Math.round(p * 0.75);
    let aiHigh = Math.round(p * 1.25);
    if (p >= 2000) {
      // room for later rules
    }
    if (aiHigh < aiLow) aiHigh = aiLow;

    const job = {
      id: Date.now().toString(),
      deviceId: req.deviceId,
      createdAt: new Date().toISOString(),
      price: p,
      description: description || "",
      scopeType: scopeType || "snapshot",
      aiLow,
      aiHigh,
      notes: "Advisory only."
    };

    if (req.file) {
      job.media = {
        filename: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
        url: `/uploads/${req.file.filename}`
      };
    }

    const jobs = read(jobsFile, []);
    jobs.push(job);
    write(jobsFile, jobs);

    if (req.file) {
      const users = read(usersFile, {});
      users[req.deviceId] = users[req.deviceId] || {};
      users[req.deviceId].uploads = (users[req.deviceId].uploads || 0) + 1;
      write(usersFile, users);
    }

    res.json(job);
  });
});

// ---- PAYPAL VERIFY (STUBBED TRUSTED) ----
app.post("/api/paypal/verify-subscription", async (req, res) => {
  try {
    const { subscriptionId } = req.body || {};
    if (!subscriptionId)
      return res.status(400).json({ error: "missing" });

    const users = read(usersFile, {});
    users[req.deviceId] = users[req.deviceId] || {};
    users[req.deviceId].pro = true;
    users[req.deviceId].subscription = {
      provider: "paypal",
      id: subscriptionId,
      status: "ACTIVE",
      updatedAt: new Date().toISOString()
    };
    write(usersFile, users);

    res.json({ ok: true, pro: true });
  } catch (e) {
    console.error("verify-subscription error", e);
    res.status(500).json({ error: "verify-failed" });
  }
});

// ---- EXPORT BID TICKET (HTML + PDF BEST EFFORT) ----
app.post("/api/exports", async (req, res) => {
  try {
    const { jobId } = req.body || {};
    const jobs = read(jobsFile, []);
    const job = jobs.find(
      (j) => j.id === jobId && j.deviceId === req.deviceId
    );
    if (!job) return res.status(404).json({ error: "not-found" });

    const html = `<!doctype html>
<html>
  <body>
    <h1>Bid Ticket</h1>
    <p>Job ${job.id}</p>
    <p>$${job.aiLow}–$${job.aiHigh}</p>
    ${
      job.media
        ? `<img src="${BASE_URL}${job.media.url}" style="max-width:320px;border:1px solid #ccc;">`
        : ""
    }
  </body>
</html>`;

    const outHtml = path.join(exportsDir, `${jobId}.html`);
    fs.writeFileSync(outHtml, html);

    let urlOut = `/uploads/exports/${path.basename(outHtml)}`;

    try {
      const outPdf = path.join(exportsDir, `${jobId}.pdf`);
      const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      await page.pdf({
        path: outPdf,
        format: "A4",
        printBackground: true
      });
      await browser.close();
      urlOut = `/uploads/exports/${path.basename(outPdf)}`;
    } catch (e) {
      console.error("PDF export failed, falling back to HTML", e);
    }

    res.json({ ok: true, url: urlOut });
  } catch (e) {
    console.error("export-failed", e);
    res.status(500).json({ error: "export-failed" });
  }
});

// ======================
// PRICING ENGINE (AREA-COMPETITIVE)
// ======================

function normalize(str = "") {
  return String(str).toLowerCase();
}

// metro + state index (no crazy stacking)
function getLaborIndexForLocation(stateCode, city) {
  if (!stateCode && !city) return 1.0;

  const states = statesConfig.states || {};
  const state = stateCode ? states[stateCode] : null;

  if (state && city && state.metros) {
    const cityNorm = normalize(city);
    for (const [metroName, meta] of Object.entries(state.metros)) {
      if (cityNorm.includes(normalize(metroName))) {
        return meta.laborIndex || state.laborIndex || 1.0;
      }
    }
  }

  if (state && typeof state.laborIndex === "number") {
    return state.laborIndex;
  }

  return 1.0;
}

// home value comfort band
const HOME_VALUE_INDEX = [
  { max: 200000, multiplier: 0.85 },
  { max: 300000, multiplier: 0.92 },
  { max: 450000, multiplier: 1.0 },
  { max: 700000, multiplier: 1.08 },
  { max: 1000000, multiplier: 1.15 },
  { max: Infinity, multiplier: 1.22 }
];

function getHomeValueMultiplier(homeValue) {
  const v = Number(homeValue);
  if (!Number.isFinite(v) || v <= 0) return 1.0;
  const band = HOME_VALUE_INDEX.find((b) => v <= b.max);
  return band ? band.multiplier : 1.0;
}

function getBaseFromTrades(lane) {
  const cfg = tradesConfig[lane];
  if (!cfg) return null;
  if (lane === "handyman") {
    return cfg.baseNashvilleHourly || 75;
  }
  return cfg.baseNashville || null;
}

function clampPrice(lane, price, homeValue) {
  const cfg = tradesConfig[lane] || {};
  let min = typeof cfg.min === "number" ? cfg.min : price * 0.5;
  let max = typeof cfg.max === "number" ? cfg.max : price * 2.0;

  // sanity vs property value for non-handyman lanes
  if (homeValue && lane !== "handyman") {
    const hv = Number(homeValue);
    if (hv > 0) {
      const hardCap = hv * 0.02;
      if (max > hardCap) max = hardCap;
    }
  }

  if (price < min) return min;
  if (price > max) return max;
  return price;
}

function needsRedPen(lane, suggestedPrice, baseNashvillePrice, homeValue) {
  if (!baseNashvillePrice) return false;

  const ratio = suggestedPrice / baseNashvillePrice;
  const bands = {
    mowing: { min: 0.6, max: 1.6 },
    pressure_wash: { min: 0.7, max: 1.8 },
    junk_removal: { min: 0.7, max: 2.0 },
    handyman: { min: 0.7, max: 2.2 }
  };
  const b = bands[lane] || { min: 0.6, max: 2.0 };

  if (ratio < b.min || ratio > b.max) return true;

  if (homeValue && lane !== "handyman") {
    const hv = Number(homeValue);
    if (hv > 0 && suggestedPrice > hv * 0.02) {
      return true;
    }
  }

  return false;
}

function buildSuggestedPrice({
  lane,
  stateCode,
  city,
  homeValue,
  riskFactor = 1.0
}) {
  const base = getBaseFromTrades(lane);
  if (!base) return null;

  const laborIndex = getLaborIndexForLocation(stateCode, city);
  const hvIndex = getHomeValueMultiplier(homeValue);

  const rf = Number(riskFactor);
  const safeRisk =
    Number.isFinite(rf) && rf > 0.5 && rf < 1.5 ? rf : 1.0;

  const raw = base * laborIndex * hvIndex * safeRisk;
  const clamped = clampPrice(lane, raw, homeValue);
  const redPen = needsRedPen(lane, clamped, base, homeValue);

  return {
    baseNashville: base,
    laborIndex,
    homeValueIndex: hvIndex,
    riskFactor: safeRisk,
    suggestedPrice: Math.round(clamped),
    redPen
  };
}

// ---- PRICING ENDPOINT ----
app.post("/api/pricing", (req, res) => {
  try {
    const { lane, stateCode, city, homeValue, riskFactor } =
      req.body || {};

    const result = buildSuggestedPrice({
      lane,
      stateCode,
      city,
      homeValue,
      riskFactor
    });

    if (!result) {
      return res
        .status(400)
        .json({ error: "Unsupported lane or missing config." });
    }

    return res.json(result);
  } catch (err) {
    console.error("Pricing error", err);
    return res
      .status(500)
      .json({ error: "Pricing engine failure" });
  }
});

// ---- START ----
app.listen(PORT, () => {
  console.log(`WorkAI MVP running on :${PORT}`);
});
