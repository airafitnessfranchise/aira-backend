// sheets.js
const https = require('https');

function fetchSheetData(sheetId, tabName) {
  return new Promise((resolve, reject) => {
    const url = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:json&sheet=' + encodeURIComponent(tabName);
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const start = data.indexOf('(') + 1;
          const end = data.lastIndexOf(')');
          resolve(JSON.parse(data.substring(start, end)));
        } catch(e) {
          reject(new Error('Parse error: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

async function getSheetMetrics(sheetId, tabName) {
  if (!sheetId) return null;
  try {
    const data = await fetchSheetData(sheetId, tabName);
    if (data.status !== 'ok' || !data.table) throw new Error('Bad status: ' + data.status);
    const rows = (data.table.rows || []).slice(1).filter(row => row.c && row.c[0] && row.c[0].v);
    let totalLeads = 0, totalShows = 0, totalCloses = 0, totalRevenue = 0;
    for (const row of rows) {
      const cells = row.c || [];
      if (!cells[0] || !cells[0].v) continue;
      totalLeads++;
      const show = cells[5] && cells[5].v ? String(cells[5].v).trim().toLowerCase() : '';
      if (show === 'yes') totalShows++;
      const dollars = cells[7] && cells[7].v != null ? Number(cells[7].v) : 0;
      const status = cells[8] && cells[8].v ? String(cells[8].v).trim().toLowerCase() : '';
      if (dollars > 0) { totalRevenue += dollars; totalCloses++; }
      else if (status === 'sold') { totalCloses++; }
    }
    return {
      totalLeads,
      totalShows,
      showRate: totalLeads > 0 ? Math.round((totalShows / totalLeads) * 100) : 0,
      totalCloses,
      closeRate: totalLeads > 0 ? Math.round((totalCloses / totalLeads) * 100) : 0,
      totalRevenue: Math.round(totalRevenue),
      avgPerClose: totalCloses > 0 ? Math.round(totalRevenue / totalCloses) : 0
    };
  } catch(err) {
    console.error('[Sheets] Error for ' + sheetId + ':', err.message);
    return null;
  }
}

async function getAllSheetMetrics(locations) {
  const results = await Promise.all(
    locations.filter(loc => loc.google_sheet_id).map(async loc => {
      let metrics = await getSheetMetrics(loc.google_sheet_id, loc.sheet_tab || 'appt tracker');
      if (!metrics) {
        const now = new Date();
        const month = now.toLocaleString('en-US', { month: 'long' });
        metrics = await getSheetMetrics(loc.google_sheet_id, 'appt tracker -' + month + ' ' + now.getFullYear());
      }
      return { location_id: loc.location_id, ...(metrics || {}) };
    })
  );
  const byLocationId = {};
  results.forEach(r => { byLocationId[r.location_id] = r; });
  return byLocationId;
}

module.exports = { getSheetMetrics, getAllSheetMetrics };
