const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8080;

const API_TOKEN = process.env.PD_API_TOKEN || 'd92decd10ac756b8d61ef9ee7446cebc365ae059';
const PRODUCTION_TEAM_FIELD_KEY = '8bbab3c120ade3217b8738f001033064e803cdef';

const PRODUCTION_TEAM_MAP = {
  47: 'Kings',
  48: 'Johnathan',
  49: 'Pena',
  50: 'Hector',
  51: 'Sebastian',
  52: 'Anastacio',
  53: 'Mike',
  54: 'Kim'
};

app.use(bodyParser.json());

app.post('/', async (req, res) => {
  console.log('📩 Webhook payload received:', JSON.stringify(req.body, null, 2));
  const activityId = req.body.meta?.id || req.body.meta?.activity_id;

  if (!activityId) {
    console.log('❌ No Activity ID found');
    return res.status(400).send('Missing activity ID');
  }

  try {
    const activityRes = await axios.get(
      `https://api.pipedrive.com/v1/activities/${activityId}?api_token=${API_TOKEN}`
    );
    const activity = activityRes.data.data;

    if (!activity || activity.done === 1) {
      console.log(`⏭️ Skipping completed or missing activity: ${activityId}`);
      return res.status(200).send('Skipped');
    }

    if (!activity.deal_id) {
      console.log(`⏭️ No deal linked to activity ${activityId}`);
      return res.status(200).send('No linked deal');
    }

    const dealRes = await axios.get(
      `https://api.pipedrive.com/v1/deals/${activity.deal_id}?api_token=${API_TOKEN}`
    );
    const deal = dealRes.data.data;

    const productionId = deal[PRODUCTION_TEAM_FIELD_KEY];
    const productionName = PRODUCTION_TEAM_MAP[productionId];
    if (!productionName) {
      console.log(`⏭️ No valid production team on deal ${deal.id}`);
      return res.status(200).send('No production team');
    }

    const icon = activity.type === 'Moisture Check/Pickup' ? '🚚' : '📌';
    const newSubject = `${icon} ${activity.type} - ${deal.title} - ${productionName}`;

    const updateRes = await axios.put(
      `https://api.pipedrive.com/v1/activities/${activityId}?api_token=${API_TOKEN}`,
      { subject: newSubject },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (updateRes.data.success) {
      console.log(`✅ Renamed activity ${activityId} to "${newSubject}"`);
      return res.status(200).send('Renamed');
    } else {
      console.log(`❌ Failed to rename activity ${activityId}`);
      return res.status(500).send('Rename failed');
    }
  } catch (err) {
    console.error('❌ Error handling webhook:', err.message);
    return res.status(500).send('Internal error');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Activity rename webhook is running');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
