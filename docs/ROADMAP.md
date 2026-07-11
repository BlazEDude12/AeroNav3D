# AeroNav3D Feature Roadmap

Recommendations for bringing AeroNav3D to parity with mainstream flight
trackers (Flightradar24, FlightAware, ADS-B Exchange), and the agentic AI
features that would set it apart. Ordered roughly by value-per-effort within
each section.

---

## Part 1 — Parity features (table stakes)

### 1. Search & flight lookup
The biggest gap today: users can only find flights by visually hunting the
globe. Add a search box for **callsign, registration, or airport** that flies
the camera to the result. The `flights` map already holds everything needed —
this is mostly UI work.

### 2. Route info (origin → destination)
The most-asked question about any plane is *"where is it going?"* ADS-B alone
doesn't carry route data, so use a route API:

- [adsb.lol route endpoint](https://api.adsb.lol/docs) — free `routeset` API
- Open datasets mapping callsigns to routes

Show `SEA → ANC` in the flight panel and draw the great-circle route line on
the globe.

### 3. Airports as first-class objects
Clickable airport markers showing arrivals/departures currently in the air
nearby. The [OurAirports dataset](https://ourairports.com/data/) is free CSV.
Pairs beautifully with the 3D globe.

### 4. Full flight history trails
`flight_positions` currently keeps one hour of positions. Extending retention
(or archiving to a cheap table) enables:

- "Show me this flight's whole path"
- Playback slider / flight replay (the classic FR24 feature)

### 5. Filters
Filter by altitude band, aircraft type, airline, and **emergency squawks**
(7500 / 7600 / 7700). Squawk data is already in the feed — emergency flights
should glow red and surface a notification. A fan favorite and trivial to add.

### 6. Aircraft photos & details
[Planespotters.net](https://www.planespotters.net/photo/api) has a free API
for aircraft photos by registration. One API call makes the flight panel feel
10× more premium.

### 7. Weather layers
Wind aloft, clouds, or precipitation overlaid on the globe. NOAA and
[RainViewer](https://www.rainviewer.com/api.html) tiles are free, and Cesium
handles imagery layers natively — low-lift and very visual.

---

## Part 2 — The agentic AI layer (going above and beyond)

**Framing:** every existing tracker makes *you* do the watching. An agentic
tracker watches *for* you and answers questions instead of showing dots.

### 1. Natural-language flight queries ⭐ the killer demo
A chat box where queries like:

> "Show me all 747s over the Pacific right now"
> "What's that plane circling above Everett?"

are translated by Claude into filters + camera moves.

**Architecture:** a Supabase Edge Function calls the Claude API with tool
definitions such as:

| Tool | Action |
|---|---|
| `flyTo(lat, lon, height)` | Move the camera |
| `filterFlights(criteria)` | Filter visible aircraft |
| `selectFlight(callsign)` | Open the flight panel |

The model returns tool calls; the page executes them. The existing page
functions are already shaped like tools — this is closer than it looks.

### 2. Standing watches ⭐ the truly agentic part
Saved rules the system evaluates continuously:

> "Tell me when N123AS takes off"
> "Alert me if anything squawks 7700 near Seattle"
> "Watch my dad's flight and text me when it lands"

**Architecture:** a cron-driven Edge Function (pg_cron is already running)
evaluates watch rules against the feed and notifies via email/push. This
transforms the app from a toy you look at into a service that works while
you're gone — no mainstream tracker does this well conversationally.

### 3. Anomaly narration
An agent periodically scans the feed for interesting behavior — go-arounds,
holding patterns, diversions, emergency squawks, military activity — and
writes one-line human explanations:

> "UAL452 has been holding over Puget Sound for 25 minutes, likely weather
> at SEA."

Detection is geometry math on the position history; narration is one cheap
Claude call. This gives the app an editorial voice nobody else has.

### 4. "Explain this flight" button
One click on any plane sends Claude a summary of its data (route, altitude
profile from trail history, aircraft type) and returns a plain-English story:
what it is, where it's going, whether anything about its behavior is unusual.
Cheap, delightful, great for aviation newcomers.

### 5. My Flights → daily briefing
Auth and favorites already exist. Add an agent-written daily digest:

> "Your watched aircraft N309AS flew 4 legs yesterday: SEA–LAX–SEA–ANC."

---

## Suggested build order

1. **Search + route display** — the parity gaps that hurt most
2. **Natural-language query box** — the agentic showpiece
3. **Standing watches with notifications** — what makes it genuinely agentic

**Quick win:** emergency-squawk highlighting can ship in an afternoon and
later becomes a data source for the anomaly narrator.
