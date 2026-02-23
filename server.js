const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  }
}));
app.use(express.json());

// ── Config (use env vars in production) ──────────────────────────────────────
const LOGIN_URL      = "https://cloud-v3.edusoft-ltd.workers.dev/login";
const UNIVERSITY_URL = "https://cloud-v3.edusoft-ltd.workers.dev/console/courses-and-faculties";
const USERNAME       = process.env.UIU_USER || "0112420623";
const PASSWORD       = process.env.UIU_PASS || "Sudiptadas579@";
const STALE_HOURS    = parseInt(process.env.STALE_HOURS || "6");
const PORT           = parseInt(process.env.PORT || "4000");

// ── File storage ──────────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, "data");
const SECTIONS_FILE = path.join(DATA_DIR, "sections.json");
const ROUTINES_FILE = path.join(DATA_DIR, "routines.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const readJSON  = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJSON = (file, data)     => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrapeSections() {
  // Use sparticuz Chromium on Render, local Chrome on dev
  const isCloud = !!process.env.RENDER;

  let launchOptions;
  if (isCloud) {
    const executablePath = await chromium.executablePath();
    console.log("🔍 Chromium path:", executablePath);
    launchOptions = {
      headless: chromium.headless,
      executablePath,
      args: [
        ...chromium.args,
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      defaultViewport: chromium.defaultViewport,
    };
  } else {
    launchOptions = {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Login
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
    await page.waitForSelector("input", { timeout: 15000 });
    const inputs = await page.$$("input");
    await inputs[0].click({ clickCount: 3 }); await inputs[0].type(USERNAME);
    await inputs[1].click({ clickCount: 3 }); await inputs[1].type(PASSWORD);
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .find(b => b.textContent.toLowerCase().includes("sign in"))?.click()
    );
    await page.waitForNavigation({ waitUntil: "networkidle2" });
    console.log("✅ Logged in");

    await page.goto(UNIVERSITY_URL, { waitUntil: "networkidle2" });
    await page.waitForSelector("button.flex.w-full", { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000));

    // Click BSCSE tab if not already active
    const tabResult = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("span[data-slot='badge']"));
      const tab = all.find(el => el.textContent.includes("BSCSE"));
      if (!tab) return "not_found";
      if (tab.getAttribute("data-variant") === "default") return "already_active";
      tab.click(); return "clicked";
    });
    if (tabResult === "clicked") await new Promise(r => setTimeout(r, 2500));
    console.log(`✅ BSCSE tab: ${tabResult}`);

    const courseCount = await page.$$eval("button.flex.w-full", btns => btns.length);
    console.log(`Found ${courseCount} courses — scraping one by one...`);

    const allSections = [];

    for (let i = 0; i < courseCount; i++) {
      const buttons = await page.$$("button.flex.w-full");
      const btn = buttons[i];
      if (!btn) continue;

      const courseInfo = await page.evaluate(b => ({
        name:  b.querySelector("p.text-sm.font-medium")?.textContent.trim() || "",
        title: b.querySelector("p.text-xs.text-muted-foreground")?.textContent.trim() || "",
      }), btn);

      await page.evaluate(b => b.scrollIntoView({ block: "center" }), btn);
      await btn.click();

      try { await page.waitForSelector(".border-t.bg-muted\\/10", { timeout: 3000 }); }
      catch { console.log(`  [${i+1}/${courseCount}] ${courseInfo.name} — no sections`); continue; }
      await new Promise(r => setTimeout(r, 300));

      const sections = await page.evaluate((courseName, courseTitle) => {
        const results = [];
        const container = document.querySelector(".border-t.bg-muted\\/10");
        if (!container) return results;

        container.querySelectorAll(".flex.items-center.gap-3.rounded-md.border").forEach(row => {
          const section   = row.querySelector("span.text-xs.font-semibold.text-foreground")?.textContent.trim() || "";
          const professor = row.querySelector("span.text-xs.text-muted-foreground.truncate")?.textContent.trim() || "";
          const infoSpans = Array.from(row.querySelectorAll("span.flex.items-center"));
          const roomSpan  = infoSpans.find(s => s.textContent.includes(" - "));
          const daySpans  = infoSpans.filter(s => !s.textContent.includes(" - ") && s.textContent.trim().length > 3);
          const room      = roomSpan?.textContent.trim() || "";
          const days      = daySpans.map(s => s.textContent.trim().split(" ")[0]).filter(Boolean);
          const time      = daySpans[0]?.textContent.trim().split(" ").slice(1).join(" ") || "";
          const seatWrap  = row.querySelector("span.shrink-0.text-xs");
          const available = parseInt(seatWrap?.querySelector("span.font-semibold")?.textContent) || 0;
          const seatsMatch = seatWrap?.textContent.match(/\/(\d+)/);
          const seats     = seatsMatch ? parseInt(seatsMatch[1]) : 0;
          const enrolled  = seats - available; // portal shows available/total

          if (section) results.push({
            courseName, courseTitle, section, professor,
            days: days.join(", "), time, room, enrolled, seats,
          });
        });

        return results;
      }, courseInfo.name, courseInfo.title);

      console.log(`  [${i+1}/${courseCount}] ${courseInfo.name} — ${sections.length} sections ✓`);
      allSections.push(...sections.map(s => ({
        id:        `${s.courseName}-${s.section}`,
        course:    s.courseName,
        title:     s.courseTitle,
        section:   s.section,
        professor: s.professor,
        days:      s.days,
        time:      s.time,
        room:      s.room,
        enrolled:  s.enrolled,
        seats:     s.seats,
      })));
    }

    console.log(`\n✅ Done! ${allSections.length} sections scraped`);
    return allSections;
  } finally {
    await browser.close();
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let scrapeInProgress = false;

function isStale() {
  const cache = readJSON(SECTIONS_FILE, null);
  if (!cache?.scraped_at) return true;
  return Date.now() - cache.scraped_at > STALE_HOURS * 60 * 60 * 1000;
}

async function getSections(force = false) {
  if (!force && !isStale()) {
    const cache = readJSON(SECTIONS_FILE, { sections: [] });
    console.log(`📦 Serving ${cache.sections.length} sections from cache`);
    return cache.sections;
  }
  if (scrapeInProgress) {
    // Another request is already scraping — serve stale data if available
    const cache = readJSON(SECTIONS_FILE, { sections: [] });
    if (cache.sections?.length) return cache.sections;
    await new Promise(r => setTimeout(r, 5000));
    return readJSON(SECTIONS_FILE, { sections: [] }).sections || [];
  }
  scrapeInProgress = true;
  try {
    console.log("🔄 Scraping fresh data...");
    const sections = await scrapeSections();
    writeJSON(SECTIONS_FILE, { sections, scraped_at: Date.now() });
    return sections;
  } finally {
    scrapeInProgress = false;
  }
}

// ── Routes: Sections ──────────────────────────────────────────────────────────
app.get("/api/sections", async (req, res) => {
  try { res.json(await getSections()); }
  catch (err) { console.error("❌", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/api/refresh", async (req, res) => {
  try { const s = await getSections(true); res.json({ count: s.length }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Routes: Token ─────────────────────────────────────────────────────────────
app.post("/api/token", (req, res) => {
  const token = crypto.randomUUID();
  const all = readJSON(ROUTINES_FILE, {});
  all[token] = { routines: [], createdAt: Date.now() };
  writeJSON(ROUTINES_FILE, all);
  res.json({ token });
});

// ── Routes: Routines ──────────────────────────────────────────────────────────
const getAll       = ()           => readJSON(ROUTINES_FILE, {});
const saveAll      = (all)        => writeJSON(ROUTINES_FILE, all);
const getRoutines  = (tok)        => getAll()[tok]?.routines || [];
const saveRoutines = (tok, routs) => { const a = getAll(); if (!a[tok]) a[tok] = {}; a[tok].routines = routs; saveAll(a); };

app.get("/api/:token/routines", (req, res) => {
  res.json(getRoutines(req.params.token));
});

app.post("/api/:token/routines", (req, res) => {
  const { name = `Routine ${getRoutines(req.params.token).length + 1}` } = req.body;
  const routine = { id: crypto.randomUUID(), name, sectionIds: [], createdAt: Date.now() };
  const routines = getRoutines(req.params.token);
  routines.push(routine);
  saveRoutines(req.params.token, routines);
  res.json(routine);
});

app.put("/api/:token/routines/:id", (req, res) => {
  const routines = getRoutines(req.params.token);
  const idx = routines.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  if (req.body.name       !== undefined) routines[idx].name       = req.body.name;
  if (req.body.sectionIds !== undefined) routines[idx].sectionIds = req.body.sectionIds;
  saveRoutines(req.params.token, routines);
  res.json(routines[idx]);
});

app.delete("/api/:token/routines/:id", (req, res) => {
  saveRoutines(req.params.token, getRoutines(req.params.token).filter(r => r.id !== req.params.id));
  res.json({ ok: true });
});

// ── Health check (Render pings this to keep awake) ───────────────────────────
app.get("/health", (_, res) => res.json({ ok: true }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Backend running at http://localhost:${PORT}\n`);
  getSections().catch(e => console.error("Initial scrape failed:", e.message));
});
