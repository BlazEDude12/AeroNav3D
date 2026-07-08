# AeroNav3D

**Live site: https://aeronav3d.vercel.app**

An interactive 3D globe showing live air traffic worldwide. Click any plane to
see its altitude, speed, and a glowing trail of where it's been. Sign in to
save flights to your **My Flights** panel and spot them live on the globe.

## How it works

- **The page** (`index.html`) — a single self-contained page: CesiumJS globe,
  Google satellite imagery, NASA night-lights on the dark side of the Earth,
  and all the flight/trail/favorites logic. Hosted on Vercel.
- **The backend** (Supabase project `aeronav3d`, region us-west-1):
  - `flights` Edge Function (`supabase/functions/flights/index.ts`) — serves
    live aircraft for the area you're looking at. It queries three public
    ADS-B networks with automatic failover (airplanes.live → adsb.fi →
    adsb.lol), caches responses for 8 s in the `feed_cache` table, and
    records position snapshots every 30 s for trails.
  - `flight_positions` table — the last hour of recorded plane positions
    (older rows auto-deleted every 10 minutes by pg_cron). Read-only to
    browsers.
  - `favorites` table — starred flights per account, protected by row-level
    security so each user only ever sees their own.
  - Auth — email + password ("confirm email" should be OFF in the dashboard;
    the free tier can't send enough confirmation emails for a public site).
- **Fallbacks** — if the Supabase function is ever unreachable, the page
  automatically switches to the original Cloudflare Worker proxy
  (`worker.js`); if Google imagery ever stops working, it automatically
  switches to keyless Esri World Imagery. Visitors never see an outage.

## Working on the site

- Run locally: `python3 server.py`, then open http://localhost:8321
  (flight data still comes from the real Supabase backend).
- Deploy: `npx vercel deploy --prod --yes` from this folder
  (or push to GitHub and use Vercel's Git integration).
- Design/plan documents live in `docs/superpowers/`.

## Data credits

Flight data: [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi),
[airplanes.live](https://airplanes.live). Imagery: Google Maps Platform,
Cesium, NASA GIBS (VIIRS Black Marble).
