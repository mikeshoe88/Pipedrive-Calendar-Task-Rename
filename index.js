const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

// ===== ENV =====
const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN; // Pipedrive API token
const PD_SECRET = process.env.PD_WEBHOOK_KEY; // ?key=...
const PRODUCTION_TEAM_FIELD_KEY = process.env.PRODUCTION_TEAM_FIELD_KEY; // e.g., 8bbab3c120ade3217b8738f001033064e803cdef
const RENAME_ALL = (process.env.RENAME_ALL || "true").toLowerCase() === "true"; // rename regardless of type
const POLLER_ENABLED = (process.env.POLLER_ENABLED || "true").toLowerCase() === "true"; // enable background poller
const POLLER_INTERVAL_MS = Number(process.env.POLLER_INTERVAL_MS || 15 * 1000); // 15s default for near real-time crew updates
const POLLER_WINDOW_MIN = Number(process.env.POLLER_WINDOW_MIN || 60); // look back 60 min on first run

if (!API_TOKEN) throw new Error("Missing API_TOKEN");
if (!PD_SECRET) throw new Error("Missing PD_WEBHOOK_KEY");
if (!PRODUCTION_TEAM_FIELD_KEY) throw new Error("Missing PRODUCTION_TEAM_FIELD_KEY");

// Map your Production Team enum IDs -> names
const PRODUCTION_TEAM_MAP = {
  47: "Kings",
  48: "Johnathan",
  49: "Pena",
  50: "Hector",
  51: "Sebastian",
  52: "Anastacio",
  53: "Mike",
  54: "Kim",
};

// Optional allowlist (labels) if you later set RENAME_ALL=false
const ALLOWED_TYPE_LABELS = new Set([
  "Moisture Check",
  "Moisture Pickup",
  "Demo",
  "Estimate",
  "Inspection",
  "Production",
]);

const app = express();
// Parse common webhook content-types
app.use(bodyParser.json()); // application/json
app.use(bodyParser.urlencoded({ extended: true })); // application/x-www-form-urlencoded

// ===== Request Logger (so we always see hits in Railway) =====
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path} q=${JSON.stringify(req.query)} ua=${req.get('user-agent')}`);
  next();
});

const pd = axios.create({
  baseURL: "https://api.pipedrive.com/v1",
  params: { api_token: API_TOKEN },
  headers: { "Content-Type": "application/json" },
  timeout: 20000,
});

// ===== Retry helper =====
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      const code = err?.response?.status || 0;
      if (code === 429 || (code >= 500 && code < 600)) {
        await new Promise(r => setTimeout(r, (i + 1) * 400));
        lastErr = err; continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ===== Activity type cache (labels <-> keys) =====
let TYPE_KEY_BY_LABEL = {};   // { "Demo": "demo" }
let TYPE_LABEL_BY_KEY = {};   // { "demo": "Demo" }
let ALLOWED_TYPE_KEYS = new Set();

async function warmActivityTypes() {
  try {
    const r = await withRetry(() => pd.get("/activityTypes"));
    const list = r.data?.data || [];
    TYPE_KEY_BY_LABEL = {}; TYPE_LABEL_BY_KEY = {};
    for (const t of list) { TYPE_KEY_BY_LABEL[t.name] = t.key; TYPE_LABEL_BY_KEY[t.key] = t.name; }
    ALLOWED_TYPE_KEYS = new Set(
      Array.from(ALLOWED_TYPE_LABELS).map(label => TYPE_KEY_BY_LABEL[label]).filter(Boolean)
    );
    console.log("✅ Cached activity types. Allowed keys:", Array.from(ALLOWED_TYPE_KEYS));
  } catch (e) {
    console.warn("⚠️ Could not warm activity types (will still work w/ RENAME_ALL=true)", e?.response?.data || e.message);
  }
}

// ===== Helpers =====
async function getActivity(id) {
  const r = await withRetry(() => pd.get(`/activities/${id}`));
  return r.data?.success ? r.data.data : null;
}
async function getDeal(id) {
  const r = await withRetry(() => pd.get(`/deals/${id}`));
  return r.data?.success ? r.data.data : null;
}
async function listOpenActivitiesForDeal(dealId) {
  const r = await withRetry(() => pd.get(`/activities`, { params: { deal_id: dealId, done: 0 } }));
  return r.data?.success ? (r.data.data || []) : [];
}
function crewNamesFromDeal(deal) {
  const raw = deal?.[PRODUCTION_TEAM_FIELD_KEY];
  const ids = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return ids.map((id) => PRODUCTION_TEAM_MAP[id]).filter(Boolean);
}
function buildSubject({ deal, typeKey, crewNames }) {
  const jobId = deal?.id;
  const who = deal?.org_id?.name || deal?.person_id?.name || deal?.title || "Deal";
  const typeLabel = TYPE_LABEL_BY_KEY[typeKey] || typeKey || "Activity";
  const crew = crewNames.length ? ` — Crew: ${crewNames.join(", ")}` : "";
  return `[JOB ${jobId}] ${who} — ${typeLabel}${crew}`;
}
function isAlreadyCanonical(curr, next) { return (curr || "").trim() === next.trim(); }
function shouldRenameByKey(typeKey) { return RENAME_ALL || ALLOWED_TYPE_KEYS.has(typeKey); }
function parseMs(iso) { return iso ? Date.parse(iso) || 0 : 0; }

// ===== Health =====
app.get("/", (_req, res) => res.send("✅ PD Activity Renamer running"));
app.get("/ping", (_req, res) => res.send("pong"));
// Quick version + route introspection to verify deploy
const APP_VERSION = process.env.APP_VERSION || "v-fast-15s";
app.get("/version", (_req, res) => res.json({ version: APP_VERSION }));
app.get("/__routes", (_req, res) => {
  const routes = [];
  (app._router?.stack || []).forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods || {}).map(k => k.toUpperCase());
      routes.push({ methods, path: m.route.path });
    }
  });
  res.json({ version: APP_VERSION, routes });
});

// ===== Manual sweep (for testing / Outlook sync cases) =====
// Shared sweep logic so both GET and POST can call it
async function sweepDeal(dealId) {
  const now = new Date().toISOString();
  const deal = await getDeal(dealId);
  if (!deal) return { error: `Deal ${dealId} not found` };
  const crew = crewNamesFromDeal(deal);
  if (!crew.length) return { updated: 0, skipped: 0, total: 0, msg: "no Production Team set" };
  const acts = await listOpenActivitiesForDeal(dealId);
  let updated = 0, skipped = 0;
  for (const a of acts) {
    const typeKey = (a?.type || "").trim();
    if (!shouldRenameByKey(typeKey)) { skipped++; continue; }
    const canonical = buildSubject({ deal, typeKey, crewNames: crew });
    if (isAlreadyCanonical(a.subject, canonical)) { skipped++; continue; }
    try {
      const r = await withRetry(() => pd.put(`/activities/${a.id}`, { subject: canonical }));
      if (r.data?.success) updated++;
    } catch (e) {
      console.error(`[${now}] ❌ Failed to update activity ${a.id}`, e?.response?.data || e.message);
    }
  }
  return { updated, skipped, total: acts.length };
}

// GET /sweep?key=...&dealId=136 (simple manual trigger)
app.get("/sweep", async (req, res) => {
  if (req.query.key !== PD_SECRET) return res.status(401).send("nope");
  const dealId = Number(req.query.dealId);
  if (!dealId) return res.status(400).json({ error: "missing dealId" });
  try { return res.status(200).json(await sweepDeal(dealId)); }
  catch (e) { return res.status(500).json({ error: e?.response?.data || e.message }); }
});

// POST /sweep (for Pipedrive Workflow Automation "Send Webhook")
// Accepts JSON or form body with { dealId: 136 }, or query ?dealId=136
app.post("/sweep", async (req, res) => {
  if ((req.query.key || req.body?.key) !== PD_SECRET) return res.status(401).send("nope");
  let dealId = Number(req.body?.dealId || req.query?.dealId);
  // Some PD automations send { current: { id: <dealId> } }
  if (!dealId) dealId = Number(req.body?.current?.id || req.body?.meta?.id);
  if (!dealId) return res.status(400).json({ error: "missing dealId" });
  try { return res.status(200).json(await sweepDeal(dealId)); }
  catch (e) { return res.status(500).json({ error: e?.response?.data || e.message }); }
});

// ===== Debug endpoints =====
app.get("/debug-deal", async (req, res) => {
  if (req.query.key !== PD_SECRET) return res.status(401).send("nope");
  const dealId = Number(req.query.dealId);
  if (!dealId) return res.status(400).json({ error: "missing dealId" });
  try {
    const d = await getDeal(dealId);
    if (!d) return res.status(404).json({ error: `Deal ${dealId} not found` });
    res.json({
      dealId: d.id,
      title: d.title,
      teamFieldKey: PRODUCTION_TEAM_FIELD_KEY,
      teamRaw: d[PRODUCTION_TEAM_FIELD_KEY],
      crewNames: crewNamesFromDeal(d),
    });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e.message });
  }
});
app.get("/debug-activity", async (req, res) => {
  if (req.query.key !== PD_SECRET) return res.status(401).send("nope");
  const activityId = Number(req.query.activityId);
  if (!activityId) return res.status(400).json({ error: "missing activityId" });
  try {
    const a = await getActivity(activityId);
    if (!a) return res.status(404).json({ error: `Activity ${activityId} not found` });
    res.json({
      activityId: a.id,
      subject: a.subject,
      typeKey: a.type,
      deal_id: a.deal_id,
    });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e.message });
  }
});

// ===== Poller (NO WEBHOOKS NEEDED) =====
let lastPollMs = Date.now() - POLLER_WINDOW_MIN * 60 * 1000; // start by looking back POLLER_WINDOW_MIN
async function pollDealsUpdatedSince() {
  const startTs = new Date(lastPollMs).toISOString();
  const nowMs = Date.now();
  let start = 0, touched = 0, scannedDeals = 0, stop = false;
  console.log(`[poll] starting from ${startTs}`);
  while (!stop) {
    const r = await withRetry(() => pd.get(`/deals`, { params: { start, limit: 100, sort: "update_time DESC" } }));
    const deals = r.data?.data || [];
    if (!deals.length) break;
    for (const d of deals) {
      const upd = parseMs(d.update_time);
      if (upd && upd < lastPollMs - 60 * 1000) { // 1 min buffer
        stop = true; break;
      }
      scannedDeals++;
      try {
        const deal = await getDeal(d.id); // need full fields + org/person
        const crew = crewNamesFromDeal(deal);
        if (!crew.length) continue;
        const acts = await listOpenActivitiesForDeal(deal.id);
        for (const a of acts) {
          const typeKey = (a?.type || "").trim();
          if (!shouldRenameByKey(typeKey)) continue;
          const canonical = buildSubject({ deal, typeKey, crewNames: crew });
          if (isAlreadyCanonical(a.subject, canonical)) continue;
          try {
            const up = await withRetry(() => pd.put(`/activities/${a.id}`, { subject: canonical }));
            if (up.data?.success) touched++;
          } catch (e) {
            console.error(`[poll] ❌ Failed to update activity ${a.id}`, e?.response?.data || e.message);
          }
        }
      } catch (e) {
        console.error(`[poll] ⚠️ error on deal ${d.id}`, e?.response?.data || e.message);
      }
    }
    start += 100;
    if (deals.length < 100) break;
  }
  lastPollMs = nowMs;
  console.log(`[poll] done — updated activities=${touched}, scannedDeals=${scannedDeals}, next start=${new Date(lastPollMs).toISOString()}`);
}

// Manual trigger: GET /poll-now?key=...
app.get("/poll-now", async (req, res) => {
  if (req.query.key !== PD_SECRET) return res.status(401).send("nope");
  try {
    await pollDealsUpdatedSince();
    res.status(200).send("ok");
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e.message });
  }
});

// ===== Webhook (optional; keeps working if you enable it later) =====
app.post("/", async (req, res) => {
  const now = new Date().toISOString();
  try {
    if (req.query.key !== PD_SECRET) return res.status(401).send("nope");

    // --- Normalize body across PD variations ---
    let body = req.body || {};
    // If PD posts as urlencoded with a JSON string in `payload`, parse it
    if (body && typeof body.payload === "string") {
      try { body = JSON.parse(body.payload); } catch (_) {}
    }
    // If PD posts raw text JSON (unlikely), try parsing
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (_) {}
    }

    console.log(`[webhook] ct=${req.get('content-type')} keys=${Object.keys(body||{}).join(',')}`);
    const event = String(body.event || "");
    const meta = body.meta || {};

    // v2 names we’ve seen: create.activity, change.activity
    const isActivityV2 = /\.activity$/.test(body.event || "");

    // v1 fallbacks
    const v1Object = body.object || meta.object || body?.current?.object || body?.current?.model; // 'activity'|'deal' || body?.current?.object || body?.current?.model; // 'activity'|'deal'

    console.log(`[webhook] event=${event} v1Object=${v1Object} idHint=${meta?.id || meta?.object_id || body?.current?.id || body?.activity?.id || body?.id}`);

    // Ack immediately
    res.status(200).send("ok");

    // === Activity path (v2 or v1) ===
    if (isActivityV2 || v1Object === "activity") {
      const activityId = body?.current?.id || body?.activity?.id || meta?.id || meta?.object_id || body?.id;
      if (!activityId) return console.log(`[${now}] ❌ Missing activityId`, { event, meta });

      const activity = await getActivity(activityId);
      if (!activity) return console.log(`[${now}] ❌ Activity ${activityId} not found`);
      if (!activity.deal_id) return console.log(`[${now}] ℹ️ Activity ${activityId} has no deal; skipping`);

      const deal = await getDeal(activity.deal_id);
      if (!deal) return console.log(`[${now}] ❌ Deal ${activity.deal_id} not found`);

      const crew = crewNamesFromDeal(deal);
      if (!crew.length) return console.log(`[${now}] ℹ️ Deal ${deal.id} has no Production Team set or unmapped; skipping`);

      const typeKey = (activity?.type || "").trim();
      if (!shouldRenameByKey(typeKey)) {
        const label = TYPE_LABEL_BY_KEY[typeKey] || typeKey || "(unknown)";
        return console.log(`[${now}] ℹ️ Skipping type '${label}' (${typeKey}) by config`);
      }

      const canonical = buildSubject({ deal, typeKey, crewNames: crew });
      if (isAlreadyCanonical(activity.subject, canonical)) {
        return console.log(`[${now}] ✅ Already canonical for activity ${activityId}`);
      }

      const up = await withRetry(() => pd.put(`/activities/${activityId}`, { subject: canonical }));
      if (up.data?.success) console.log(`[${now}] ✅ Renamed activity ${activityId} → "${canonical}"`);
      else console.log(`[${now}] ❌ Update failed`, up.data);
      return;
    }

    // === Deal path (v2 or v1) — sweep all open activities instantly ===
    const isDealV2 = /\.deal$/.test(event);
    if (isDealV2 || v1Object === "deal") {
      const dealId = Number(body?.current?.id || body?.deal?.id || meta?.id || meta?.object_id || body?.id);
      if (!dealId) return console.log(`[${now}] ❌ Missing dealId for event '${event}'`, { meta });
      const result = await sweepDeal(dealId);
      return console.log(`[${now}] ✅ Deal webhook sweep`, { dealId, result });
    }

    console.log(`[${now}] ℹ️ Unhandled payload`, { event, v1Object });
  } catch (err) {
    console.error(`[${now}] ❌ Exception:`, err?.response?.data || err.message);
  }
});

// ===== Boot =====
(async () => {
  await warmActivityTypes();
  if (POLLER_ENABLED) {
    console.log(`⏱️ Poller enabled: interval=${POLLER_INTERVAL_MS}ms, window=${POLLER_WINDOW_MIN}min`);
    setInterval(() => {
      pollDealsUpdatedSince().catch((e) => console.error("[poll] run error", e?.response?.data || e.message));
    }, POLLER_INTERVAL_MS);
    // Kick once on boot so you can see it working immediately
    pollDealsUpdatedSince().catch((e) => console.error("[poll] boot error", e?.response?.data || e.message));
  } else {
    console.log("⏸️ Poller disabled (POLLER_ENABLED=false)");
  }
  app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
})();
