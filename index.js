const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

// ----- Config (env with sane fallbacks) -----
const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN || "YOUR_PD_API_TOKEN";
const PD_SECRET = process.env.PD_WEBHOOK_KEY || "8675309"; // your shared secret (?key=...)
const PRODUCTION_TEAM_FIELD_KEY =
  process.env.PRODUCTION_TEAM_FIELD_KEY ||
  "8bbab3c120ade3217b8738f001033064e803cdef";

// Make sure these labels match your PD custom field options (enum IDs → names)
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

// Only these activity types will be renamed (match PD’s Activity Type exactly)
const ALLOWED_TYPES = new Set([
  "Moisture Check",
  "Moisture Pickup",
  "Demo",
  "Estimate",
  "Inspection",
  "Production"
]);

// -------------------------------------------

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

const pd = axios.create({
  baseURL: "https://api.pipedrive.com/v1",
  params: { api_token: API_TOKEN },
  headers: { "Content-Type": "application/json" }
});

// Helpers
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
  if (raw == null) return [];

  // Handle single ID or multi-select (array of IDs)
  const ids = Array.isArray(raw) ? raw : [raw];
  return ids.map((id) => PRODUCTION_TEAM_MAP[id]).filter(Boolean);
}

function buildSubject({ deal, activity, crewNames }) {
  // Tweak this template to taste
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

// Health
app.get("/", (_req, res) => res.send("✅ PD Activity Renamer running"));

// Webhook
app.post("/", async (req, res) => {
  try {
    // Simple shared-secret check (?key=...)
    if (req.query.key !== PD_SECRET) return res.status(401).send("nope");

    const body = req.body || {};
    // Pipedrive webhook payloads vary, so be defensive
    const activityId = body?.current?.id || body?.activity?.id || body?.meta?.id;

    if (!activityId) {
      console.log("❌ Missing activityId in webhook");
      return res.status(200).send("no id");
    }

    // Acknowledge early
    res.status(200).send("ok");

    const activity = await getActivity(activityId);
    if (!activity) return console.log(`❌ Activity ${activityId} not found`);

    if (!activity.deal_id) {
      return console.log(`ℹ️ Activity ${activityId} has no deal; skipping`);
    }
    const deal = await getDeal(activity.deal_id);
    if (!deal) return console.log(`❌ Deal ${activity.deal_id} not found`);

    if (!shouldRename(activity)) {
      return console.log(
        `ℹ️ Activity ${activityId} type "${activity.type}" not allowed; skipping`
      );
    }

    const crew = crewNamesFromDeal(deal);
    if (crew.length === 0) {
      return console.log(
        `ℹ️ Deal ${deal.id} has no Production Team set; skipping`
      );
    }

    const canonical = buildSubject({ deal, activity, crewNames: crew });
    if (isAlreadyCanonical(activity.subject, canonical)) {
      return console.log(`✅ Activity ${activityId} already canonical`);
    }

    // Rename (idempotent)
    const update = await pd.put(`/activities/${activityId}`, {
      subject: canonical
    });

    if (update.data?.success) {
      console.log(`✅ Renamed activity ${activityId} → "${canonical}"`);
    } else {
      console.log(`❌ Failed to update activity ${activityId}`, update.data);
    }
  } catch (err) {
    // Don’t throw after we ack’d
    const msg = err?.response?.data || err.message;
    console.error("❌ Exception:", msg);
  }
});

// Boot
app.listen(PORT, () => {
  console.log(`🚀 Listening on ${PORT}`);
});
