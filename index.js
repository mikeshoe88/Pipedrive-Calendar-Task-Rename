const axios = require("axios");

const API_TOKEN = process.env.API_TOKEN; // REQUIRED
const ENDPOINT = process.env.WEBHOOK_ENDPOINT || "https://pipedrive-calendar-task-rename-production.up.railway.app/?key=8675309";

if (!API_TOKEN) {
  console.error("Missing API_TOKEN env var");
  process.exit(1);
}

const client = axios.create({
  baseURL: "https://api.pipedrive.com/v1",
  params: { api_token: API_TOKEN },
  headers: { "Content-Type": "application/json" }
});

async function create(event_action, event_object = "activity") {
  const r = await client.post("/webhooks", {
    subscription_url: ENDPOINT,
    event_action,
    event_object
  });
  return r.data;
}

(async () => {
  try {
    console.log("Creating webhook: activity.updated →", ENDPOINT);
    const a = await create("updated");
    console.log("→", a);

    console.log("Creating webhook: activity.added →", ENDPOINT);
    const b = await create("added");
    console.log("→", b);

    console.log("✅ Done");
  } catch (e) {
    console.error("❌ Error:", e?.response?.data || e.message);
    process.exit(1);
  }
})();
