const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8080;

// Constants (move to Railway ENV later)
const API_TOKEN = process.env.API_TOKEN || 'd92decd10ac756b8d61ef9ee7446cebc365ae059';
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
  console.log('📥 Incoming webhook:', JSON.stringify(req.body, null, 2));

  const body = req.body;
  const activityId = body?.current?.id;
  const dealId = body?.current?.deal_id;

  if (!activityId || !dealId) {
    console.log('❌ Missing activityId or dealId');
    return res.status(400).send('Missing activity or deal ID');
  }

  try {
    const dealResp = await axios.get(`https://api.pipedrive.com/v1/deals/${dealId}?api_token=${API_TOKEN}`);
    const deal = dealResp.data?.data;

    if (!deal) {
      console.log(`❌ Deal ${dealId} not found`);
      return res.status(404).send('Deal not found');
    }

    const dealTitle = deal.title;
    const teamId = deal[PRODUCTION_TEAM_FIELD_KEY];
    const productionTeam = PRODUCTION_TEAM_MAP[teamId];

    if (!productionTeam) {
      console.log(`⚠️ No valid team for deal ${dealId}`);
      return res.status(200).send('No valid team');
    }

    const activityResp = await axios.get(`https://api.pipedrive.com/v1/activities/${activityId}?api_token=${API_TOKEN}`);
    const activity = activityResp.data?.data;

    if (!activity) {
      console.log(`❌ Activity ${activityId} not found`);
      return res.status(404).send('Activity not found');
    }

    const lowerSubject = activity.subject?.toLowerCase() || '';
    if (!lowerSubject.includes('production') && !lowerSubject.includes('moisture_check')) {
      return res.status(200).send('Not a tracked task');
    }

    const icon = activity.type === 'Moisture Check/Pickup' ? '🚚' : '📌';
    const newSubject = `${icon} ${activity.type} - ${dealTitle} - ${productionTeam}`;

    const update = await axios.put(
      `https://api.pipedrive.com/v1/activities/${activityId}?api_token=${API_TOKEN}`,
      { subject: newSubject },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (update.data.success) {
      console.log(`✅ Updated activity ${activityId}`);
      return res.status(200).send('Updated');
    } else {
      console.log(`❌ Failed to update activity ${activityId}`);
      return res.status(500).send('Update failed');
    }
  } catch (err) {
    console.error('❌ Exception:', err.message);
    return res.status(500).send('Internal server error');
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('✅ Task Rename Webhook is running');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
