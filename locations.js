// locations.js
// ────────────────────────────────────────────────────────
// Location registry for Aira Fitness Consult Recorder
// Add one entry per location/tablet
// ─────────────────────────────────────────────────────────

const locations = [
  {
    location_id: "fox-lake-01",
    franchise_name: "Aira Fitness Fox Lake",
    franchisee_name: "Fox Lake Team",
    franchisee_email: "foxlake@airafitness.com",
    ghl_calendar_id: "e5CB1cSvhcY6dlWEUUjI"
  },
  {
    location_id: "mishawaka-01",
    franchise_name: "Aira Fitness Mishawaka",
    franchisee_name: "Mishawaka Gym Employee",
    franchisee_email: "airafitnessmishawaka@gmail.com",
    vp_email: "Akathan24@gmail.com",
    ghl_calendar_id: "K3ddQpv8XLAizml9p8sF"
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
