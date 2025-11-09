
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
const __filename = fileURLToPath(import.meta.url); const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;
const DEV_MODE = (process.env.DEV_MODE || "false").toLowerCase() === "true";
const FREE_PHOTO_LIMIT = parseInt(process.env.FREE_PHOTO_LIMIT || "2", 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "25", 10);
const ALLOWED_MIME_PREFIX = (process.env.ALLOWED_MIME_PREFIX || "image/,video/").split(",");
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const uploadsDir = path.join(__dirname, "uploads");
const exportsDir = path.join(uploadsDir, "exports");
const dataDir = path.join(__dirname, "data");
const jobsFile = path.join(dataDir, "jobs.json");
const usersFile = path.join(dataDir, "users.json");
for (const p of [uploadsDir, exportsDir, dataDir]) if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
if (!fs.existsSync(jobsFile)) fs.writeFileSync(jobsFile, "[]"); if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, "{}");

const storage = multer.diskStorage({ destination:(req,f,cb)=>cb(null, uploadsDir), filename:(req,f,cb)=>cb(null, Date.now()+"-"+(f.originalname||"file").replace(/[^a-zA-Z0-9_.-]/g,"_").slice(-100)) });
const upload = multer({ storage, limits:{ fileSize: MAX_UPLOAD_MB*1024*1024 }, fileFilter:(req,file,cb)=>cb(ALLOWED_MIME_PREFIX.some(p=>(file.mimetype||'').startsWith(p))?null:new Error('mime-not-allowed'), true) });

const app = express();
app.use(cors()); app.use(express.json({ limit:"2mb" })); app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"))); app.use("/uploads", express.static(uploadsDir));
try{ const doc = YAML.load(path.join(__dirname,"openapi.yaml")); app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(doc)); }catch{}

function ensureDevice(req,res,next){ let d=req.cookies["wa_device"]; if(!d){ d=uuidv4(); res.cookie("wa_device", d, { httpOnly:true, sameSite:"lax", secure:false, maxAge:1000*60*60*24*365 }); } req.deviceId=d; next(); }
app.use(ensureDevice);

const read = (f,fb)=>{ try{ return JSON.parse(fs.readFileSync(f,"utf-8")||JSON.stringify(fb)); }catch{ return fb; } };
const write=(f,o)=>fs.writeFileSync(f, JSON.stringify(o,null,2));

app.get("/api/health",(req,res)=>res.json({ok:true,service:"workai-mvp",dev:DEV_MODE}));
app.get("/api/config",(req,res)=>res.json({paypalClientId:process.env.PAYPAL_CLIENT_ID||"",paypalPlanId:process.env.PAYPAL_PLAN_ID||"",paypalEnv:(process.env.PAYPAL_ENV||"sandbox"),paywallPrice:parseFloat(process.env.PAYWALL_PRICE||"13"),freePhotoLimit:FREE_PHOTO_LIMIT,dev:DEV_MODE,vapidPublicKeyBase64:process.env.VAPID_PUBLIC_KEY||"",legalCompany:process.env.LEGAL_COMPANY_NAME||""}));
app.get("/api/me",(req,res)=>{ const u=read(usersFile,{}); const me=u[req.deviceId]||{pro:false,uploads:0}; res.json({device:req.deviceId, pro:!!me.pro, uploads:me.uploads||0}); });
app.get("/api/jobs/list",(req,res)=>{ const jobs=read(jobsFile,[]).filter(j=>j.deviceId===req.deviceId).sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||"")); res.json(jobs); });

function enforcePaywall(req,res,next){ if (DEV_MODE) return next(); const u=read(usersFile,{}); const me=u[req.deviceId]||{}; if ((me.pro) || ((me.uploads||0) < FREE_PHOTO_LIMIT)) return next(); return res.status(402).json({error:"payment-required",message:`Free limit of ${FREE_PHOTO_LIMIT} photos reached.`}); }

app.post("/api/jobs/upload", enforcePaywall, (req,res)=>{
  upload.single("media")(req,res,(err)=>{
    if (err) return res.status(400).json({error:err.message});
    const { price, description, scopeType } = req.body; const p = Number(price)||0;
    let aiLow = Math.round(p*0.75), aiHigh = Math.round(p*1.25); if (p>=2000){}; if (aiHigh<aiLow) aiHigh=aiLow;
    const job = { id: Date.now().toString(), deviceId:req.deviceId, createdAt:new Date().toISOString(), price:p, description:description||"", scopeType:scopeType||"snapshot", aiLow, aiHigh, notes:"Advisory only." };
    if (req.file) job.media={ filename:req.file.filename, mimetype:req.file.mimetype, size:req.file.size, url:`/uploads/${req.file.filename}` };
    const jobs=read(jobsFile,[]); jobs.push(job); write(jobsFile,jobs);
    if (req.file){ const users=read(usersFile,{}); users[req.deviceId]=users[req.deviceId]||{}; users[req.deviceId].uploads=(users[req.deviceId].uploads||0)+1; write(usersFile,users); }
    res.json(job);
  });
});

app.post("/api/paypal/verify-subscription", async (req,res)=>{
  try{ const { subscriptionId } = req.body||{}; if(!subscriptionId) return res.status(400).json({error:"missing"});
    const users=read(usersFile,{}); users[req.deviceId]=users[req.deviceId]||{}; users[req.deviceId].pro=true; users[req.deviceId].subscription={provider:"paypal",id:subscriptionId,status:"ACTIVE",updatedAt:new Date().toISOString()}; write(usersFile,users);
    res.json({ok:true,pro:true});
  }catch(e){ res.status(500).json({error:"verify-failed"}); }
});

app.post("/api/exports", async (req,res)=>{
  try{ const { jobId } = req.body||{}; const jobs=read(jobsFile,[]); const job=jobs.find(j=>j.id===jobId && j.deviceId===req.deviceId); if(!job) return res.status(404).json({error:"not-found"});
    const html = `<!doctype html><html><body><h1>Bid Ticket</h1><p>Job ${job.id}</p><p>$${job.aiLow}–$${job.aiHigh}</p>${job.media?`<img src="${BASE_URL}${job.media.url}" style="max-width:320px;border:1px solid #ccc;">`:''}</body></html>`;
    const outHtml = path.join(exportsDir, `${jobId}.html`); fs.writeFileSync(outHtml, html);
    let urlOut=`/uploads/exports/${path.basename(outHtml)}`;
    try{ const outPdf=path.join(exportsDir,`${jobId}.pdf`); const browser=await puppeteer.launch({args:['--no-sandbox','--disable-setuid-sandbox']}); const page=await browser.newPage(); await page.setContent(html,{waitUntil:'networkidle0'}); await page.pdf({path:outPdf,format:'A4',printBackground:true}); await browser.close(); urlOut=`/uploads/exports/${path.basename(outPdf)}`;}catch{}
    res.json({ok:true,url:urlOut});
  }catch(e){ res.status(500).json({error:"export-failed"}); }
});

app.get("/", (req,res)=> res.sendFile(path.join(__dirname,"public","index.html")));
app.get("*", (req,res)=> res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, ()=> console.log(`WorkAI MVP on ${PORT}`));
