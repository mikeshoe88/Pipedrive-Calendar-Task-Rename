const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

// ===== Required env (no fallbacks) =====
const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN; // Pipedrive API token
const PD_SECRET = process.env.PD_WEBHOOK_KEY; // shared secret used as ?key=...
const PRODUCTION_TEAM_FIELD_KEY = process.env.PRODUCTION_TEAM_FIELD_KEY; // e.g. "5b436b45b63857305f9691910b6567351b5517bc"

if (!API_TOKEN) throw new Error("Missing API_TOKEN");
if (!PD_SECRET) throw new Error("Missing PD_WEBHOOK_KEY");
if (!PRODUCTION_TEAM_FIELD_KEY) throw new Error("Missing PRODUCTION_TEAM_FIELD_KEY");

// Map your Production Team enum IDs -> names (confirm 54 is Kim vs Gary)
const PRODUCTION_TEAM_MAP = {
  47: "Kings",
  48: "Johnathan",
  49: "Pena",
  50: "Hector",
  51: "Sebastian",
  52: "Anastacio",
  53: "Mike",
  54: "Kim"
};

// Configure which *labels* (human names) should be renamed.
// We'll translate labels -> type keys at boot using /activityTypes
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
  timeout: 12000,
});

// ===== Simple retry helper for PD 429/5xx =====
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      const code = err?.response?.status;
      if (code === 429 || (code >= 500 && code < 600)) {
        await new Promise(r => setTimeout(r, (i + 1) * 400));
        lastErr = err; continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ===== Activity Type cache (label <-> key) =====
let TYPE_KEY_BY_LABEL = {};   // { "Moisture Check": "moisture_check" }
let TYPE_LABEL_BY_KEY = {};   // { "moisture_check": "Moisture Check" }
let ALLOWED_TYPE_KEYS = new Set(); // derived from ALLOWED_TYPE_LABELS

async function warmActivityTypes() {
  const r = await withRetry(() => pd.get("/activityTypes"));
  const list = r.data?.data || [];
  TYPE_KEY_BY_LABEL = {};
  TYPE_LABEL_BY_KEY = {};
  for (const t of list) {
    // t = { id, key, name }
    TYPE_KEY_BY_LABEL[t.name] = t.key;
    TYPE_LABEL_BY_KEY[t.key] = t.name;
  }
  // Build allowlist of type *keys* from the *labels* you configured above
  ALLOWED_TYPE_KEYS = new Set(
    Array.from(ALLOWED_TYPE_LABELS)
      .map(label => TYPE_KEY_BY_LABEL[label])
      .filter(Boolean)
  );
  console.log("✅ Activity types cached. Allowed keys:", Array.from(ALLOWED_TYPE_KEYS));
}

// ===== Helpers =====
async function getActivity(activityId) {
  const r = await withRetry(() => pd.get(`/activities/${activityId}`));
  return r.data?.success ? r.data.data : null;
}
async function getDeal(dealId) {
  const r = await withRetry(() => pd.get(`/deals/${dealId}`));
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
function buildSubject({ deal, activityTypeKey, crewNames }) {
  const jobId = deal?.id;
  const who = deal?.org_id?.name || deal?.person_id?.name || deal?.title || "Deal";
  const typeLabel = TYPE_LABEL_BY_KEY[activityTypeKey] || activityTypeKey || "Activity";
  const crew = crewNames.length ? ` — Crew: ${crewNames.join(", ")}` : "";
  return `[JOB ${jobId}] ${who} — ${typeLabel}${crew}`;
}
function shouldRenameByKey(activityTypeKey) {
  return ALLOWED_TYPE_KEYS.has(activityTypeKey);
}
function isAlreadyCanonical(currentSubject, canonical) {
  return (currentSubject || "").trim() === canonical.trim();
}

// ===== Health =====
app.get("/", (_req, res) => res.send("✅ PD Activity Renamer running"));

// ===== Webhook =====
app.post("/", async (req, res) => {
  const now = new Date().toISOString();
  try {
    // Shared-secret guard (?key=...)
    if (req.query.key !== PD_SECRET) return res.status(401).send("nope");

    const body = req.body || {};
    const meta = body.meta || {};
    const object = meta.object || body?.current?.object || body?.current?.model; // 'activity' or 'deal'
    const action = meta.action || body?.event || ""; // 'added'|'updated'|...

    // Ack immediately
    res.status(200).send("ok");

    // === When an ACTIVITY is added/updated ===
    if (object === "activity") {
      const activityId = body?.current?.id || body?.activity?.id || meta?.id;
      if (!activityId) return console.log(`[${now}] ❌ Missing activityId in activity webhook`);

      const activity = await getActivity(activityId);
      if (!activity) return console.log(`[${now}] ❌ Activity ${activityId} not found`);

      if (!activity.deal_id) {
        return console.log(`[${now}] ℹ️ Activity ${activityId} has no deal; skipping`);
      }

      const typeKey = (activity?.type || "").trim(); // API returns the *key*, not label
      if (!shouldRenameByKey(typeKey)) {
        return console.log(`[${now}] ℹ️ Activity ${activityId} type "${typeKey}" not in allowlist; skipping`);
      }

      const deal = await getDeal(activity.deal_id);
      if (!deal) return console.log(`[${now}] ❌ Deal ${activity.deal_id} not found`);

      const crew = crewNamesFromDeal(deal);
      if (crew.length === 0) {
        return console.log(`[${now}] ℹ️ Deal ${deal.id} has no Production Team set or IDs unmapped; skipping`);
      }

      const canonical = buildSubject({ deal, activityTypeKey: typeKey, crewNames: crew });
      if (isAlreadyCanonical(activity.subject, canonical)) {
        return console.log(`[${now}] ✅ Activity ${activityId} already canonical`);
      }

      const update = await withRetry(() => pd.put(`/activities/${activityId}`, { subject: canonical }));
      if (update.data?.success) {
        console.log(`[${now}] ✅ Renamed activity ${activityId} → "${canonical}"`);
      } else {
        console.log(`[${now}] ❌ Update failed`, update.data);
      }
      return; // done
    }

    // === When a DEAL is updated (e.g., Production Team changed) ===
    if (object === "deal" && action === "updated") {
      const dealId = body?.current?.id || meta?.id || body?.deal?.id;
      if (!dealId) return console.log(`[${now}] ❌ Missing dealId in deal webhook`);

      const deal = await getDeal(dealId);
      if (!deal) return console.log(`[${now}] ❌ Deal ${dealId} not found`);

      const crew = crewNamesFromDeal(deal);
      if (crew.length === 0) {
        return console.log(`[${now}] ℹ️ Deal ${deal.id} has no Production Team set or IDs unmapped; skipping`);
      }

      const acts = await listOpenActivitiesForDeal(dealId);
      if (!acts.length) return console.log(`[${now}] ℹ️ Deal ${dealId} has no open activities`);

      let touched = 0, skipped = 0;
      for (const a of acts) {
        const typeKey = (a?.type || "").trim();
        if (!shouldRenameByKey(typeKey)) { skipped++; continue; }
        const canonical = buildSubject({ deal, activityTypeKey: typeKey, crewNames: crew });
        if (isAlreadyCanonical(a.subject, canonical)) { skipped++; continue; }
        try {
          const r = await withRetry(() => pd.put(`/activities/${a.id}`, { subject: canonical }));
          if (r.data?.success) touched++;
        } catch (err) {
          console.error(`[${now}] ❌ Failed to update activity ${a.id}`, err?.response?.data || err.message);
        }
      }
      console.log(`[${now}] ✅ Deal ${dealId} crew change pass — updated: ${touched}, skipped: ${skipped}, total open: ${acts.length}`);
      return; // done
    }

    console.log(`[${now}] ℹ️ Unhandled webhook payload`, { object, action });
  } catch (err) {
    const now2 = new Date().toISOString();
    console.error(`[${now2}] ❌ Exception:`, err?.response?.data || err.message);
  }
});

// ===== Boot =====
(async () => {
  await warmActivityTypes().catch((e) => {
    console.error("Failed to warm activity types:", e?.response?.data || e.message);
  });
  app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
})();
