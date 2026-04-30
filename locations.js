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
    ghl_calendar_id: "e5CB1cSvhcY6dlWEUUjI",
  },
  {
    location_id: "mishawaka-01",
    franchise_name: "Aira Fitness Mishawaka",
    franchisee_name: "Mishawaka Gym Employee",
    franchisee_email: "airafitnessmishawaka@gmail.com",
    vp_email: "Akathan24@gmail.com",
    ghl_calendar_id: "K3ddQpv8XLAizml9p8sF",
  },
];

// Build lookup maps
const byCalendarId = {};
const byLocationId = {};
locations.forEach((loc) => {
  byCalendarId[loc.ghl_calendar_id] = loc;
  byLocationId[loc.location_id] = loc;
});

// Historical aliases — old recordings used un-suffixed slugs; one had a stray apostrophe.
// Maps any known variant to the canonical location_id so analytics don't fragment.
const LOCATION_ALIASES = {
  "fox-lake": "fox-lake-01",
  "fox-lake-01'": "fox-lake-01",
  mishawaka: "mishawaka-01",
};
function canonicalLocationId(id) {
  const lower = (id || "").toLowerCase().trim();
  return LOCATION_ALIASES[lower] || lower;
}

module.exports = { locations, byCalendarId, byLocationId, canonicalLocationId };
