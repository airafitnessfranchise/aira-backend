// sheets.js
// Reads franchisee appt tracker sheets via gviz endpoint
// Summary row pattern: col A empty, col I = total signup fees, col J = avg per close
// Data rows: col A = name, col E = status, col F = Sale?(Yes/No), col H = signup fee

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

    const rows = data.table.rows || [];
    if (rows.length < 2) return null;

    // Validate this is appt tracker format: row 1 col 1 = "APT"
    const row1 = rows[1];
    const isApptTracker = row1 && row1.c && row1.c[1] && row1.c[1].v === 'APT';
    if (!isApptTracker) return null;

    // Find the summary row: col A empty, col I (8) has a large number (total signup fees)
    let totalSignupFees = null, avgPerClose = null, summaryRowIdx = -1;
    rows.forEach((r, i) => {
      const cells = r.c || [];
      const colA = cells[0] && cells[0].v;
      const colI = cells[8] && cells[8].v != null ? Number(cells[8].v) : 0;
      const colJ = cells[9] && cells[9].v != null ? Number(cells[9].v) : 0;
      if (!colA && colI > 500) {
        // This is the summary row
        if (totalSignupFees === null || colI > totalSignupFees) {
          totalSignupFees = colI;
          avgPerClose = colJ > 0 ? Math.round(colJ) : null;
          summaryRowIdx = i;
        }
      }
    });

    // Count leads, shows, closes from data rows (skip title row 0 and header row 1)
    const dataRows = rows.slice(2).filter(r => r.c && r.c[0] && r.c[0].v);
    let totalLeads = 0, totalShows = 0, totalCloses = 0;

    for (const row of dataRows) {
      const cells = row.c || [];
      if (!cells[0] || !cells[0].v) continue;
      totalLeads++;
      const status = cells[4] && cells[4].v ? String(cells[4].v).trim().toLowerCase() : '';
      const sale = cells[5] && cells[5].v ? String(cells[5].v).trim().toLowerCase() : '';
      if (status.includes('show') && !status.includes('no show')) totalShows++;
      if (sale === 'yes') totalCloses++;
    }

    return {
      totalLeads,
      totalShows,
      showRate: totalLeads > 0 ? Math.round((totalShows / totalLeads) * 100) : 0,
      totalCloses,
      closeRate: totalLeads > 0 ? Math.round((totalCloses / totalLeads) * 100) : 0,
      totalRevenue: totalSignupFees !== null ? Math.round(totalSignupFees) : 0,
      avgPerClose: avgPerClose || (totalCloses > 0 && totalSignupFees ? Math.round(totalSignupFees / totalCloses) : 0)
    };
  } catch(err) {
    console.error('[Sheets] Error for ' + sheetId + ':', err.message);
    return null;
  }
}

async function getAllSheetMetrics(locations) {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long' });
  const year = now.getFullYear();
  const monthTab = 'appt tracker -' + month + ' ' + year;

  const results = await Promise.all(
    locations.filter(loc => loc.google_sheet_id).map(async loc => {
      let metrics = await getSheetMetrics(loc.google_sheet_id, monthTab);
      if (!metrics) metrics = await getSheetMetrics(loc.google_sheet_id, loc.sheet_tab || 'appt tracker');
      return { location_id: loc.location_id, ...(metrics || {}) };
    })
  );
  const byLocationId = {};
  results.forEach(r => { byLocationId[r.location_id] = r; });
  return byLocationId;
}

module.exports = { getSheetMetrics, getAllSheetMetrics };
