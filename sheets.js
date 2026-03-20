// sheets.js
// Reads franchisee Google Sheets via public gviz endpoint
// appt tracker tab column mapping:
//   A (0) = Client Name
//   E (4) = Status: "show", "Cancelled", "Rescheduled", "No Show"
//   F (5) = Sale? "Yes" / "No"
//   G (6) = Monthly fee
//   H (7) = Sign up fee  <-- tracked

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

    // Detect which tab format we're reading by checking row 1 headers
    const rows = data.table.rows || [];
    if (rows.length < 2) return null;

    // Check if this is appt-tracker format: row 1 col 1 = "APT"
    const row1 = rows[1];
    const isApptTracker = row1 && row1.c && row1.c[1] && row1.c[1].v === 'APT';

    if (!isApptTracker) {
      console.log('[Sheets] Tab ' + tabName + ' is not appt tracker format, skipping');
      return null;
    }

    // Skip rows 0 (title) and 1 (header)
    const dataRows = rows.slice(2).filter(row => row.c && row.c[0] && row.c[0].v);

    let totalLeads = 0, totalShows = 0, totalCloses = 0, totalSignupFees = 0;

    for (const row of dataRows) {
      const cells = row.c || [];
      if (!cells[0] || !cells[0].v) continue;
      totalLeads++;

      const status = cells[4] && cells[4].v ? String(cells[4].v).trim().toLowerCase() : '';
      const sale = cells[5] && cells[5].v ? String(cells[5].v).trim().toLowerCase() : '';
      const signupFee = cells[7] && cells[7].v != null ? Number(cells[7].v) : 0;

      if (status.includes('show') && !status.includes('no show') && !status.includes('noshow')) {
        totalShows++;
      }
      if (sale === 'yes') {
        totalCloses++;
        if (signupFee > 0) totalSignupFees += signupFee;
      }
    }

    return {
      totalLeads,
      totalShows,
      showRate: totalLeads > 0 ? Math.round((totalShows / totalLeads) * 100) : 0,
      totalCloses,
      closeRate: totalLeads > 0 ? Math.round((totalCloses / totalLeads) * 100) : 0,
      totalRevenue: Math.round(totalSignupFees),
      avgPerClose: totalCloses > 0 ? Math.round(totalSignupFees / totalCloses) : 0
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
      // Try month-specific tab first (e.g. "appt tracker -March 2026")
      let metrics = await getSheetMetrics(loc.google_sheet_id, monthTab);
      // Fallback to generic name
      if (!metrics) {
        metrics = await getSheetMetrics(loc.google_sheet_id, loc.sheet_tab || 'appt tracker');
      }
      return { location_id: loc.location_id, ...(metrics || {}) };
    })
  );

  const byLocationId = {};
  results.forEach(r => { byLocationId[r.location_id] = r; });
  return byLocationId;
}

module.exports = { getSheetMetrics, getAllSheetMetrics };
