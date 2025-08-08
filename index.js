const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

// ===== Required env (no fallbacks) =====
const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN;
const PD_SECRET = process.env.PD_WEBHOOK_KEY; // your ?key=... value
const PRODUCTION_TEAM_FIELD_KEY = process.env.PRODUCTION_TEAM_FIELD_KEY;

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

// Activity Types we rename (must match PD labels exactly; tweak as needed)
const ALLOWED_TYPES = new Set([
  "Moisture Check",
  "Moisture Pickup",
  "Demo",
  "Estimate",
  "Inspection",
  "Production"
]);

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

const pd = axios.create({
  baseURL: "https://api.pipedrive.com/v1",
  params: { api_token: API_TOKEN },
  headers: { "Content-Type": "application/json" }
});

// -------- Helpers --------
async function getActivity(activityId) {
  const r = await pd.get(`/activities/${activityId}`);
  return r.data?.success ? r.data.data : null;
}
async function getDeal(dealId) {
  const r = await pd.get(`/deals/${dealId}`);
  return r.data?.success ? r.data.data : null;
}
function crewNamesFromDeal(deal) {
  const raw = deal?.[PRODUCTION_TEAM_FIELD_KEY];
  const ids = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return ids.map((id) => PRODUCTION_TEAM_MAP[id]).filter(Boolean);
}
function buildSubject({ deal, activity, crewNames }) {
  // Subject format — tweak if you want a different order
  // Example: [JOB 1234] Smith Residence — Moisture Check — Crew: Mike, Hector
  const jobId = deal?.id;
  const who =
    deal?.org_id?.name || deal?.person_id?.name || deal?.title || "Deal";
  const type = activity?.type || "Activity";
  const crew = crewNames.length ? ` — Crew: ${crewNames.join(", ")}` : "";
  return `[JOB ${jobId}] ${who} — ${type}${crew}`;
}
function shouldRename(activity) {
  const t = (activity?.type || "").trim();
  return ALLOWED_TYPES.has(t);
}
function isAlreadyCanonical(currentSubject, canonical) {
  return (currentSubject || "").trim() === canonical.trim();
}

// -------- Health --------
app.get("/", (_req, res) => res.send("✅ PD Activity Renamer running"));

// -------- Webhook --------
app.post("/", async (req, res) => {
  const now = new Date().toISOString();
  try {
    // Shared-secret guard (?key=...)
    if (req.query.key !== PD_SECRET) return res.status(401).send("nope");

    // Grab activity id defensively (v1/v2 payload styles)
    const body = req.body || {};
    const activityId = body?.current?.id || body?.activity?.id || body?.meta?.id;

    if (!activityId) {
      console.log(`[${now}] ❌ Missing activityId in webhook payload`);
      return res.status(200).send("no id");
    }

    // Ack quickly
    res.status(200).send("ok");

    const activity = await getActivity(activityId);
    if (!activity) return console.log(`[${now}] ❌ Activity ${activityId} not found`);

    if (!activity.deal_id) {
      return console.log(`[${now}] ℹ️ Activity ${activityId} has no deal; skipping`);
    }

    if (!shouldRename(activity)) {
      return console.log(
        `[${now}] ℹ️ Activity ${activityId} type "${activity.type}" not in allowlist; skipping`
      );
    }

    const deal = await getDeal(activity.deal_id);
    if (!deal) return console.log(`[${now}] ❌ Deal ${activity.deal_id} not found`);

    const crew = crewNamesFromDeal(deal);
    if (crew.length === 0) {
      return console.log(
        `[${now}] ℹ️ Deal ${deal.id} has no Production Team set or IDs unmapped; skipping`
      );
    }

    const canonical = buildSubject({ deal, activity, crewNames: crew });

    if (isAlreadyCanonical(activity.subject, canonical)) {
      return console.log(`[${now}] ✅ Activity ${activityId} already canonical`);
    }

    const update = await pd.put(`/activities/${activityId}`, { subject: canonical });
    if (update.data?.success) {
      console.log(`[${now}] ✅ Renamed activity ${activityId} → "${canonical}"`);
    } else {
      console.log(`[${now}] ❌ Update failed`, update.data);
    }
  } catch (err) {
    console.error(`[${now}] ❌ Exception:`, err?.response?.data || err.message);
  }
});

// -------- Boot --------
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
