// dashboard-locations.js
// Separate from locations.js — zero risk to scorecard system
// Add google_sheet_id per location once franchisees share their Sheet URLs
// GymMaster company IDs sourced from Settings > Club List

const dashboardLocations = [
  { location_id: 'fox-lake-01',      franchise_name: 'Fox Lake, IL',          gymmaster_company_id: 12, google_sheet_id: '' },
  { location_id: 'grayslake-01',     franchise_name: 'Grayslake, IL',         gymmaster_company_id: 5,  google_sheet_id: '' },
  { location_id: 'gurnee-01',        franchise_name: 'Gurnee, IL',            gymmaster_company_id: 4,  google_sheet_id: '' },
  { location_id: 'mchenry-01',       franchise_name: 'McHenry, IL',           gymmaster_company_id: 2,  google_sheet_id: '' },
  { location_id: 'antioch-01',       franchise_name: 'Antioch, IL',           gymmaster_company_id: 13, google_sheet_id: '' },
  { location_id: 'richmond-01',      franchise_name: 'Richmond, IL',          gymmaster_company_id: 7,  google_sheet_id: '' },
  { location_id: 'algonquin-01',     franchise_name: 'Algonquin, IL',         gymmaster_company_id: 17, google_sheet_id: '' },
  { location_id: 'wonder-lake-01',   franchise_name: 'Wonder Lake, IL',       gymmaster_company_id: 10, google_sheet_id: '' },
  { location_id: 'conway-01',        franchise_name: 'Conway, AR',            gymmaster_company_id: 23, google_sheet_id: '' },
  { location_id: 'panama-city-01',   franchise_name: 'Panama City Beach, FL', gymmaster_company_id: 27, google_sheet_id: '' },
  { location_id: 'horizon-city-01',  franchise_name: 'Horizon City, TX',      gymmaster_company_id: 24, google_sheet_id: '' },
  { location_id: 'round-rock-01',    franchise_name: 'Round Rock, TX',        gymmaster_company_id: 26, google_sheet_id: '' },
  { location_id: 'san-marcos-01',    franchise_name: 'San Marcos, TX',        gymmaster_company_id: 28, google_sheet_id: '' },
  { location_id: 'el-paso-01',       franchise_name: 'El Paso, TX',           gymmaster_company_id: 33, google_sheet_id: '' },
  { location_id: 'west-valley-01',   franchise_name: 'West Valley, UT',       gymmaster_company_id: 21, google_sheet_id: '' },
  { location_id: 'mishawaka-01',     franchise_name: 'Mishawaka, IN',         gymmaster_company_id: null, google_sheet_id: '' },
];

module.exports = { dashboardLocations };
