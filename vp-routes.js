// vp-routes.js
// Wire into server.js with two lines:
//   const vpRoutes = require('./vp-routes');
//   app.use(vpRoutes);

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const path = require('path');
const { dashboardLocations } = require('./dashboard-locations');
const { getAllLocationMetrics } = require('./gymmaster');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

router.get('/vp', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vp.html'));
});

router.get('/api/vp-data', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });

    const [gmData, scorecardData] = await Promise.all([
      getAllLocationMetrics(dashboardLocations, start, end).catch(err => {
        console.error('[VP] GymMaster error:', err.message);
        return {};
      }),
      getScorecardsForPeriod(start, end)
    ]);

    const locations = dashboardLocations.map(loc => {
      const gm = gmData[loc.location_id] || {};
      const sc = scorecardData[loc.location_id] || {};
      const scores = sc.scores || [];
      const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      return {
        location_id: loc.location_id,
        franchise_name: loc.franchise_name,
        gymmaster_revenue: gm.totalRevenue != null ? gm.totalRevenue : null,
        gymmaster_revenue_formatted: gm.totalRevenueFormatted || null,
        new_members: gm.newMembers != null ? gm.newMembers : null,
        current_members: gm.currentMembers != null ? gm.currentMembers : null,
        sheet_revenue: null,
        revenue_gap: false,
        avg_score: avgScore,
        last_score: scores.length ? scores[scores.length - 1] : null,
        scorecard_count: scores.length,
        score_history: scores,
        recent_scorecards: sc.recent || []
      };
    });

    res.json({ locations, period: { start, end } });
  } catch (err) {
    console.error('[VP] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function getScorecardsForPeriod(start, end) {
  try {
    const { rows } = await pool.query(`
      SELECT r.location_id, r.contact_name, sc.scorecard_id,
             sc.total_score, sc.sitdown_score, sc.objection_score,
             sc.language_score, sc.close_score, sc.created_at
      FROM scorecards sc
      JOIN recordings r ON r.recording_id = sc.recording_id
      WHERE sc.created_at >= $1 AND sc.created_at <= $2
      ORDER BY sc.created_at ASC
    `, [start, end + 'T23:59:59Z']);

    const byLocation = {};
    for (const row of rows) {
      if (!byLocation[row.location_id]) byLocation[row.location_id] = { scores: [], recent: [] };
      byLocation[row.location_id].scores.push(row.total_score);
      if (byLocation[row.location_id].recent.length < 5) {
        byLocation[row.location_id].recent.push({
          prospect_name: row.contact_name || 'Walk-in',
          total_score: row.total_score,
          sitdown_score: row.sitdown_score,
          objection_score: row.objection_score,
          language_score: row.language_score,
          close_score: row.close_score,
          created_at: row.created_at
        });
      }
    }
    return byLocation;
  } catch (err) {
    console.error('[VP] DB error:', err.message);
    return {};
  }
}

module.exports = router;
