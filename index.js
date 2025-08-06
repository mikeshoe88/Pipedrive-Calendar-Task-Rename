const API_TOKEN = 'd92decd10ac756b8d61ef9ee7446cebc365ae059';
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

function updateExistingTasksWithDealAndTeam() {
  const taskResponse = UrlFetchApp.fetch(`https://api.pipedrive.com/v1/activities?limit=100&api_token=${API_TOKEN}`);
  const taskData = JSON.parse(taskResponse.getContentText());

  if (!taskData.success || !taskData.data) {
    Logger.log('❌ Failed to fetch tasks');
    return;
  }

  const tasks = taskData.data;

  tasks.forEach(task => {
    if (task.done === 1) return;

    const dealId = task.deal_id;
    if (!dealId) return;

    const dealResponse = UrlFetchApp.fetch(`https://api.pipedrive.com/v1/deals/${dealId}?api_token=${API_TOKEN}`);
    const dealData = JSON.parse(dealResponse.getContentText());

    if (!dealData.success || !dealData.data) {
      Logger.log(`⚠️ Could not fetch deal ${dealId}`);
      return;
    }

    const dealTitle = dealData.data.title;
    const teamId = dealData.data[PRODUCTION_TEAM_FIELD_KEY];
    const productionTeam = PRODUCTION_TEAM_MAP[teamId];

    if (!productionTeam) {
      Logger.log(`⏭️ Skipping task ${task.id} - no valid production team.`);
      return;
    }

    const icon = task.type === 'Moisture Check/Pickup' ? '🚚' : '📌';
    const newSubject = `${icon} ${task.type} - ${dealTitle} - ${productionTeam}`;

    const updateOptions = {
      method: 'PUT',
      contentType: 'application/json',
      payload: JSON.stringify({ subject: newSubject })
    };

    const updateResponse = UrlFetchApp.fetch(`https://api.pipedrive.com/v1/activities/${task.id}?api_token=${API_TOKEN}`, updateOptions);
    const updateResult = JSON.parse(updateResponse.getContentText());

    if (updateResult.success) {
      Logger.log(`✅ Updated task ${task.id} with subject: ${newSubject}`);
    } else {
      Logger.log(`❌ Failed to update task ${task.id}`);
    }
  });
}

function createMoistureCheckTasks() {
  const props = PropertiesService.getScriptProperties();
  const processedIds = JSON.parse(props.getProperty('processedMcDealIds') || '[]');

  const response = UrlFetchApp.fetch(`https://api.pipedrive.com/v1/deals?api_token=${API_TOKEN}`);
  const data = JSON.parse(response.getContentText());

  if (!data.success || !data.data) {
    Logger.log('❌ Failed to fetch deals');
    return;
  }

  const deals = data.data;

  deals.forEach(deal => {
    const dealId = deal.id;
    const dealTitle = deal.title;
    const teamId = deal[PRODUCTION_TEAM_FIELD_KEY];
    const productionTeam = PRODUCTION_TEAM_MAP[teamId];

    if (!productionTeam) {
      Logger.log(`⏭️ Skipping task for deal ${dealId} - no valid production team.`);
      return;
    }

    if (processedIds.includes(dealId)) {
      Logger.log(`ℹ️ Deal ${dealId} already processed for MC task`);
      return;
    }

    const taskBody = {
      subject: `🚚 Moisture Check - ${dealTitle} - ${productionTeam}`,
      type: 'Moisture Check/Pickup',
      deal_id: dealId,
      done: 0,
      due_date: new Date().toISOString().split('T')[0]
    };

    const taskOptions = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(taskBody)
    };

    const taskResponse = UrlFetchApp.fetch(`https://api.pipedrive.com/v1/activities?api_token=${API_TOKEN}`, taskOptions);
    const taskResult = JSON.parse(taskResponse.getContentText());

    if (taskResult.success) {
      Logger.log(`✅ Moisture Check task created for deal ${dealId}`);
      processedIds.push(dealId);
    } else {
      Logger.log(`❌ Failed to create MC task for deal ${dealId}`);
    }
  });

  props.setProperty('processedMcDealIds', JSON.stringify(processedIds));
}

function resetProcessedMcDeals() {
  PropertiesService.getScriptProperties().deleteProperty('processedMcDealIds');
  Logger.log('✅ processedMcDealIds reset');
}
