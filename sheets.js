// sheets.js
const https = require('https');

function fetchSheetData(sheetId, tabName, callback) {
  const url = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:json&sheet=' + encodeURIComponent(tabName);
  https.get(url, function(res) {
    let data = '';
    res.on('data', function(chunk) { data += chunk; });
    res.on('end', function() {
      try {
        const start = data.indexOf('(') + 1;
        const end = data.lastIndexOf(')');
        callback(null, JSON.parse(data.substring(start, end)));
      } catch(e) { callback(e); }
    });
  }).on('error', callback);
}

function getSheetMetrics(sheetId, tabName) {
  return new Promise(function(resolve) {
    fetchSheetData(sheetId, tabName, function(err, data) {
      if (err || !data || data.status !== 'ok' || !data.table) return resolve(null);
      const rows = data.table.rows || [];
      if (rows.length < 2) return resolve(null);
      const row1 = rows[1];
      if (!row1 || !row1.c || !row1.c[1] || row1.c[1].v !== 'APT') return resolve(null);

      let grossRevenue = null, avgPerClose = null;
      let totalLeads = 0, totalShows = 0, totalCloses = 0;

      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].c || [];
        const colA = cells[0] && cells[0].v != null ? String(cells[0].v).trim() : '';
        const colD = cells[3] && cells[3].v != null ? Number(cells[3].v) : null;
        if (colA === 'Gross Revenue' && colD) grossRevenue = colD;
        if (colA === 'Avg $ Per Sale' && colD) avgPerClose = Math.round(colD);
        if (i >= 2 && colA && colA.length > 1 && isNaN(Number(colA))) {
          const colE = cells[4] && cells[4].v ? String(cells[4].v).trim().toLowerCase() : '';
          const colF = cells[5] && cells[5].v ? String(cells[5].v).trim().toLowerCase() : '';
          totalLeads++;
          if (colE.indexOf('show') >= 0 && colE.indexOf('no show') < 0) totalShows++;
          if (colF === 'yes') totalCloses++;
        }
      }

      resolve({
        totalLeads: totalLeads,
        totalShows: totalShows,
        showRate: totalLeads > 0 ? Math.round((totalShows / totalLeads) * 100) : 0,
        totalCloses: totalCloses,
        closeRate: totalLeads > 0 ? Math.round((totalCloses / totalLeads) * 100) : 0,
        totalRevenue: grossRevenue !== null ? Math.round(grossRevenue) : 0,
        avgPerClose: avgPerClose || (totalCloses > 0 && grossRevenue ? Math.round(grossRevenue / totalCloses) : 0)
      });
    });
  });
}

function getAllSheetMetrics(locations) {
  const now = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthTab = 'appt tracker -' + months[now.getMonth()] + ' ' + now.getFullYear();

  const promises = locations
    .filter(function(loc) { return loc.google_sheet_id; })
    .map(function(loc) {
      return getSheetMetrics(loc.google_sheet_id, monthTab)
        .then(function(metrics) {
          if (!metrics) return getSheetMetrics(loc.google_sheet_id, loc.sheet_tab || 'appt tracker');
          return metrics;
        })
        .then(function(metrics) {
          const result = { location_id: loc.location_id };
          if (metrics) {
            result.totalLeads = metrics.totalLeads;
            result.totalShows = metrics.totalShows;
            result.showRate = metrics.showRate;
            result.totalCloses = metrics.totalCloses;
            result.closeRate = metrics.closeRate;
            result.totalRevenue = metrics.totalRevenue;
            result.avgPerClose = metrics.avgPerClose;
          }
          return result;
        });
    });

  return Promise.all(promises).then(function(results) {
    const byLocationId = {};
    results.forEach(function(r) { byLocationId[r.location_id] = r; });
    return byLocationId;
  });
}

module.exports = { getSheetMetrics: getSheetMetrics, getAllSheetMetrics: getAllSheetMetrics };
