'use strict';
/* ============================================================================
 * STRIKE ARENA — authoritative multiplayer game server (M2)
 * Original game. 5v5 Team Deathmatch, first team to 40 kills wins.
 *
 * Loads shared/map.json + shared/weapons.json as the SINGLE SOURCE OF TRUTH
 * (no hardcoded layout/weapons). Implements PROTOCOL.md exactly:
 *   - WebSocket JSON transport, 30 Hz tick, 20 Hz snapshots
 *   - Authoritative movement (walk 5.0 / sprint 6.8, gravity 18, jump 7.5,
 *     step-up 0.55, circle-vs-AABB collision, ground height resolution)
 *   - Authoritative hitscan shooting (eye ray + gaussian spread, ray vs 3D
 *     AABBs and vs players, headshot multipliers, 30m+ falloff, rpm limits)
 *   - Deaths -> kills/deaths, team score, loot drops, 3s respawn
 *   - Walk-over pickups (weapon / ammo / med)
 *   - Bots fill each team to 5, 4 Hz AI decisions
 *   - 6-char room codes, max 10 humans, win at 40 kills / 600s timer
 *   - Basic anti-cheat: speed clamp, dead-player input ignore, yaw/pitch clamp
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

// ---------------- shared data (single source of truth) ----------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const MAP = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'map.json'), 'utf8'));
const WDATA = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'weapons.json'), 'utf8'));
const RULES = WDATA.rules;
const GUN = {};
for (const w of WDATA.weapons) GUN[w.id] = w;

const BOUNDS = MAP.bounds;          // {x1,z1,x2,z2}
const OBSTACLES = MAP.obstacles;    // [{x1,z1,x2,z2,y1,y2,kind}]
const TICK_DT = 1 / 30;
const SNAP_MS = 50;                 // 20 Hz snapshots
const BOT_THINK_EVERY = 8;          // ticks (~3.75 Hz AI decisions)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
const MAX_HUMANS = 10;
const TEAM_SIZE = RULES.teamSize;   // 5
const KILL_TARGET = RULES.killTarget; // 40
const MATCH_TIME = RULES.matchTime;   // 600 s
const BOT_NAMES = ['Raptor', 'Ghost', 'Viper', 'Falcon', 'Havoc',
                   'Blaze', 'Cobra', 'Storm', 'Rex', 'Onyx'];
// Ground-level waypoints for bot roaming (catwalks need stairs; bots stay low).
const WAYPOINTS = [
  { x: 0, z: -6 }, { x: 0, z: 6 }, { x: -12, z: -10 }, { x: 12, z: 10 },
  { x: -12, z: 10 }, { x: 12, z: -10 }, { x: -20, z: 0 }, { x: 20, z: 0 },
  { x: -8, z: 0 }, { x: 8, z: 0 }, { x: -25, z: -12 }, { x: 25, z: 12 },
  { x: -25, z: 12 }, { x: 25, z: -12 },
];

// ---------------- utils ----------------
const nowSec = () => Date.now() / 1000;
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function normYaw(y) {
  while (y > Math.PI) y -= 2 * Math.PI;
  while (y < -Math.PI) y += 2 * Math.PI;
  return y;
}
function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
const r3 = v => Math.round(v * 1000) / 1000;
let _spare = null;
function randn() { // Box-Muller gaussian
  if (_spare !== null) { const s = _spare; _spare = null; return s; }
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  v = Math.random();
  const m = Math.sqrt(-2 * Math.log(u));
  _spare = m * Math.sin(2 * Math.PI * v);
  return m * Math.cos(2 * Math.PI * v);
}

// ---------------- physics ----------------
// Ground height = max y2 of obstacles whose XZ contains (x,z) and whose
// y2 <= feet + stepUp; else y = 0. (PROTOCOL.md)
function groundHeight(x, z, feet) {
  let g = 0;
  const lim = feet + RULES.stepUp;
  for (const b of OBSTACLES) {
    if (x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2 && b.y2 <= lim && b.y2 > g) g = b.y2;
  }
  return g;
}
// Horizontal collision: circle (r=playerRadius) vs AABB in XZ.
// Blocked only if obstacle top is above feet+stepUp AND obstacle overlaps
// the player's vertical span (so catwalk decks don't block players under them).
function collides(x, z, feet) {
  const r = RULES.playerRadius;
  const lim = feet + RULES.stepUp;
  const headTop = feet + RULES.playerHeight;
  for (const b of OBSTACLES) {
    if (b.y2 <= lim) continue;      // steppable / below feet
    if (b.y1 >= headTop) continue;  // entirely above head (e.g. deck overhead)
    const cx = clamp(x, b.x1, b.x2);
    const cz = clamp(z, b.z1, b.z2);
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}
function tryMove(p, dx, dz) {
  const nx = p.x + dx, nz = p.z + dz;
  if (!collides(nx, nz, p.y)) { p.x = nx; p.z = nz; }
}
function movePlayer(p) {
  const inp = p.input || {};
  const k = inp.k || {};
  p.yaw = normYaw(Number.isFinite(inp.yaw) ? inp.yaw : p.yaw);
  p.pitch = clamp(Number.isFinite(inp.pitch) ? inp.pitch : p.pitch, -1.45, 1.45);
  const f = (k.w ? 1 : 0) - (k.s ? 1 : 0);
  const r = (k.d ? 1 : 0) - (k.a ? 1 : 0);
  if (f !== 0 || r !== 0) {
    const sprint = (k.shift === 1);
    const speed = sprint ? RULES.sprintSpeed : RULES.walkSpeed;
    const len = Math.hypot(f, r);
    const fx = Math.cos(p.yaw), fz = Math.sin(p.yaw);   // yaw 0 = +x
    const rx = -Math.sin(p.yaw), rz = Math.cos(p.yaw);
    let dx = (fx * f / len + rx * r / len) * speed * TICK_DT;
    let dz = (fz * f / len + rz * r / len) * speed * TICK_DT;
    // anti-cheat: hard speed clamp
    const maxD = RULES.sprintSpeed * TICK_DT + 1e-6;
    const d = Math.hypot(dx, dz);
    if (d > maxD) { dx *= maxD / d; dz *= maxD / d; }
    tryMove(p, dx, 0);
    tryMove(p, 0, dz);
  }
  if (k.j === 1 && p.grounded) { p.vy = RULES.jumpVel; p.grounded = false; }
  p.vy -= RULES.gravity * TICK_DT;
  p.y += p.vy * TICK_DT;
  const gy = groundHeight(p.x, p.z, p.y);
  if (p.y <= gy) { p.y = gy; p.vy = 0; p.grounded = true; }
  else p.grounded = false;
  p.x = clamp(p.x, BOUNDS.x1, BOUNDS.x2);
  p.z = clamp(p.z, BOUNDS.z1, BOUNDS.z2);
}

// ---------------- raycasts (PROTOCOL.md: standard ray-AABB 3D) ----------------
function rayAABB(ox, oy, oz, dx, dy, dz, b, maxT) {
  let t0 = 0, t1 = maxT;
  // X slab
  if (Math.abs(dx) < 1e-12) { if (ox < b.x1 || ox > b.x2) return null; }
  else {
    let ta = (b.x1 - ox) / dx, tb = (b.x2 - ox) / dx;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  // Y slab
  if (Math.abs(dy) < 1e-12) { if (oy < b.y1 || oy > b.y2) return null; }
  else {
    let ta = (b.y1 - oy) / dy, tb = (b.y2 - oy) / dy;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  // Z slab
  if (Math.abs(dz) < 1e-12) { if (oz < b.z1 || oz > b.z2) return null; }
  else {
    let ta = (b.z1 - oz) / dz, tb = (b.z2 - oz) / dz;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  return t0;
}
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return null;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return null;
  const t = tca - Math.sqrt(r2 - d2);
  return (t >= 0 && t <= maxT) ? t : null;
}
// Ray vs player: body = vertical segment (radius playerRadius), head sphere
// r=0.25 at y+1.55. Returns {t, head} or null.
function rayPlayer(ox, oy, oz, dx, dy, dz, q, maxT) {
  let best = null;
  const th = raySphere(ox, oy, oz, dx, dy, dz, q.x, q.y + 1.55, q.z, 0.25, maxT);
  if (th !== null) best = { t: th, head: true };
  const den = dx * dx + dz * dz;
  let tb = null;
  if (den > 1e-9) {
    const t = ((q.x - ox) * dx + (q.z - oz) * dz) / den;
    if (t > 0 && t <= maxT) {
      const px = ox + dx * t, pz = oz + dz * t, py = oy + dy * t;
      if (Math.hypot(px - q.x, pz - q.z) <= RULES.playerRadius &&
          py >= q.y && py <= q.y + RULES.playerHeight) tb = t;
    }
  } else if (Math.hypot(ox - q.x, oz - q.z) <= RULES.playerRadius && Math.abs(dy) > 1e-9) {
    let tA = (q.y - oy) / dy, tB = (q.y + RULES.playerHeight - oy) / dy;
    if (tA > tB) { const qq = tA; tA = tB; tB = qq; }
    const t = Math.max(tA, 0);
    if (t <= Math.min(tB, maxT)) tb = t;
  }
  if (tb !== null && (best === null || tb < best.t)) best = { t: tb, head: false };
  return best;
}
function aimDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw)];
}
function spreadDir(dx, dy, dz, sigma) {
  const a = randn() * sigma, b = randn() * sigma;
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(dy) > 0.99) { ux = 1; uy = 0; uz = 0; }
  let t1x = dy * uz - dz * uy, t1y = dz * ux - dx * uz, t1z = dx * uy - dy * ux;
  const l1 = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= l1; t1y /= l1; t1z /= l1;
  const t2x = dy * t1z - dz * t1y, t2y = dz * t1x - dx * t1z, t2z = dx * t1y - dy * t1x;
  const nx = dx + t1x * a + t2x * b;
  const ny = dy + t1y * a + t2y * b;
  const nz = dz + t1z * a + t2z * b;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
// Line-of-sight check against obstacles only (for bot AI).
function losClear(ox, oy, oz, tx, ty, tz) {
  const dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  const nx = dx / dist, ny = dy / dist, nz = dz / dist;
  for (const b of OBSTACLES) {
    const t = rayAABB(ox, oy, oz, nx, ny, nz, b, dist);
    if (t !== null && t < dist - 0.05) return false;
  }
  return true;
}

// ---------------- players ----------------
let nextPid = 1;
function makePlayer(name, team, isBot) {
  const d0 = GUN[0], dp = GUN[4];
  return {
    id: 'p' + (nextPid++),
    name: String(name || 'Player').slice(0, 16) || 'Player',
    team, bot: !!isBot,
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vy: 0, grounded: true,
    hp: 100, alive: true, respAt: 0,
    loadout: [
      { w: 0, mag: d0.mag, reserve: d0.reserve },
      { w: 4, mag: dp.mag, reserve: dp.reserve },
    ],
    slot: 0,
    kills: 0, deaths: 0,
    input: null, prevFire: false, nextFireAt: 0, reloadEndAt: 0,
    ai: isBot ? freshBotAI() : null,
  };
}
function freshBotAI() {
  return {
    yaw: 0, pitch: 0, moveX: 0, moveZ: 0, fire: false,
    reload: false, jump: false, sprint: false,
    strafeDir: 1, strafeT: 0, wp: null,
  };
}
function spawnPlayer(room, p) {
  const s = MAP.spawns[String(p.team)];
  p.x = rand(s.x1, s.x2);
  p.z = rand(s.z1, s.z2);
  p.y = groundHeight(p.x, p.z, 2);
  p.yaw = s.yaw; p.pitch = 0; p.vy = 0; p.grounded = true;
  p.hp = 100; p.alive = true; p.respAt = 0;
  const d0 = GUN[0], dp = GUN[4];
  p.loadout = [
    { w: 0, mag: d0.mag, reserve: d0.reserve },
    { w: 4, mag: dp.mag, reserve: dp.reserve },
  ];
  p.slot = 0; p.reloadEndAt = 0; p.nextFireAt = 0; p.prevFire = false; p.input = null;
  if (p.bot) { p.ai = freshBotAI(); p.ai.yaw = s.yaw; }
}
function nextBotName(room) {
  for (const n of BOT_NAMES) if (!room.botNames.has(n)) { room.botNames.add(n); return n; }
  const n = 'Bot' + ((Math.random() * 900 + 100) | 0);
  room.botNames.add(n);
  return n;
}
// Fill each team to TEAM_SIZE total players (bots added/removed as humans join/leave).
function rebalanceBots(room) {
  if (room.over) return;
  for (const team of [0, 1]) {
    let humans = 0;
    const bots = [];
    for (const p of room.players.values()) {
      if (p.team !== team) continue;
      if (p.bot) bots.push(p); else humans++;
    }
    while (humans + bots.length > TEAM_SIZE) {
      const b = bots.pop();
      room.players.delete(b.id);
      room.botNames.delete(b.name);
    }
    while (humans + bots.length < TEAM_SIZE) {
      const b = makePlayer(nextBotName(room), team, true);
      room.players.set(b.id, b);
      bots.push(b);
      spawnPlayer(room, b);
    }
  }
}

// ---------------- combat ----------------
function fireWeapon(room, p, entry, def) {
  const [bdx, bdy, bdz] = aimDir(p.yaw, p.pitch);
  const ox = p.x, oy = p.y + RULES.eyeHeight, oz = p.z;
  const sigma = def.spreadDeg * Math.PI / 180; // server uses base spread (PROTOCOL.md)
  let anyHit = false;
  for (let i = 0; i < def.pellets; i++) {
    const [dx, dy, dz] = spreadDir(bdx, bdy, bdz, sigma);
    let bestT = def.range, victim = null, head = false;
    for (const b of OBSTACLES) {
      const t = rayAABB(ox, oy, oz, dx, dy, dz, b, bestT);
      if (t !== null && t < bestT) { bestT = t; victim = null; }
    }
    for (const q of room.players.values()) {
      if (q === p || !q.alive || q.team === p.team) continue; // no friendly fire
      const r = rayPlayer(ox, oy, oz, dx, dy, dz, q, bestT);
      if (r && r.t < bestT) { bestT = r.t; victim = q; head = r.head; }
    }
    room.tracers.push({
      x1: r3(ox), y1: r3(oy), z1: r3(oz),
      x2: r3(ox + dx * bestT), y2: r3(oy + dy * bestT), z2: r3(oz + dz * bestT),
      w: def.id,
    });
    if (victim) {
      anyHit = true;
      let dmg = def.dmg * (head ? def.headMult : 1);
      if (def.falloff && bestT > RULES.falloffStart) dmg *= RULES.falloffFactor;
      damagePlayer(room, p, victim, dmg, def.id);
    }
  }
  if (anyHit) room.events.push({ k: 'hit', by: p.id });
}
function damagePlayer(room, atk, vic, dmg, w) {
  if (!vic.alive || room.over) return;
  vic.hp -= dmg;
  if (vic.hp <= 0) killPlayer(room, atk, vic, w);
}
function killPlayer(room, atk, vic, w) {
  const now = nowSec();
  vic.alive = false; vic.hp = 0; vic.deaths++;
  vic.respAt = now + RULES.respawnTime;
  vic.reloadEndAt = 0;
  atk.kills++;
  room.score[atk.team]++;
  room.events.push({ k: 'kill', by: atk.id, bn: atk.name, v: vic.id, vn: vic.name, w });
  dropLoot(room, vic);
}
function dropLoot(room, vic) {
  const e = vic.loadout[vic.slot];
  const drops = [];
  if (e.w !== 4) drops.push({ kind: 'weapon', w: e.w }); // victim's weapon if not pistol
  drops.push({ kind: 'ammo' });                          // ammo box
  if (Math.random() < 0.25) drops.push({ kind: 'med' }); // 25% medkit
  for (const d of drops) {
    const x = clamp(vic.x + rand(-0.8, 0.8), BOUNDS.x1, BOUNDS.x2);
    const z = clamp(vic.z + rand(-0.8, 0.8), BOUNDS.z1, BOUNDS.z2);
    addPickup(room, { kind: d.kind, w: d.w, x, z });
  }
  while (room.pickups.length > 40) room.pickups.shift();
}
function combatTick(room, p, now) {
  const inp = p.input || {};
  const held = v => (v === 1 || v === true);
  // finish reload
  if (p.reloadEndAt && now >= p.reloadEndAt) {
    const e = p.loadout[p.slot], d = GUN[e.w];
    const take = Math.min(d.mag - e.mag, e.reserve);
    e.mag += take; e.reserve -= take;
    p.reloadEndAt = 0;
  }
  // slot switch (cancels reload)
  let slot = Number.isFinite(+inp.slot) ? clamp(Math.round(+inp.slot), 0, 4) : p.slot;
  if (p.loadout[slot] && slot !== p.slot) { p.slot = slot; p.reloadEndAt = 0; }
  const fireHeld = held(inp.fire);
  if (p.reloadEndAt) { p.prevFire = fireHeld; return; } // reloading blocks firing
  const e = p.loadout[p.slot], d = GUN[e.w];
  if (held(inp.reload) && e.mag < d.mag && e.reserve > 0) {
    p.reloadEndAt = now + d.reload;
  }
  let want = fireHeld;
  if (!d.auto) want = want && !p.prevFire; // semi-auto: trigger edge only
  p.prevFire = fireHeld;
  if (want && now >= p.nextFireAt) {
    if (e.mag > 0) {
      fireWeapon(room, p, e, d);
      e.mag--;
      p.nextFireAt = now + 60 / d.rpm;
    } else if (e.reserve > 0) {
      p.reloadEndAt = now + d.reload; // auto-reload on empty trigger pull
    }
  }
}

// ---------------- pickups ----------------
function addPickup(room, { kind, w, x, z }) {
  const pk = {
    id: 'k' + (room.nextPickupId++),
    kind, w: w != null ? w : null,
    x: r3(x), z: r3(z),
    y: r3(groundHeight(x, z, 10) + 0.35),
  };
  room.pickups.push(pk);
  return pk;
}
// A few starter pickups so the map isn't empty before first blood
// (server addition; PROTOCOL.md only mandates death loot).
function seedPickups(room) {
  const meds = [[-22, -12], [22, 12], [-22, 12], [22, -12]];
  const ammos = [[-22, 12], [22, -12], [-18, 0], [18, 0]];
  for (const [x, z] of meds) addPickup(room, { kind: 'med', x, z });
  for (const [x, z] of ammos) addPickup(room, { kind: 'ammo', x, z });
}
function applyPickup(room, p, pk) {
  const e = p.loadout[p.slot], d = GUN[e.w];
  if (pk.kind === 'weapon') {
    const nd = GUN[pk.w];
    p.loadout[p.slot] = { w: pk.w, mag: nd.mag, reserve: nd.reserve }; // swap slot
  } else if (pk.kind === 'ammo') {
    e.reserve = Math.min(d.reserve, e.reserve + d.mag * 2); // top up reserve
  } else if (pk.kind === 'med') {
    p.hp = Math.min(100, p.hp + RULES.medHeal); // heal 50
  }
  room.events.push({ k: 'pickup', by: p.id, kind: pk.kind });
}
function pickupTick(room) {
  const R = RULES.pickupRadius;
  for (let i = room.pickups.length - 1; i >= 0; i--) {
    const pk = room.pickups[i];
    let taken = false;
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      const dx = p.x - pk.x, dz = p.z - pk.z;
      if (dx * dx + dz * dz > R * R) continue;
      if (Math.abs((p.y + 0.8) - pk.y) > 1.6) continue;
      applyPickup(room, p, pk);
      room.pickups.splice(i, 1);
      taken = true;
      break;
    }
    if (taken) continue;
  }
}
function nearestPickupOf(bot, room, kind) {
  let best = null, bd = 1e9;
  for (const pk of room.pickups) {
    if (pk.kind !== kind) continue;
    const d = Math.hypot(pk.x - bot.x, pk.z - bot.z);
    if (d < bd) { bd = d; best = pk; }
  }
  return best;
}

// ---------------- bot AI (decisions ~4 Hz) ----------------
function botThink(room, bot, now) {
  const ai = bot.ai;
  const entry = bot.loadout[bot.slot];
  let tgt = null, td = 1e9;
  for (const q of room.players.values()) {
    if (q === bot || !q.alive || q.team === bot.team) continue;
    const d = Math.hypot(q.x - bot.x, q.z - bot.z);
    if (d > 80 || d >= td) continue;
    if (losClear(bot.x, bot.y + RULES.eyeHeight, bot.z, q.x, q.y + 1.0, q.z)) { tgt = q; td = d; }
  }
  ai.reload = false; ai.jump = false;
  if (tgt) {
    const dx = tgt.x - bot.x, dz = tgt.z - bot.z;
    const distXZ = Math.hypot(dx, dz) || 1e-6;
    const aimYaw = Math.atan2(dz, dx);
    const aimPitch = Math.atan2((tgt.y + 1.0) - (bot.y + RULES.eyeHeight), distXZ);
    const err = 0.015 + td * 0.0011; // aim error grows with distance
    ai.yaw = aimYaw + randn() * err;
    ai.pitch = clamp(aimPitch + randn() * err * 0.7, -1.2, 1.2);
    ai.fire = Math.abs(normYaw(ai.yaw - aimYaw)) < 0.07 &&
              Math.abs(ai.pitch - aimPitch) < 0.07; // fire when roughly aimed
    ai.strafeT -= 0.25;
    if (ai.strafeT <= 0) { ai.strafeDir = Math.random() < 0.5 ? -1 : 1; ai.strafeT = rand(0.8, 2.0); }
    const adv = td > 26 ? 1 : td < 8 ? -1 : 0; // keep 8-26 m engagement range
    const fx = Math.cos(aimYaw), fz = Math.sin(aimYaw);
    ai.moveX = fx * adv + (-fz) * ai.strafeDir * 0.9; // strafe perpendicular
    ai.moveZ = fz * adv + (fx) * ai.strafeDir * 0.9;
    ai.sprint = td > 30;
    if (entry.mag === 0) ai.reload = true;
    if (Math.random() < 0.06 && bot.grounded) ai.jump = true;
  } else {
    ai.fire = false;
    let dest = null;
    if (bot.hp < 60) dest = nearestPickupOf(bot, room, 'med'); // grab medkit when hurt
    if (!dest) {
      if (!ai.wp || Math.hypot(ai.wp.x - bot.x, ai.wp.z - bot.z) < 2) ai.wp = pick(WAYPOINTS);
      dest = ai.wp;
    }
    const dx = dest.x - bot.x, dz = dest.z - bot.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    ai.moveX = dx / d; ai.moveZ = dz / d;
    ai.yaw = Math.atan2(ai.moveZ, ai.moveX);
    ai.pitch = 0;
    ai.sprint = d > 18;
    if (entry.mag === 0) ai.reload = true;
    if (Math.random() < 0.04 && bot.grounded) ai.jump = true;
  }
}
// Convert bot AI plan into a client-style input each tick.
function applyBotInput(bot) {
  const ai = bot.ai;
  const fx = Math.cos(ai.yaw), fz = Math.sin(ai.yaw);
  const rx = -Math.sin(ai.yaw), rz = Math.cos(ai.yaw);
  const f = ai.moveX * fx + ai.moveZ * fz;
  const r = ai.moveX * rx + ai.moveZ * rz;
  bot.input = {
    k: {
      w: f > 0.25 ? 1 : 0, s: f < -0.25 ? 1 : 0,
      d: r > 0.25 ? 1 : 0, a: r < -0.25 ? 1 : 0,
      shift: ai.sprint ? 1 : 0, j: ai.jump ? 1 : 0,
    },
    yaw: ai.yaw, pitch: ai.pitch,
    fire: ai.fire ? 1 : 0, ads: 0, reload: ai.reload ? 1 : 0, slot: 0,
  };
  ai.jump = false; ai.reload = false;
}

// ---------------- rooms ----------------
const rooms = new Map(); // code -> room
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  } while (rooms.has(code));
  return code;
}
function createRoom() {
  const room = {
    code: makeCode(),
    players: new Map(),   // id -> player (humans + bots)
    humans: new Map(),    // ws -> player
    botNames: new Set(),
    pickups: [], nextPickupId: 1,
    events: [], tracers: [],
    score: [0, 0], tick: 0, startTime: nowSec(),
    over: false, endWin: null, closeAt: 0,
    emptySince: null, snapAcc: 0, timer: null,
  };
  rooms.set(room.code, room);
  seedPickups(room);
  room.timer = setInterval(() => tickRoom(room), TICK_DT * 1000);
  return room;
}
function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearInterval(room.timer);
  rooms.delete(code);
}
function closeRoom(room) { // match over: disconnect everyone, delete room
  for (const [ws] of room.humans) {
    try { ws.close(1000, 'match over'); } catch (e) { /* ignore */ }
  }
  destroyRoom(room.code);
}
function endRoom(room, win, now) {
  room.over = true;
  room.endWin = win;
  room.closeAt = now + 15; // room closes 15 s after end
}
function endEvent(room) {
  return { k: 'end', win: room.endWin, score: [room.score[0], room.score[1]] };
}
function humanCount(room) { return room.humans.size; }
function teamHumanCounts(room) {
  const c = [0, 0];
  for (const p of room.humans.values()) c[p.team]++;
  return c;
}

function playerSnap(p, now) {
  return {
    id: p.id, name: p.name, team: p.team, bot: p.bot,
    x: r3(p.x), y: r3(p.y), z: r3(p.z),
    yaw: r3(p.yaw), pitch: r3(p.pitch),
    hp: Math.max(0, Math.round(p.hp)), alive: p.alive,
    w: p.loadout[p.slot].w,
    kills: p.kills, deaths: p.deaths,
    resp: p.alive ? 0 : Math.max(0, Math.round((p.respAt - now) * 10) / 10),
  };
}
function pickupSnap(pk) {
  return { id: pk.id, kind: pk.kind, w: pk.w, x: pk.x, y: pk.y, z: pk.z };
}
function sendSnap(room, now) {
  const tLeft = room.over ? 0 : Math.max(0, MATCH_TIME - (now - room.startTime));
  const players = [];
  for (const p of room.players.values()) players.push(playerSnap(p, now));
  const msg = JSON.stringify({
    t: 'snap',
    tick: room.tick,
    state: room.over ? 'ended' : 'playing',
    tLeft: Math.round(tLeft * 10) / 10,
    score: [room.score[0], room.score[1]],
    players,
    tracers: room.tracers,
    pickups: room.pickups.map(pickupSnap),
    events: room.over ? room.events.concat([endEvent(room)]) : room.events,
  });
  room.tracers = [];
  room.events = [];
  for (const [ws] of room.humans) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function tickRoom(room) {
  const now = nowSec();
  room.tick++;
  if (room.tick % BOT_THINK_EVERY === 0) {
    for (const p of room.players.values()) if (p.bot && p.alive) botThink(room, p, now);
  }
  for (const p of room.players.values()) {
    if (p.bot) applyBotInput(p);
    if (p.alive) { movePlayer(p); combatTick(room, p, now); }
    else if (now >= p.respAt) spawnPlayer(room, p);
  }
  pickupTick(room);
  if (!room.over) {
    if (room.score[0] >= KILL_TARGET || room.score[1] >= KILL_TARGET) {
      endRoom(room, room.score[0] > room.score[1] ? 0 : 1, now);
    } else if (now - room.startTime >= MATCH_TIME) {
      endRoom(room, room.score[0] === room.score[1] ? 'draw'
        : (room.score[0] > room.score[1] ? 0 : 1), now);
    }
  } else if (now >= room.closeAt) {
    closeRoom(room);
    return;
  }
  // 20 Hz snapshots via accumulator (keeps true 20 Hz average on a 30 Hz tick)
  room.snapAcc += TICK_DT * 1000;
  while (room.snapAcc >= SNAP_MS) {
    room.snapAcc -= SNAP_MS;
    sendSnap(room, now);
  }
}

// delete rooms that stay empty for 60 s
setInterval(() => {
  const now = nowSec();
  for (const [code, room] of rooms) {
    if (room.humans.size === 0 && room.emptySince && now - room.emptySince > 60) {
      destroyRoom(code);
    }
  }
}, 5000);

// ---------------- websocket handling ----------------
function sendErr(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'err', msg }));
}
function handleHello(ws, m) {
  if (ws.player) { sendErr(ws, 'Already in a room'); return; }
  const name = String(m.name || 'Player').slice(0, 16) || 'Player';
  let room;
  if (m.code == null) {
    room = createRoom();
  } else {
    const code = String(m.code).toUpperCase();
    room = rooms.get(code);
    if (!room) { sendErr(ws, 'Room not found'); return; }
    if (room.over) { sendErr(ws, 'Match already ended'); return; }
    if (humanCount(room) >= MAX_HUMANS) { sendErr(ws, 'Room is full'); return; }
  }
  const hc = teamHumanCounts(room);
  const team = hc[0] <= hc[1] ? 0 : 1; // balance humans across teams
  const p = makePlayer(name, team, false);
  ws.player = p; ws.room = room;
  room.players.set(p.id, p);
  room.humans.set(ws, p);
  room.emptySince = null;
  spawnPlayer(room, p);
  rebalanceBots(room);
  ws.send(JSON.stringify({
    t: 'welcome', id: p.id, team: p.team, code: room.code, you: playerSnap(p, nowSec()),
  }));
}
function handleInput(ws, m) {
  const p = ws.player;
  if (!p || !p.alive) return; // anti-cheat: ignore inputs from dead players
  const k = m.k || {};
  const b = v => (v === 1 || v === true) ? 1 : 0;
  p.input = {
    k: {
      w: b(k.w), a: b(k.a), s: b(k.s), d: b(k.d),
      shift: b(k.shift), j: b(k.j || k.jump || k.space),
    },
    yaw: Number.isFinite(+m.yaw) ? +m.yaw : p.yaw,       // clamped in movePlayer
    pitch: Number.isFinite(+m.pitch) ? +m.pitch : p.pitch,
    fire: b(m.fire), ads: b(m.ads), reload: b(m.reload),
    slot: Number.isFinite(+m.slot) ? Math.round(+m.slot) : p.slot,
  };
}
function handleLeave(ws) {
  const room = ws.room, p = ws.player;
  if (!room || !p) return;
  room.players.delete(p.id);
  room.humans.delete(ws);
  ws.player = null; ws.room = null;
  if (!room.over) rebalanceBots(room);
  if (room.humans.size === 0 && !room.emptySince) room.emptySince = nowSec();
}

// HTTP server: /health for the host's health checks; ws upgrade handled by `ws`.
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('STRIKE ARENA server\n');
  }
});
const wss = new WebSocket.Server({ server: httpServer });
wss.on('connection', ws => {
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (m.t === 'hello') handleHello(ws, m);
    else if (m.t === 'input') handleInput(ws, m);
    else if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', now: m.now || 0, server: Date.now() }));
    }
  });
  ws.on('close', () => handleLeave(ws));
  ws.on('error', () => {});
});
httpServer.listen(PORT, () => {
  console.log(`STRIKE ARENA server listening on :${PORT}`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

module.exports = { rooms }; // for tests / embedding
