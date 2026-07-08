// AeroNav3D flight feed.
//
// GET /flights?circle=lat,lon,radiusNm
// Proxies public ADS-B aggregators with failover, and snapshots aircraft
// positions to Postgres so the frontend can draw flight trails.
//
// Caching and snapshot throttling live in the feed_cache table, not in
// memory: Supabase may run every request on a fresh isolate, so module
// state cannot be trusted to persist (verified empirically — 12 sequential
// requests never reused the in-memory cache).

import { createClient } from "npm:@supabase/supabase-js@2";

// Ordered fastest-first (measured 2026-07-07: airplanes.live 0.9 s,
// adsb.fi 1.0 s, adsb.lol 15 s).
const UPSTREAMS = [
  (lat: number, lon: number, rad: number) =>
    `https://api.airplanes.live/v2/point/${lat}/${lon}/${rad}`,
  (lat: number, lon: number, rad: number) =>
    `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${rad}`,
  (lat: number, lon: number, rad: number) =>
    `https://api.adsb.lol/v2/point/${lat}/${lon}/${rad}`,
];

const FRESH_MS = 8_000; // serve cached responses this fresh without refetching
const SNAPSHOT_MS = 30_000; // min gap between trail snapshots per area
const UPSTREAM_TIMEOUT_MS = 5_000;

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

function waitUntil(p: Promise<unknown>) {
  try {
    // Supabase edge runtime: lets async work finish after the response.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime.waitUntil(p);
  } catch {
    /* runtime without waitUntil: work continues best-effort */
  }
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

  // Shared cache lookup — best-effort, never blocks the feed on failure.
  let row: { body: string; fetched_at: string; snapshot_at: string | null } | null = null;
  try {
    const { data } = await supabase
      .from("feed_cache")
      .select("body,fetched_at,snapshot_at")
      .eq("key", key)
      .maybeSingle();
    row = data;
  } catch (err) {
    console.error("cache read failed:", err?.message ?? err);
  }
  if (row && Date.now() - Date.parse(row.fetched_at) < FRESH_MS) {
    return json(row.body, 200, { "X-Cache": "hit" });
  }

  for (const buildUrl of UPSTREAMS) {
    try {
      const r = await fetch(buildUrl(lat, lon, rad), {
        headers: { "User-Agent": "AeroNav3D (github.com/Prithvi-Web/AeroNav3D)" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!r.ok) continue; // rate-limited or down — try the next aggregator
      const body = await r.text();
      let parsed: { aircraft?: unknown[]; ac?: unknown[] };
      try {
        parsed = JSON.parse(body);
      } catch {
        continue; // garbage response — try the next aggregator
      }

      const snapAge = row?.snapshot_at ? Date.now() - Date.parse(row.snapshot_at) : Infinity;
      const takeSnapshot = snapAge >= SNAPSHOT_MS;
      const snapshotAt = takeSnapshot ? new Date().toISOString() : row?.snapshot_at ?? null;

      waitUntil((async () => {
        if (takeSnapshot) await insertPositions(parsed);
        const { error } = await supabase.from("feed_cache").upsert({
          key,
          body,
          fetched_at: new Date().toISOString(),
          snapshot_at: snapshotAt,
        });
        if (error) console.error("cache write failed:", error.message);
      })().catch((err) => console.error("persist failed:", err?.message ?? err)));

      return json(body, 200, { "X-Cache": "miss" });
    } catch {
      // network error / timeout — try the next aggregator
    }
  }

  if (row) return json(row.body, 200, { "X-Cache": "stale" }); // stale beats nothing
  return json(JSON.stringify({ error: "flight data upstreams unavailable" }), 502);
});

// Store one position per aircraft for the trails feature.
async function insertPositions(parsed: { aircraft?: unknown[]; ac?: unknown[] }) {
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
  const { error } = await supabase.from("flight_positions").insert(rows);
  if (error) console.error("snapshot insert failed:", error.message);
}
