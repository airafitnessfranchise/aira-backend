// locations.js
// ─────────────────────────────────────────────────────────
// This is your location registry.
// Add one entry per Aira location.
// ghl_calendar_id = the calendar ID from GHL for that location
// ─────────────────────────────────────────────────────────

const locations = [
  {
    location_id: "chicago-01",
    franchise_name: "Aira Fitness Chicago",
    franchisee_name: "John Smith",
    franchisee_email: "john@airachicago.com",
    ghl_calendar_id: "PASTE_GHL_CALENDAR_ID_HERE"
  },
  // Add more locations here as you roll out:
  // {
  //   location_id: "miami-01",
  //   franchise_name: "Aira Fitness Miami",
  //   franchisee_name: "Jane Doe",
  //   franchisee_email: "jane@airaMiami.com",
  //   ghl_calendar_id: "PASTE_GHL_CALENDAR_ID_HERE"
  // },
];

// Build a lookup map: ghl_calendar_id → location
const byCalendarId = {};
const byLocationId = {};

locations.forEach(loc => {
  byCalendarId[loc.ghl_calendar_id] = loc;
  byLocationId[loc.location_id] = loc;
});

module.exports = { locations, byCalendarId, byLocationId };
