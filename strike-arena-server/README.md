# STRIKE ARENA — Server (M2)

Authoritative multiplayer server for **STRIKE ARENA**, an original 5v5
Team Deathmatch browser FPS (first team to 40 kills wins). Node.js + `ws`.
Implements `../PROTOCOL.md` exactly; loads `../shared/map.json` and
`../shared/weapons.json` as the single source of truth (no hardcoded layout).

## Run locally

```bash
cd server
npm install
npm start            # listens on :3000
PORT=8080 npm start  # custom port
```

`GET /health` returns `ok` (used by Render health checks).

## Protocol summary

**Transport:** WebSocket, JSON text frames. Server tick 30 Hz, snapshots 20 Hz.
Angles in radians, meters, Y-up.

**Client → Server**

| Message | Shape |
|---|---|
| hello | `{"t":"hello","name":"PlayerName","code":"ABC123"\|null}` — `null` creates a room, a code joins it |
| input | `{"t":"input","seq":n,"k":{"w":0/1,"a":..,"s":..,"d":..,"shift":0/1,"j":0/1},"yaw":f,"pitch":f,"fire":0/1,"ads":0/1,"reload":0/1,"slot":0..4}` |
| ping | `{"t":"ping","now":ms}` → server replies `{"t":"pong","now":ms,"server":ms}` |

(`j` = jump is a server-side extension; PROTOCOL.md's input has no jump key but
bots jump, so the server accepts it.)

**Server → Client**

- `{"t":"welcome","id":"p3","team":0,"code":"ABC123","you":{player}}`
- `{"t":"err","msg":"..."}` — bad code, room full, match already ended
- `{"t":"snap","tick":n,"tLeft":s,"score":[a,b],"players":[…],"tracers":[…],"pickups":[…],"events":[…]}` @ 20 Hz
  - player: `{"id","name","team","bot","x","y","z","yaw","pitch","hp","alive","w","kills","deaths","resp"}`
  - tracer: `{"x1","y1","z1","x2","y2","z2","w"}` (one per pellet since last snap)
  - pickup: `{"id","kind":"weapon"|"ammo"|"med","w","x","y","z"}`
  - events: `{"k":"kill","by","bn","v","vn","w"}` / `{"k":"hit","by"}` /
    `{"k":"pickup","by","kind"}` / `{"k":"end","win":0|1|"draw","score":[a,b]}`

**Server rules**

- Authoritative movement: walk 5.0 / sprint 6.8 m/s, gravity 18, jump 7.5,
  step-up 0.55, circle (r=0.35) vs AABB collision, ground-height resolution,
  clamped to map bounds. Anti-cheat: speed clamp, dead-player inputs ignored,
  yaw normalized, pitch clamped.
- Authoritative hitscan: ray from eye (y+1.6) along yaw/pitch + gaussian spread
  (base spread; ADS only affects the client). Ray vs 3D obstacle AABBs and vs
  players (body = vertical segment, head sphere r=0.25 at y+1.55); nearest hit
  wins. Damage per `weapons.json`, headshot multiplier, 40% damage loss beyond
  30 m for falloff weapons (VK-9, M590, P9). Fire-rate limited per rpm, reload
  timers, semi-auto trigger-edge handling. No friendly fire.
- Death: hp ≤ 0 → `alive=false`, kills/deaths++, team score++, loot drop at the
  body (victim's weapon if not the pistol, + ammo box, 25% medkit), respawn
  after 3 s at a random team spawn with full HP/ammo.
- Pickups: 1.5 m walk-over. Weapon replaces the current slot (grants its
  mag+reserve); ammo tops up reserve; medkit heals 50.
- Bots fill each team to 5 total players (rebalanced as humans join/leave).
  AI decides ~4 Hz: nearest visible enemy (obstacle raycast LOS) → strafe +
  aim with distance-scaled error, fire when roughly aimed (rpm respected),
  reload on empty mag; otherwise roam waypoints, or seek a medkit when hp < 60;
  jumps occasionally.
- Win: first team to 40 kills → `end` event; else 600 s timer → higher score
  wins, tie = draw. Room closes 15 s after end; empty rooms deleted after 60 s.
- Rooms: 6-char codes (A-Z0-9 minus confusing chars). Max 10 humans per room.

**Deviations / additions vs PROTOCOL.md**

1. `k.j` (jump) accepted in input — protocol lists no jump key.
2. Server seeds 8 starter pickups (4 medkits + 4 ammo, symmetric) so the map
   isn't empty before first blood; protocol only mandates death loot.
3. `ping` gets a `pong` reply (protocol defines the message, not the reply).
4. No friendly fire (protocol is silent; TDM default).

## Deploy on Render (free tier)

1. Push this repo to GitHub (the `server/` directory is self-contained apart
   from `../shared/`, which Render gets automatically since it's one repo).
2. Render Dashboard → **New +** → **Web Service** → connect the repo.
   Or: **New +** → **Blueprint** and point at `server/render.yaml`.
3. Settings: **Runtime** Node, **Plan** Free, **Build Command** `npm install`
   (run from the `server` directory — set **Root Directory** to `server` if not
   using the Blueprint), **Start Command** `npm start`.
4. Keep **Instances = 1** — rooms live in-memory; scaling past 1 breaks rooms.
5. Render injects `PORT` automatically; the server reads it from the env.
6. Health check path: `/health`.

Clients connect to `wss://<your-service>.onrender.com`.

## Test

```bash
npm test   # runs test_sim.js: boots the server, 3 fake clients, 25 s sim
```

Asserts: 3 welcomes, ~20 Hz snapshots, 10 total players (3 humans + 7 bots),
≥ 1 kill event, pickups present.
