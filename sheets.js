// sheets.js
// Reads franchisee Google Sheets via public gviz endpoint (no API key needed)
// Sheets must be shared as "Anyone with the link can view"
//
// Column mapping (from franchisee appt tracker sheets):
//   A = First Name, B = Last Name
//   F = Show (col index 5)
//   G = Membership Sold (col index 6)
//   H = $ Collected (col index 7)
//   I = Status: "Sold", "No Show", "Not Interested" (col index 8)

const https = require('https');

function fetchSheetData(sheetId, tabName) {
  return new Promise((resolve, reject) => {
    const encodedTab = encodeURIComponent(tabName);
    const url = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:json&sheet=' + encodedTab;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const jsonStr = data
            .replace(/^\/\*O_o\*\/\s*google\.visualization\.Query\.setResponse\(/, '')
            .replace(/\);?\s*$/, '');
          resolve(JSON.parse(jsonStr));
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

      if (dollars > 0) {
        totalRevenue += dollars;
        totalCloses++;
      } else if (status === 'sold') {
        totalCloses++;
      }
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
    locations
      .filter(loc => loc.google_sheet_id)
      .map(async loc => {
        // Try configured tab name first
        let metrics = await getSheetMetrics(loc.google_sheet_id, loc.sheet_tab || 'appt tracker');
        // Fallback: try with current month suffix e.g. "appt tracker -March 2026"
        if (!metrics) {
          const now = new Date();
          const month = now.toLocaleString('en-US', { month: 'long' });
          const year = now.getFullYear();
          metrics = await getSheetMetrics(loc.google_sheet_id, 'appt tracker -' + month + ' ' + year);
        }
        return { location_id: loc.location_id, ...(metrics || {}) };
      })
  );
  const byLocationId = {};
  results.forEach(r => { byLocationId[r.location_id] = r; });
  return byLocationId;
}

module.exports = { getSheetMetrics, getAllSheetMetrics };
