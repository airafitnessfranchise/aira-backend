// sheets.js
// Reads franchisee appt tracker sheets via gviz endpoint
// Summary rows (found by label in col A):
//   "Gross Revenue" row -> col D (index 3) = gross revenue
//   "Avg $ Per Sale" row -> col D (index 3) = avg per close
// Data rows: col A=name, col E=status, col F=Sale?(Yes/No)

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

    // Validate: row 1 col 1 = "APT" means this is the appt tracker tab
    const row1 = rows[1];
    const isApptTracker = row1 && row1.c && row1.c[1] && row1.c[1].v === 'APT';
    if (!isApptTracker) return null;

    let grossRevenue = null, avgPerClose = null;
    let totalLeads = 0, totalShows = 0, totalCloses = 0;

    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].c || [];
      const colA = cells[0] && cells[0].v != null ? String(cells[0].v).trim() : '';
      const colD = cells[3] && cells[3].v != null ? Number(cells[3].v) : null;

      // Find summary rows by label
      if (colA === 'Gross Revenue' && colD) grossRevenue = colD;
      if (colA === 'Avg $ Per Sale' && colD) avgPerClose = Math.round(colD);

      // Count data rows (rows 2+ with a name in col A)
      if (i >= 2 && colA && colA.length > 1 && isNaN(Number(colA))) {
        const colE = cells[4] && cells[4].v ? String(cells[4].v).trim().toLowerCase() : '';
        const colF = cells[5] && cells[5].v ? String(cells[5].v).trim().toLowerCase() : '';
        totalLeads++;
        if (colE.includes('show') && !colE.includes('no show')) totalShows++;
        if (colF === 'yes') totalCloses++;
      }
    }

    return {
      totalLeads,
      totalShows,
      showRate: totalLeads > 0 ? Math.round((totalShows / totalLeads) * 100) : 0,
      totalCloses,
      closeRate: totalLeads > 0 ? Math.round((totalCloses / totalLeads) * 100) : 0,
      totalRevenue: grossRevenue !== null ? Math.round(grossRevenue) : 0,
      avgPerClose: avgPerClose || (totalCloses > 0 && grossRevenue ? Math.round(grossRevenue / totalCloses) : 0)
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
