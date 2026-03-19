// gymmaster.js
// Fetches KPI data from GymMaster Reporting API v2
// Requires: GYMMASTER_STAFF_API_KEY env var

const GM_BASE = 'https://airafitness.gymmasteronline.com';

async function fetchGymMasterKPI(companyId, startDate, endDate) {
  const apiKey = process.env.GYMMASTER_STAFF_API_KEY;
  if (!apiKey) {
    console.warn('[GymMaster] GYMMASTER_STAFF_API_KEY not set — skipping');
    return null;
  }
  const res = await fetch(GM_BASE + '/api/v2/report/kpi/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({
      date: { start: startDate, end: endDate },
      selected_categories: ['sales_made', 'member_statistics', 'membership_activity'],
      grouped_categories: true,
      company_id: companyId
    })
  });
  const data = await res.json();
  if (data.error && (Array.isArray(data.error) ? data.error.length : data.error)) {
    throw new Error('GymMaster API: ' + JSON.stringify(data.error));
  }
  return data.result;
}

async function getLocationMetrics(companyId, startDate, endDate) {
  try {
    const result = await fetchGymMasterKPI(companyId, startDate, endDate);
    if (!result) return { totalRevenue: null, totalRevenueFormatted: 'N/A', newMembers: null, currentMembers: null };
    const salesMade = result.sales_made || [];
    const memberStats = result.member_statistics || [];
    const memberActivity = result.membership_activity || [];
    const totalSalesField = salesMade.find(function(f) { return f.money && f.money.name && f.money.name.toLowerCase().includes('total sales'); });
    const totalRevenue = totalSalesField ? totalSalesField.money.value : 0;
    const totalRevenueFormatted = totalSalesField ? totalSalesField.money.formatted_value : '$0.00';
    const newField = memberActivity.find(function(f) { return f.memberships && f.memberships.name && f.memberships.name.toLowerCase().includes('new'); });
    const newMembers = newField ? newField.memberships.value : 0;
    const currentField = memberStats.find(function(f) { return f.members && f.members.name && f.members.name.toLowerCase().includes('current'); });
    const currentMembers = currentField ? currentField.members.value : 0;
    return { totalRevenue, totalRevenueFormatted, newMembers, currentMembers };
  } catch (err) {
    console.error('[GymMaster] Error for company ' + companyId + ':', err.message);
    return { totalRevenue: null, totalRevenueFormatted: 'N/A', newMembers: null, currentMembers: null, error: err.message };
  }
}

async function getAllLocationMetrics(locations, startDate, endDate) {
  const results = await Promise.all(
    locations
      .filter(function(loc) { return loc.gymmaster_company_id; })
      .map(function(loc) {
        return getLocationMetrics(loc.gymmaster_company_id, startDate, endDate)
          .then(function(metrics) { return Object.assign({ location_id: loc.location_id }, metrics); });
      })
  );
  const byLocationId = {};
  results.forEach(function(r) { byLocationId[r.location_id] = r; });
  return byLocationId;
}

module.exports = { getLocationMetrics, getAllLocationMetrics };
