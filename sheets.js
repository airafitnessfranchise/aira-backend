const https = require('https');

function fetchSheet(id, tab, cb) {
  const url = 'https://docs.google.com/spreadsheets/d/' + id + '/gviz/tq?tqx=out:json&sheet=' + encodeURIComponent(tab);
  https.get(url, function(res) {
    let d = '';
    res.on('data', function(c) { d += c; });
    res.on('end', function() {
      try { cb(null, JSON.parse(d.substring(d.indexOf('(') + 1, d.lastIndexOf(')'))));
      } catch(e) { cb(e); }
    });
  }).on('error', cb);
}

function getSheetMetrics(sheetId, tabName) {
  return new Promise(function(resolve) {
    fetchSheet(sheetId, tabName, function(err, data) {
      if (err || !data || data.status !== 'ok' || !data.table) { resolve(null); return; }
      const rows = data.table.rows || [];
      if (rows.length < 2) { resolve(null); return; }
      const r1 = rows[1];
      if (!r1 || !r1.c || !r1.c[1] || r1.c[1].v !== 'APT') { resolve(null); return; }
      let grossRev = null, avgClose = null, leads = 0, shows = 0, closes = 0;
      for (let i = 0; i < rows.length; i++) {
        const c = rows[i].c || [];
        const a = c[0] && c[0].v != null ? String(c[0].v).trim() : '';
        const dv = c[3] && c[3].v != null ? Number(c[3].v) : null;
        if (a === 'Gross Revenue' && dv) { grossRev = dv; }
        if (a === 'Avg $ Per Sale' && dv) { avgClose = Math.round(dv); }
        if (i >= 2 && a && a.length > 1 && isNaN(Number(a))) {
          const ev = c[4] && c[4].v ? String(c[4].v).trim().toLowerCase() : '';
          const fv = c[5] && c[5].v ? String(c[5].v).trim().toLowerCase() : '';
          leads++;
          if (ev.indexOf('show') >= 0 && ev.indexOf('no show') < 0) { shows++; }
          if (fv === 'yes') { closes++; }
        }
      }
      resolve({ totalLeads: leads, totalShows: shows, showRate: leads > 0 ? Math.round(shows / leads * 100) : 0, totalCloses: closes, closeRate: leads > 0 ? Math.round(closes / leads * 100) : 0, totalRevenue: grossRev ? Math.round(grossRev) : 0, avgPerClose: avgClose || 0 });
    });
  });
}

function getAllSheetMetrics(locations) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const now = new Date();
  const tab = 'appt tracker -' + months[now.getMonth()] + ' ' + now.getFullYear();
  const locs = locations.filter(function(l) { return l.google_sheet_id; });
  return Promise.all(locs.map(function(loc) {
    return getSheetMetrics(loc.google_sheet_id, tab)
      .then(function(m) { return m || getSheetMetrics(loc.google_sheet_id, 'appt tracker'); })
      .then(function(m) { if (m) { m.location_id = loc.location_id; } return m || { location_id: loc.location_id }; });
  })).then(function(res) {
    const out = {};
    res.forEach(function(r) { out[r.location_id] = r; });
    return out;
  });
}

module.exports = { getSheetMetrics: getSheetMetrics, getAllSheetMetrics: getAllSheetMetrics };
