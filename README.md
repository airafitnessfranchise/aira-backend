# Aira Fitness — Consult Recorder Backend

This system records sales consultations at each Aira Fitness location, scores them with AI, and emails scorecards to the franchisee, Mike, and the VP.

**Live server:** https://aira-backend-production-2a71.up.railway.app

---

## How to Add a New Location

This is the only file you need to edit: `locations.js`

### Step 1 — Open `locations.js`

You'll see a list of locations that looks like this:

```js
const locations = [
  {
    location_id: "Fox-Lake-01",
    franchise_name: "Aira Fitness Fox Lake",
    franchisee_name: "Fox Lake Gym Test employee",
    franchisee_email: "mikebell@airafitness.com",
    ghl_calendar_id: "e5CB1cSvhcY6dlWEUUjI"
  },
  ...
];
```

### Step 2 — Add a new entry

Copy and paste one of the existing entries and fill in the details for the new location:

```js
{
  location_id: "CityName-01",               // No spaces — used in the tablet URL
  franchise_name: "Aira Fitness City Name", // Full display name
  franchisee_name: "Employee Name",         // Who works there (shows in email greeting)
  franchisee_email: "owner@email.com",      // Franchisee gets the scorecard
  vp_email: "vp@email.com",                 // VP gets a copy (optional)
  ghl_calendar_id: ""                       // Paste the GHL calendar ID here (see Step 3)
}
```

> Make sure to add a comma after the previous entry's closing `}`.

### Step 3 — Get the GHL Calendar ID

1. Log into GoHighLevel
2. Go to the location's calendar settings
3. Copy the calendar ID from the URL or settings page
4. Paste it into `ghl_calendar_id`

### Step 4 — Push to GitHub

Open Terminal and run:

```bash
cd ~/Desktop/aira-backend
git add locations.js
git commit -m "Add [City Name] location"
git push
```

Railway will automatically redeploy within ~1 minute.

### Step 5 — Give the franchisee their tablet link

The tablet link for a new location is always:

```
https://aira-backend-production-2a71.up.railway.app/recorder.html?location=LOCATION_ID
```

Replace `LOCATION_ID` with whatever you put in the `location_id` field.

**Examples:**
- Fox Lake: `https://aira-backend-production-2a71.up.railway.app/recorder.html?location=Fox-Lake-01`
- Mishawaka: `https://aira-backend-production-2a71.up.railway.app/recorder.html?location=Mishawaka-01`

---

## Current Locations

| Location | Tablet Link |
|---|---|
| Fox Lake, IL | https://aira-backend-production-2a71.up.railway.app/recorder.html?location=Fox-Lake-01 |
| Mishawaka, IN | https://aira-backend-production-2a71.up.railway.app/recorder.html?location=Mishawaka-01 |

---

## Who Gets the Scorecard Emails

Every scorecard is sent to three people:
1. **Franchisee** — the email in `franchisee_email`
2. **Mike** — mikebell@airafitness.com (always)
3. **VP** — the email in `vp_email` (if provided)

---

## Admin Dashboard

View all recordings and scores:
https://aira-backend-production-2a71.up.railway.app/admin
