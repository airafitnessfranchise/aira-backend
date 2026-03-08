// locations.js
// ─────────────────────────────────────────────────────────
// Location registry for Aira Fitness Consult Recorder
// Add one entry per location/tablet
// ─────────────────────────────────────────────────────────
const locations = [
  {
        location_id: "fox-lake-01",
        franchise_name: "Aira Fitness Fox Lake",
        franchisee_name: "Fox Lake Gym Test employee",
        franchisee_email: "mikebell@airafitness.com",
        ghl_calendar_id: "e5CB1cSvhcY6dlWEUUjI"
  },
  ];

// Build lookup maps
const byCalendarId = {};
const byLocationId = {};
locations.forEach(loc => {
    byCalendarId[loc.ghl_calendar_id] = loc;
    byLocationId[loc.location_id] = loc;
});

module.exports = { locations, byCalendarId, byLocationId };
