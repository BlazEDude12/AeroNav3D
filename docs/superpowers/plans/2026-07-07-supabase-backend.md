# AeroNav3D Supabase Backend + Vercel Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy AeroNav3D as a live website on Vercel with a Supabase backend providing the flight feed, click-to-see flight trails, and email+password favorites.

**Architecture:** The existing index.html stays visually unchanged. A Supabase Edge Function `flights` replaces the Cloudflare Worker as the primary feed (same `?circle=` API, 3-upstream failover, in-memory cache) and snapshots positions into Postgres for trails. supabase-js (CDN) powers trails, auth, and favorites in the page. Vercel serves the static site.

**Tech Stack:** Supabase (Edge Functions/Deno, Postgres, pg_cron, Auth, RLS), supabase-js v2 (CDN), CesiumJS (already present), Vercel static hosting.

**Testing policy:** No unit-test scaffold exists (single-page CDN app); every task verifies against the real running system — `curl` against the deployed function, SQL row checks, and the browser preview / live site. This is a deliberate deviation from TDD, matching the user's "verify by running the app" standard.

**Spec:** `docs/superpowers/specs/2026-07-07-supabase-backend-design.md`

**User check-ins (required, per user preference):** after Task 4 (feed live), Task 5 (trails), Task 6 (favorites), Task 7 (deployed site).

---

### Task 1: Create the Supabase project

Uses the Supabase MCP tools (already authenticated, org `jjcyzhjlluivllghrybn` "AroNav3D").

- [ ] **Step 1:** `get_cost` (type `project`, org `jjcyzhjlluivllghrybn`) — expect $0 on free plan. `confirm_cost` with that amount, keep the confirmation id.
- [ ] **Step 2:** `create_project` name `aeronav3d`, region `us-west-1` (user's Mac is America/Los_Angeles), org `jjcyzhjlluivllghrybn`, with the confirmation id.
- [ ] **Step 3:** Poll `get_project` until status is `ACTIVE_HEALTHY` (takes a few minutes).
- [ ] **Step 4:** `get_project_url` and `get_publishable_keys` — record PROJECT_URL and ANON_KEY for Tasks 4–6. (Every later occurrence of `PROJECT_REF.supabase.co` / `ANON_KEY` means these values.)

### Task 2: Database schema

**Files:**
- Create: `supabase/migrations/0001_flight_positions.sql`
- Create: `supabase/migrations/0002_favorites.sql`

- [ ] **Step 1: Write `supabase/migrations/0001_flight_positions.sql`** (repo copy of what gets applied via MCP `apply_migration`, name `flight_positions`):

```sql
-- Position snapshots written by the flights Edge Function (service role).
-- Read-only to browsers; rows older than 60 min are deleted by pg_cron.
create table public.flight_positions (
  id bigint generated always as identity primary key,
  hex text not null,
  ts timestamptz not null default now(),
  lat double precision not null,
  lon double precision not null,
  alt_ft integer,
  callsign text
);

create index flight_positions_hex_ts on public.flight_positions (hex, ts);
create index flight_positions_ts on public.flight_positions (ts);

alter table public.flight_positions enable row level security;

create policy "public read" on public.flight_positions
  for select to anon, authenticated using (true);

-- Hourly retention, enforced every 10 minutes.
create extension if not exists pg_cron;
select cron.schedule(
  'flight-positions-cleanup',
  '*/10 * * * *',
  $$delete from public.flight_positions where ts < now() - interval '60 minutes'$$
);
```

- [ ] **Step 2:** Apply it with MCP `apply_migration` (project id from Task 1, name `flight_positions`, query = file content).
- [ ] **Step 3: Write `supabase/migrations/0002_favorites.sql`** and apply via `apply_migration` (name `favorites`):

```sql
-- Starred flights per signed-in user. RLS: owners only.
create table public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  hex text not null,
  callsign text,
  created_at timestamptz not null default now(),
  unique (user_id, hex)
);

alter table public.favorites enable row level security;

create policy "own rows select" on public.favorites
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows insert" on public.favorites
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows delete" on public.favorites
  for delete to authenticated using ((select auth.uid()) = user_id);
```

- [ ] **Step 4: Verify.** MCP `execute_sql`: `select count(*) from public.flight_positions; select jobname, schedule from cron.job; select relrowsecurity from pg_class where relname in ('flight_positions','favorites');` Expect: 0 rows, the cleanup job listed, RLS `true` for both tables. Also run MCP `get_advisors` (security) — expect no errors about these tables.
- [ ] **Step 5: Commit** `git add supabase/migrations && git commit -m "feat: flight_positions + favorites schema with RLS and pg_cron retention"`.

### Task 3: The `flights` Edge Function

**Files:**
- Create: `supabase/functions/flights/index.ts`

- [ ] **Step 1: Write `supabase/functions/flights/index.ts`:**

```ts
// AeroNav3D flight feed.
//
// GET /flights?circle=lat,lon,radiusNm
// Proxies public ADS-B aggregators with failover and a short in-memory
// cache (the aggregators rate-limit shared egress IPs aggressively), and
// snapshots aircraft positions to Postgres — at most once per SNAPSHOT_MS
// per area — so the frontend can draw flight trails.

import { createClient } from "npm:@supabase/supabase-js@2";

const UPSTREAMS = [
  (lat: number, lon: number, rad: number) =>
    `https://api.adsb.lol/v2/point/${lat}/${lon}/${rad}`,
  (lat: number, lon: number, rad: number) =>
    `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${rad}`,
  (lat: number, lon: number, rad: number) =>
    `https://api.airplanes.live/v2/point/${lat}/${lon}/${rad}`,
];

const FRESH_MS = 8_000; // serve cached responses this fresh without refetching
const SNAPSHOT_MS = 30_000; // min gap between trail snapshots per area
const MAX_CACHE_KEYS = 200; // memory guard while the isolate stays warm

const cache = new Map<string, { at: number; body: string }>();
const lastSnapshot = new Map<string, number>();

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const circle = new URL(req.url).searchParams.get("circle");
  if (!circle) return json(JSON.stringify({ error: "missing circle" }), 400);
  let [lat, lon, rad] = circle.split(",").map(Number);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json(JSON.stringify({ error: "bad circle" }), 400);
  }
  // Round the query so nearby viewers share one cache entry
  lat = Math.round(lat * 4) / 4;
  lon = Math.round(lon * 4) / 4;
  rad = Math.min(Math.round(rad) || 250, 250);

  const key = `${lat},${lon},${rad}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return json(hit.body, 200, { "X-Cache": "hit" });

  for (const buildUrl of UPSTREAMS) {
    try {
      const r = await fetch(buildUrl(lat, lon, rad), {
        headers: { "User-Agent": "AeroNav3D (github.com/Prithvi-Web/AeroNav3D)" },
        signal: AbortSignal.timeout(7_000),
      });
      if (!r.ok) continue; // rate-limited or down — try the next aggregator
      const body = await r.text();
      let parsed: { aircraft?: unknown[]; ac?: unknown[] };
      try {
        parsed = JSON.parse(body);
      } catch {
        continue; // garbage response — try the next aggregator
      }
      if (cache.size >= MAX_CACHE_KEYS) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), body });
      snapshot(key, parsed);
      return json(body, 200, { "X-Cache": "miss" });
    } catch {
      // network error / timeout — try the next aggregator
    }
  }

  if (hit) return json(hit.body, 200, { "X-Cache": "stale" }); // stale beats nothing
  return json(JSON.stringify({ error: "flight data upstreams unavailable" }), 502);
});

// Fire-and-forget: trail data must never slow down or break the feed.
function snapshot(key: string, parsed: { aircraft?: unknown[]; ac?: unknown[] }) {
  const now = Date.now();
  if (now - (lastSnapshot.get(key) ?? 0) < SNAPSHOT_MS) return;
  lastSnapshot.set(key, now);

  const list = (parsed.aircraft ?? parsed.ac ?? []) as Record<string, unknown>[];
  const rows = list
    .filter((a) =>
      typeof a.lat === "number" && typeof a.lon === "number" &&
      typeof a.hex === "string"
    )
    .map((a) => ({
      hex: a.hex as string,
      lat: a.lat as number,
      lon: a.lon as number,
      alt_ft: typeof a.alt_baro === "number" ? Math.round(a.alt_baro) : null,
      callsign: typeof a.flight === "string" ? (a.flight as string).trim() || null : null,
    }));
  if (!rows.length) return;

  const insert = supabase.from("flight_positions").insert(rows).then(({ error }) => {
    if (error) console.error("snapshot insert failed:", error.message);
  });
  try {
    // Provided by the Supabase edge runtime; lets the insert finish after
    // the response is sent.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime.waitUntil(insert);
  } catch {
    /* runtime without waitUntil: insert continues best-effort */
  }
}
```

- [ ] **Step 2: Deploy** via MCP `deploy_edge_function`: name `flights`, entrypoint `index.ts`, `verify_jwt: false` — justified: it serves public ADS-B data, does its own caching, and must be fetchable by plain `fetch()` from the static page (design approved by user).
- [ ] **Step 3: Verify live.**
  - `curl -s "https://PROJECT_REF.supabase.co/functions/v1/flights?circle=34,-118,250"` → JSON containing an `ac` or `aircraft` array with entries (LA area always has traffic). Repeat immediately → response header `X-Cache: hit` (`curl -si ... | grep -i x-cache`).
  - `curl -s "...?circle=999,0,250"` → `{"error":"bad circle"}` with HTTP 400.
  - MCP `execute_sql`: `select count(*), max(ts) from public.flight_positions;` → count > 0 (snapshot written).
  - MCP `get_logs` (edge-function) if anything fails.
- [ ] **Step 4: Commit** `git add supabase/functions && git commit -m "feat: flights Edge Function — 3-upstream failover, cache, trail snapshots"`.

### Task 4: Frontend — feed via Supabase  → CHECK-IN #1

**Files:**
- Modify: `index.html` (config block around line 178 and `FLIGHT_DATA_URL` around line 322)

- [ ] **Step 1:** In the CONFIGURATION block after `GOOGLE_MAP_TYPE`, add:

```js
/* Supabase backend (flight feed, trails, favorites) */
const SUPABASE_URL = "https://PROJECT_REF.supabase.co"; // real value from Task 1
const SUPABASE_ANON_KEY = "ANON_KEY";                   // real value from Task 1
const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
```

- [ ] **Step 2:** Replace `const FLIGHT_DATA_URL = "/flights";` with:

```js
// Local dev uses server.py's /flights proxy; everywhere else, Supabase.
const FLIGHT_DATA_URL = IS_LOCAL ? "/flights" : SUPABASE_URL + "/functions/v1/flights";
```

Keep `FLIGHT_PROXY_FALLBACK` (the Cloudflare Worker) unchanged — it remains the emergency fallback, giving two independent backends.

- [ ] **Step 3: Verify in browser.** `preview_start` config `aeronav3d` (python server.py, port 8321). Confirm via `preview_console_logs` (no errors), `preview_snapshot` (brand tag shows "· N live"). Then verify the production path: `preview_eval` → `fetch(SUPABASE_URL + "/functions/v1/flights?circle=34,-118,250").then(r => r.json()).then(j => (j.ac || j.aircraft).length)` → returns a number > 0.
- [ ] **Step 4: Commit** and **check in with the user**: feed now runs on their Supabase backend; show proof (screenshot).

### Task 5: Flight trails  → CHECK-IN #2

**Files:**
- Modify: `index.html` (add supabase-js script tag in `<head>`; trail logic in the LIVE FLIGHTS section; hooks in `pollFlights`, the pick handler, and `closeFlightPanel`)

- [ ] **Step 1:** In `<head>` after the Cesium script tag add:

```html
<!-- Supabase (flight trails + favorites) -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
```

- [ ] **Step 2:** After the `const PLANE_SELECTED = ...` line add the client + trail module:

```js
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ----- Flight trail: recent path of the selected plane ----- */
const TRAIL_GAP_MS = 5 * 60 * 1000;  // data gaps longer than this break the line
let trailEntities = [];              // all polyline entities of the current trail
let trailPositions = [];             // live segment; grows as new polls arrive
let trailHex = null;

function clearTrail() {
  trailEntities.forEach((e) => viewer.entities.remove(e));
  trailEntities = [];
  trailPositions = [];
  trailHex = null;
}

function addTrailSegment(positions) {
  const entity = viewer.entities.add({
    polyline: {
      positions,
      width: 5,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.25,
        color: PLANE_SELECTED.withAlpha(0.85)
      })
    }
  });
  trailEntities.push(entity);
  return entity;
}

async function showTrail(hex) {
  clearTrail();
  trailHex = hex;
  let history = [];
  try {
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const { data, error } = await sb
      .from("flight_positions")
      .select("ts,lat,lon,alt_ft")
      .eq("hex", hex)
      .gte("ts", since)
      .order("ts");
    if (error) throw error;
    history = data || [];
  } catch (err) {
    console.warn("Trail history unavailable:", err.message || err);
  }
  if (trailHex !== hex) return; // selection changed while loading

  // Static segments for history, split at long gaps; the last segment
  // becomes the live one and keeps growing while the plane is selected.
  let seg = [];
  let prevTs = 0;
  for (const p of history) {
    const t = Date.parse(p.ts);
    if (seg.length && t - prevTs > TRAIL_GAP_MS) {
      if (seg.length > 1) addTrailSegment(seg);
      seg = [];
    }
    seg.push(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, (p.alt_ft || 0) * FT_TO_M));
    prevTs = t;
  }
  trailPositions = seg;
  const live = addTrailSegment([]);
  live.polyline.positions = new Cesium.CallbackProperty(() => trailPositions, false);
}

function extendTrail(ac) {
  if (!trailHex || ac.hex !== trailHex) return;
  trailPositions.push(
    Cesium.Cartesian3.fromDegrees(ac.lon, ac.lat, flightAltitudeMeters(ac))
  );
}
```

- [ ] **Step 3: Hook it up.**
  - In `pollFlights`, right after `f.data = ac;` add `extendTrail(ac);`
  - In the pick handler, after `flightPanel.style.display = "block";` add `if (trailHex !== hex) showTrail(hex);`
  - In `closeFlightPanel()`, add `clearTrail();` after the display:none line.
- [ ] **Step 4: Verify in browser.** Wait ≥2 min after Task 3 deploy (snapshots accumulating). Reload preview, click a plane → glowing blue trail behind it; watch it extend after the next polls. `preview_console_logs` clean; `preview_screenshot` as proof. Also verify anon read works but writes are blocked: `preview_eval` → `sb.from("flight_positions").insert({hex:"x",lat:0,lon:0}).then(r => r.error.message)` → RLS error message.
- [ ] **Step 5: Commit** and **check in with the user** (screenshot of a trail).

### Task 6: Favorites + sign-in  → CHECK-IN #3

**Files:**
- Modify: `index.html` (CSS additions; star button in panel head; My Flights button/panel + auth card HTML before the loader div; favorites/auth JS after the trail module; hooks in `updateFlightPanel` and `pollFlights`)

- [ ] **Step 1: CSS** — append to the `<style>` block (dark-glass style matching existing panels):

```css
/* ---------- Favorites / auth ---------- */
.panel-head .actions{display:flex;gap:2px;}
#fpStar.active{color:#ffd76a;}
.mf-toggle{
  position:absolute;top:20px;right:20px;z-index:10;cursor:pointer;
  display:flex;align-items:center;gap:7px;padding:10px 14px;border-radius:12px;
  background:var(--panel);border:1px solid var(--border);color:var(--text);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  font-size:12px;letter-spacing:.06em;
}
.mf-toggle:hover{background:rgba(40,55,85,.85);border-color:rgba(120,180,255,.4);}
.mf-toggle .star{color:#ffd76a;font-size:14px;}
.mf-panel{
  position:absolute;top:72px;right:20px;z-index:10;width:248px;
  background:var(--panel);border:1px solid var(--border);border-radius:12px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  display:none;overflow:hidden;
}
.mf-head{display:flex;justify-content:space-between;align-items:center;
  padding:12px 14px 10px;border-bottom:1px solid var(--border);}
.mf-title{font-size:13px;font-weight:700;letter-spacing:.08em;}
.mf-head a{color:var(--muted);font-size:11px;text-decoration:none;cursor:pointer;}
.mf-head a:hover{color:var(--text);}
.mf-list{max-height:290px;overflow-y:auto;}
.mf-empty{padding:16px 14px;font-size:12px;color:var(--muted);line-height:1.5;}
.mf-item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;
  padding:10px 14px;background:none;border:none;border-bottom:1px solid var(--border);
  color:var(--text);cursor:pointer;font-size:13px;}
.mf-item:last-child{border-bottom:none;}
.mf-item:hover{background:rgba(40,55,85,.6);}
.mf-item .dot{width:7px;height:7px;border-radius:50%;background:#39ff8e;
  box-shadow:0 0 6px #39ff8e;flex:none;}
.mf-item .dot.off{background:#3a4披660;box-shadow:none;}
.mf-item .cs{font-weight:600;letter-spacing:.05em;flex:1;}
.mf-item .live{font-size:9px;letter-spacing:.2em;color:#39ff8e;}
.mf-item .rm{color:var(--muted);font-size:12px;padding:2px 4px;}
.mf-item .rm:hover{color:#ff7d7d;}
.auth-overlay{
  position:absolute;inset:0;z-index:30;display:none;
  align-items:center;justify-content:center;background:rgba(4,6,12,.55);
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
}
.auth-card{
  position:relative;width:300px;padding:22px;border-radius:14px;
  background:var(--panel);border:1px solid var(--border);
}
.auth-card h2{font-size:16px;letter-spacing:.04em;margin-bottom:4px;}
.auth-card .sub{font-size:11px;color:var(--muted);margin-bottom:16px;}
.auth-card input{
  width:100%;margin-bottom:10px;padding:10px 12px;border-radius:9px;
  background:rgba(8,12,22,.7);border:1px solid var(--border);color:var(--text);
  font-size:13px;outline:none;
}
.auth-card input:focus{border-color:rgba(120,180,255,.5);}
.auth-error{font-size:11px;color:#ff9d9d;min-height:15px;margin-bottom:8px;line-height:1.4;}
.auth-primary{
  width:100%;padding:10px;border-radius:9px;border:none;cursor:pointer;
  background:var(--accent);color:#04121d;font-size:13px;font-weight:700;
}
.auth-primary:hover{filter:brightness(1.1);}
.auth-alt{font-size:11px;color:var(--muted);margin-top:12px;text-align:center;}
.auth-alt a{color:var(--accent);cursor:pointer;text-decoration:none;}
.auth-close{position:absolute;top:10px;right:12px;background:none;border:none;
  color:var(--muted);font-size:14px;cursor:pointer;}
.auth-close:hover{color:var(--text);}
@media (max-width:600px){
  .mf-toggle{top:auto;bottom:76px;right:12px;}
  .mf-panel{top:auto;bottom:128px;right:12px;left:12px;width:auto;}
}
```

(Note: the `.mf-item .dot.off` line above must read `background:#3a4660;` — fix any mojibake when writing the real file.)

- [ ] **Step 2: HTML.** Replace the close button in the flight panel head with an actions group:

```html
    <div class="actions">
      <button id="fpStar" aria-label="Save to My Flights" title="Save to My Flights">☆</button>
      <button id="fpClose" aria-label="Close flight details">✕</button>
    </div>
```

(`#fpStar` inherits the existing `.panel-head button` styling.) Before the `<div class="hint" ...>` line add:

```html
<!-- My Flights -->
<button class="mf-toggle" id="mfToggle" aria-expanded="false">
  <span class="star">★</span> My Flights
</button>
<div class="mf-panel" id="mfPanel">
  <div class="mf-head">
    <div class="mf-title">MY FLIGHTS</div>
    <a id="mfAuthLink">Sign in</a>
  </div>
  <div class="mf-list" id="mfList"></div>
</div>

<!-- Sign-in card -->
<div class="auth-overlay" id="authOverlay">
  <div class="auth-card">
    <button class="auth-close" id="authClose" aria-label="Close">✕</button>
    <h2 id="authTitle">Sign in</h2>
    <div class="sub">Save flights and spot them live on the globe.</div>
    <input id="authEmail" type="email" placeholder="Email" autocomplete="email">
    <input id="authPass" type="password" placeholder="Password (min 6 characters)" autocomplete="current-password">
    <div class="auth-error" id="authError"></div>
    <button class="auth-primary" id="authSubmit">Sign in</button>
    <div class="auth-alt" id="authAlt">No account? <a id="authMode">Create one</a></div>
  </div>
</div>
```

Note: the notice element also sits top-right; move it down so they never overlap — change `.notice` CSS `top:20px` → `top:72px` and, since the My Flights panel also opens at `top:72px`, the notice is transient (auto-hidden once data flows) so brief overlap during startup is acceptable.

- [ ] **Step 3: JS** — after the trail module add auth + favorites (complete code):

```js
/* ----- Favorites & sign-in ----- */
const favorites = new Map(); // hex -> { id, callsign }
let session = null;
let authIsSignUp = false;

const mfPanel = document.getElementById("mfPanel");
const authOverlay = document.getElementById("authOverlay");

sb.auth.onAuthStateChange((_event, s) => {
  session = s;
  document.getElementById("mfAuthLink").textContent = s ? "Sign out" : "Sign in";
  refreshFavorites();
});

async function refreshFavorites() {
  favorites.clear();
  if (session) {
    const { data, error } = await sb.from("favorites").select("id,hex,callsign");
    if (error) console.warn("favorites load failed:", error.message);
    (data || []).forEach((f) => favorites.set(f.hex, f));
  }
  renderMyFlights();
  updateStar();
}

function updateStar() {
  const btn = document.getElementById("fpStar");
  const isFav = selectedHex && favorites.has(selectedHex);
  btn.textContent = isFav ? "★" : "☆";
  btn.classList.toggle("active", !!isFav);
}

async function toggleFavorite() {
  if (!selectedHex) return;
  if (!session) { openAuth(); return; }
  const existing = favorites.get(selectedHex);
  if (existing) {
    const { error } = await sb.from("favorites").delete().eq("id", existing.id);
    if (!error) favorites.delete(selectedHex);
  } else {
    const f = flights.get(selectedHex);
    const callsign = f && f.data && (f.data.flight || "").trim() || selectedHex.toUpperCase();
    const { data, error } = await sb.from("favorites")
      .insert({ hex: selectedHex, callsign })
      .select("id,hex,callsign").single();
    if (!error && data) favorites.set(data.hex, data);
    else if (error) console.warn("favorite save failed:", error.message);
  }
  renderMyFlights();
  updateStar();
}

function renderMyFlights() {
  const list = document.getElementById("mfList");
  if (!session) {
    list.innerHTML = '<div class="mf-empty">Sign in to save flights and see when they\'re live on the globe.</div>';
    return;
  }
  if (!favorites.size) {
    list.innerHTML = '<div class="mf-empty">No saved flights yet. Click a plane, then tap the ☆ in its panel.</div>';
    return;
  }
  list.innerHTML = "";
  favorites.forEach((fav) => {
    const liveNow = flights.has(fav.hex);
    const item = document.createElement("button");
    item.className = "mf-item";
    item.innerHTML =
      '<span class="dot ' + (liveNow ? "" : "off") + '"></span>' +
      '<span class="cs"></span>' +
      (liveNow ? '<span class="live">LIVE</span>' : "") +
      '<span class="rm" title="Remove">✕</span>';
    item.querySelector(".cs").textContent = fav.callsign || fav.hex.toUpperCase();
    item.querySelector(".rm").addEventListener("click", async (e) => {
      e.stopPropagation();
      const { error } = await sb.from("favorites").delete().eq("id", fav.id);
      if (!error) { favorites.delete(fav.hex); renderMyFlights(); updateStar(); }
    });
    item.addEventListener("click", () => {
      const f = flights.get(fav.hex);
      if (!f || !f.data) return;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          f.data.lon, f.data.lat, flightAltitudeMeters(f.data) + 150_000),
        duration: 1.8
      });
    });
    list.appendChild(item);
  });
}

/* Auth card */
function openAuth() {
  authOverlay.style.display = "flex";
  document.getElementById("authError").textContent = "";
  document.getElementById("authEmail").focus();
}
function closeAuth() { authOverlay.style.display = "none"; }
function setAuthMode(signUp) {
  authIsSignUp = signUp;
  document.getElementById("authTitle").textContent = signUp ? "Create account" : "Sign in";
  document.getElementById("authSubmit").textContent = signUp ? "Create account" : "Sign in";
  document.getElementById("authAlt").innerHTML = signUp
    ? 'Have an account? <a id="authMode">Sign in</a>'
    : 'No account? <a id="authMode">Create one</a>';
  document.getElementById("authMode").addEventListener("click", () => setAuthMode(!authIsSignUp));
}
async function submitAuth() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPass").value;
  const errEl = document.getElementById("authError");
  if (!email || password.length < 6) {
    errEl.textContent = "Enter your email and a password of at least 6 characters.";
    return;
  }
  errEl.textContent = "";
  const { data, error } = authIsSignUp
    ? await sb.auth.signUp({ email, password })
    : await sb.auth.signInWithPassword({ email, password });
  if (error) { errEl.textContent = error.message; return; }
  if (authIsSignUp && !data.session) {
    errEl.textContent = "Check your email to confirm your account, then sign in.";
    return;
  }
  closeAuth();
}

document.getElementById("fpStar").addEventListener("click", toggleFavorite);
document.getElementById("mfToggle").addEventListener("click", () => {
  const open = mfPanel.style.display === "block";
  mfPanel.style.display = open ? "none" : "block";
  document.getElementById("mfToggle").setAttribute("aria-expanded", String(!open));
  if (!open) renderMyFlights();
});
document.getElementById("mfAuthLink").addEventListener("click", async () => {
  if (session) await sb.auth.signOut();
  else openAuth();
});
document.getElementById("authClose").addEventListener("click", closeAuth);
document.getElementById("authSubmit").addEventListener("click", submitAuth);
document.getElementById("authPass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitAuth();
});
setAuthMode(false);
refreshFavorites();
```

- [ ] **Step 4: Hooks.** In the pick handler after `updateFlightPanel(f.data)` add `updateStar();`. At the end of `pollFlights` (after the brandTag update) add `if (mfPanel.style.display === "block") renderMyFlights();`.
- [ ] **Step 5: Turn off email confirmation.** No MCP tool exists for auth settings — give the user click-by-click dashboard instructions (Authentication → Sign In / Providers → Email → turn off "Confirm email" → Save) during the check-in, and verify by creating a test account: sign-up must return a session immediately.
- [ ] **Step 6: Verify in browser.** Preview: create test account `aeronav3d-test@example.com` (delete after), star a flight, reload → still starred, My Flights lists it with LIVE dot, click flies to plane, remove works, sign-out shows signed-out panel. Confirm RLS isolation: `preview_eval` with a second anonymous client sees zero rows. `preview_console_logs` clean.
- [ ] **Step 7: Commit** and **check in with the user** (include the email-confirmation dashboard step).

### Task 7: Deploy to Vercel  → CHECK-IN #4

**Files:**
- Create: `.vercelignore`

- [ ] **Step 1: Write `.vercelignore`:**

```
server.py
worker.js
wrangler.jsonc
supabase
docs
test
.claude
.vscode
.assetsignore
```

- [ ] **Step 2: Login.** Run `npx vercel@latest login` in the background; it opens the user's browser to authorize. Message the user to click Confirm (they may need to create a free Vercel account first — Continue with GitHub is easiest since they have one). Poll for CLI success.
- [ ] **Step 3: Deploy.** From the repo dir: `npx vercel@latest deploy --prod --yes`. Project auto-created from the folder name → domain like `aeronav3d.vercel.app` (accept whatever free `.vercel.app` name Vercel assigns; report it).
- [ ] **Step 4: Verify live.** `curl -sI https://<domain>` → 200 and HTML. Then load the live URL in the browser preview/Chrome: globe renders with Google imagery, planes appear and move, trail draws, sign-in works on the live domain. Screenshot as proof.
- [ ] **Step 5: Commit** (`.vercelignore`) and **check in**: share the live URL.

### Task 8: Handoff — key lockdown, README, push

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`** — plain-English overview: what the site is, the live URL, architecture sketch (Vercel static + Supabase function/DB/auth + data credits: adsb.lol / adsb.fi / airplanes.live, Google, NASA), how to run locally (`python server.py`), where the spec/plan live.
- [ ] **Step 2: Google Maps key lockdown instructions** for the user (click-by-click): console.cloud.google.com → APIs & Services → Credentials → the key → Application restrictions: Websites → add `https://<domain>/*` and `http://localhost:8321/*` → API restrictions: Map Tiles API → Save.
- [ ] **Step 3: Final commit**; remind the user to push via GitHub Desktop (their usual workflow) so GitHub matches the live site.

## Execution addendum (2026-07-07)

Task 3 as planned used an in-memory cache + snapshot throttle (ported from the
Cloudflare Worker). Verification proved Supabase Edge Functions do NOT share
module state between requests (12 sequential requests: zero cache hits; one
snapshot batch per request instead of per 30 s). Fixed by moving both into a
`feed_cache` Postgres table (migration `0003_feed_cache.sql`, service-role
only, daily cleanup cron). Upstreams reordered fastest-first
(airplanes.live → adsb.fi → adsb.lol; adsb.lol measured at 15 s that day).
Verified after redeploy: cache hits ~0.4 s, one snapshot batch per 30 s window.

## Self-review notes

- Spec coverage: feed (T3–4), trails (T2, T3 snapshot, T5), favorites (T2, T6), hosting (T7), key lockdown (T8) — all covered.
- Type consistency: `flightAltitudeMeters`, `flights`, `selectedHex`, `FT_TO_M` reused from existing index.html code; new names (`sb`, `trailHex`, `favorites`) defined before use; `flight_positions` columns match between migration, Edge Function insert, and frontend select.
- Known accepted risks: email-confirmation toggle is a manual dashboard step (no API available); Vercel login needs one user interaction; first-poll on production goes straight to Supabase (no wasted local call) via `IS_LOCAL`.
