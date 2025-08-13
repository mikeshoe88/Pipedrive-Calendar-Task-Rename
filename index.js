const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

// ===== ENV =====
const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN; // Pipedrive API token
const PD_SECRET = process.env.PD_WEBHOOK_KEY; // ?key=...
const PRODUCTION_TEAM_FIELD_KEY = process.env.PRODUCTION_TEAM_FIELD_KEY; // e.g., 5b43...
const RENAME_ALL = (process.env.RENAME_ALL || "true").toLowerCase() === "true"; // force rename regardless of type

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
app.use(bodyParser.json({ type: "*/*" }));

const pd = axios.create({
  baseURL: "https://api.pipedrive.com/v1",
  params: { api_token: API_TOKEN },
  headers: { "Content-Type": "application/json" },
  timeout: 15000,
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

// ===== Health =====
app.get("/", (_req, res) => res.send("✅ PD Activity Renamer running"));

// ===== Webhook =====
app.post("/", async (req, res) => {
  const now = new Date().toISOString();
  try {
    if (req.query.key !== PD_SECRET) return res.status(401).send("nope");

    const body = req.body || {};
    const event = String(body.event || "");
    const meta = body.meta || {};

    // v2 names we’ve seen: create.activity, change.activity
    const isActivityV2 = /\.activity$/.test(event);
    const isCreate = event.startsWith("create.");
    const isChange = event.startsWith("change.") || event.startsWith("update.") || event.startsWith("updated.");

    // v1 fallbacks
    const v1Object = meta.object || body?.current?.object || body?.current?.model; // 'activity'|'deal'
    const v1Action = meta.action || ""; // 'added'|'updated'|...

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

      return; // done
    }

    console.log(`[${now}] ℹ️ Unhandled payload`, { event, v1Object, v1Action });
  } catch (err) {
    console.error(`[${now}] ❌ Exception:`, err?.response?.data || err.message);
  }
});

// ===== Boot =====
(async () => {
  await warmActivityTypes();
  app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
})();
