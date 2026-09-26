'use strict';
/* Integration test for STRIKE ARENA server.
 * Boots server.js, connects 3 fake ws clients (1 creates a room, 2 join),
 * streams random inputs for ~25 simulated seconds, then asserts:
 *   1. welcome messages received (x3)
 *   2. snapshots flowing at ~20 Hz
 *   3. bots present (10 total players: 3 humans + 7 bots)
 *   4. at least one kill event occurs
 *   5. pickups spawn / are present
 * Exit code 0 = all pass, 1 = failure.
 */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 18777;
const DUR_MS = 25000;
const URL = `ws://127.0.0.1:${PORT}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const results = [];
  const ok = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  };

  // ---- boot server ----
  const srv = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
  });
  let out = '';
  srv.stdout.on('data', d => { out += d; });
  srv.stderr.on('data', d => { out += d; });
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('server did not print listening: ' + out)), 10000);
      const iv = setInterval(() => {
        if (out.includes('listening')) { clearTimeout(to); clearInterval(iv); res(); }
      }, 100);
    });
  } catch (e) {
    ok('server boot', false, e.message);
    srv.kill();
    process.exit(1);
  }
  console.log('server up:', out.trim().split('\n').pop());

  const stats = {
    welcomes: 0, snaps: 0, snapTimes: [], // snapTimes: first client only (broadcasts are per-client)
    playersMax: 0, botsMax: 0, humansMax: 0,
    lastPlayers: 0, lastBots: 0, lastHumans: 0,
    kills: 0, pickupsMax: 0, pickupEvents: 0, errs: [],
  };
  let roomCode = null;
  const clients = [];
  let firstClient = true;

  function attach(ws, tag) {
    const isFirst = firstClient;
    firstClient = false;
    ws.on('message', data => {
      let m;
      try { m = JSON.parse(data); } catch (e) { return; }
      if (m.t === 'welcome') {
        stats.welcomes++;
        if (!roomCode) roomCode = m.code;
      } else if (m.t === 'err') {
        stats.errs.push(tag + ': ' + m.msg);
      } else if (m.t === 'snap') {
        stats.snaps++;
        if (isFirst) stats.snapTimes.push(Date.now());
        const n = m.players.length;
        if (n > stats.playersMax) stats.playersMax = n;
        const bots = m.players.filter(p => p.bot).length;
        const humans = m.players.filter(p => !p.bot).length;
        if (bots > stats.botsMax) stats.botsMax = bots;
        if (humans > stats.humansMax) stats.humansMax = humans;
        stats.lastPlayers = n; stats.lastBots = bots; stats.lastHumans = humans;
        if (m.pickups.length > stats.pickupsMax) stats.pickupsMax = m.pickups.length;
        for (const e of m.events || []) {
          if (e.k === 'kill') stats.kills++;
          if (e.k === 'pickup') stats.pickupEvents++;
        }
      }
    });
  }
  async function connectClient(name, code) {
    const ws = new WebSocket(URL);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    attach(ws, name);
    ws.send(JSON.stringify({ t: 'hello', name, code }));
    clients.push(ws);
    return ws;
  }

  // ---- 1 creates, 2 join ----
  await connectClient('TestA', null);
  await sleep(400);
  if (!roomCode) {
    ok('room creation (welcome with code)', false, 'no welcome received; errs=' + stats.errs.join('|'));
    srv.kill(); process.exit(1);
  }
  await connectClient('TestB', roomCode);
  await connectClient('TestC', roomCode);
  await sleep(1500); // let welcomes + first snaps arrive

  // ---- random inputs for ~25 s ----
  let yaw = 0;
  const inputTimers = clients.map(ws => setInterval(() => {
    yaw += (Math.random() - 0.5) * 0.6;
    ws.send(JSON.stringify({
      t: 'input',
      seq: (Math.random() * 1e9) | 0,
      k: {
        w: Math.random() < 0.6 ? 1 : 0,
        a: Math.random() < 0.25 ? 1 : 0,
        s: Math.random() < 0.15 ? 1 : 0,
        d: Math.random() < 0.25 ? 1 : 0,
        shift: Math.random() < 0.4 ? 1 : 0,
        j: Math.random() < 0.05 ? 1 : 0,
      },
      yaw,
      pitch: (Math.random() - 0.5) * 0.3,
      fire: Math.random() < 0.35 ? 1 : 0,
      ads: 0,
      reload: Math.random() < 0.03 ? 1 : 0,
      slot: 0,
    }));
  }, 120));

  const t0 = Date.now();
  await sleep(DUR_MS);
  for (const t of inputTimers) clearInterval(t);

  // ---- assertions ----
  ok('welcome messages received (3 clients)', stats.welcomes === 3,
    `${stats.welcomes}/3 welcomes, code=${roomCode}, errs=[${stats.errs.join('|')}]`);

  const windowMs = 5000;
  const recent = stats.snapTimes.filter(t => t >= t0 + DUR_MS - windowMs);
  const rate = recent.length / (windowMs / 1000);
  ok('snapshots flowing at ~20 Hz', rate >= 16 && rate <= 24,
    `${rate.toFixed(1)} Hz over last 5 s (${recent.length} snaps, single client)`);

  ok('bots present — 10 total players', stats.playersMax === 10,
    `max players=${stats.playersMax} (humans=${stats.humansMax}, bots=${stats.botsMax})`);

  ok('final roster rebalanced to 3 humans + 7 bots',
    stats.lastPlayers === 10 && stats.lastHumans === 3 && stats.lastBots === 7,
    `last snap: players=${stats.lastPlayers} humans=${stats.lastHumans} bots=${stats.lastBots}`);

  ok('at least one kill event occurs', stats.kills >= 1,
    `${stats.kills} kill events observed`);

  ok('pickups spawn', stats.pickupsMax > 0 || stats.pickupEvents > 0,
    `max pickups in snap=${stats.pickupsMax}, pickup events=${stats.pickupEvents}`);

  // ---- cleanup ----
  for (const ws of clients) try { ws.close(); } catch (e) { /* ignore */ }
  srv.kill('SIGTERM');
  await sleep(500);

  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('test harness error:', e); process.exit(1); });
