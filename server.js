const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8765;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const ROOT = __dirname;
const MAP_W = 84;
const MAP_H = 84;
const INACTIVITY_TIMEOUT_MS = 45000;
const HEARTBEAT_TIMEOUT_MS = 25000;
const AOI_RADIUS_SQ = 42 * 42;

function q(n) {
  return Math.round(n * 100) / 100;
}

// --- Shared Large Seoul Map (84x84) ---
const map = Array.from({ length: MAP_H }, () => Array(MAP_W).fill(0));
const lanterns = [];

for (let y = 0; y < MAP_H; y++) {
  for (let x = 0; x < MAP_W; x++) {
    if (x <= 1 || x >= MAP_W - 2 || y <= 1 || y >= MAP_H - 2) map[y][x] = 1;
  }
}

// Multi-district Hanok blocks across 84x84 Seoul
const blocks = [
  // North-West district
  { x: 7, y: 7, w: 9, h: 6 },
  { x: 21, y: 7, w: 10, h: 5 },
  { x: 7, y: 19, w: 6, h: 9 },
  // North-East district
  { x: 52, y: 7, w: 10, h: 5 },
  { x: 68, y: 7, w: 9, h: 6 },
  { x: 70, y: 19, w: 6, h: 9 },
  // Central-North & Central-South shrines
  { x: 36, y: 14, w: 12, h: 4 },
  { x: 36, y: 66, w: 12, h: 4 },
  { x: 16, y: 37, w: 5, h: 10 },
  { x: 63, y: 37, w: 5, h: 10 },
  // Inner courtyard pillars
  { x: 30, y: 28, w: 5, h: 4 },
  { x: 49, y: 28, w: 5, h: 4 },
  { x: 30, y: 52, w: 5, h: 4 },
  { x: 49, y: 52, w: 5, h: 4 },
  // South-West district
  { x: 7, y: 56, w: 6, h: 9 },
  { x: 7, y: 71, w: 9, h: 6 },
  { x: 21, y: 72, w: 10, h: 5 },
  // South-East district
  { x: 70, y: 56, w: 6, h: 9 },
  { x: 68, y: 71, w: 9, h: 6 },
  { x: 52, y: 72, w: 10, h: 5 }
];

for (const b of blocks) {
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) map[y][x] = 1;
  }
}

// Quarantine barricades
const barriers = [
  [25, 41], [25, 42], [58, 41], [58, 42],
  [41, 25], [42, 25], [41, 58], [42, 58],
  [18, 28], [19, 28], [64, 28], [65, 28],
  [18, 55], [19, 55], [64, 55], [65, 55]
];
for (const [bx, by] of barriers) map[by][bx] = 2;

// Lanterns
const lanternCoords = [
  [37, 37], [46, 37], [37, 46], [46, 46],
  [26, 26], [57, 26], [26, 57], [57, 57],
  [15, 15], [68, 15], [15, 68], [68, 68],
  [42, 20], [42, 63], [22, 42], [61, 42]
];
for (const [lx, ly] of lanternCoords) {
  map[ly][lx] = 3;
  lanterns.push({ x: lx + 0.5, y: ly + 0.5, flicker: (lx * 3 + ly) % 10 });
}

// Rain puddles
for (let i = 0; i < 120; i++) {
  const px = 4 + ((i * 17) % (MAP_W - 8));
  const py = 4 + ((i * 23) % (MAP_H - 8));
  if (map[py][px] === 0 && Math.hypot(px - 42, py - 42) > 3) {
    map[py][px] = 4;
  }
}

function isSolid(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= MAP_W || iy >= MAP_H) return true;
  const t = map[iy][ix];
  return t === 1 || t === 2 || t === 3;
}

function canOccupy(x, y, r = 0.28) {
  return (
    !isSolid(x - r, y - r) &&
    !isSolid(x + r, y - r) &&
    !isSolid(x - r, y + r) &&
    !isSolid(x + r, y + r)
  );
}

// --- Weapon Progression Table ---
const WEAPONS = [
  { level: 1, name: "Garras Carmesí", reach: 3.1, arc: 0.1, dmg: 28, bleed: 0, chain: 0, wave: false, lifesteal: 0 },
  { level: 2, name: "Hoz Lunar", reach: 3.8, arc: -0.15, dmg: 36, bleed: 4, chain: 0, wave: false, lifesteal: 0 },
  { level: 3, name: "Espadas Gemelas", reach: 4.0, arc: -0.2, dmg: 44, bleed: 5, chain: 0, wave: true, lifesteal: 0 },
  { level: 4, name: "Lanza Dokkaebi", reach: 4.7, arc: 0.0, dmg: 54, bleed: 6, chain: 2, wave: true, lifesteal: 1 },
  { level: 5, name: "Segadora del Eclipse", reach: 5.2, arc: -0.35, dmg: 68, bleed: 9, chain: 3, wave: true, lifesteal: 2 }
];

function getWeaponForLevel(lvl) {
  return WEAPONS[Math.min(WEAPONS.length - 1, Math.max(0, lvl - 1))];
}

function xpForNextLevel(lvl) {
  return 60 + (lvl - 1) * 55;
}

// --- Shared World State ---
let nextId = 1;
let nextEnemyId = 1;
let nextDropId = 1;
const clients = new Map();
const enemies = [];
const projectiles = [];
const drops = [];
let dropSpawnTimer = 3.0;
let wave = 1;

const WEAPON_GLYPHS = ["/", ")", "X", "T", "@"];
const WEAPON_COLORS = ["#ff4d6d", "#facc15", "#fb923c", "#2ec4b6", "#e879f9"];

function spawnWeaponDrop(xOverride = null, yOverride = null, tierOverride = null) {
  if (drops.length >= 10) return;
  const pos = xOverride != null ? { x: xOverride, y: yOverride } : randomOpenSpot();
  const roll = Math.random();
  const tier = tierOverride || (roll > 0.85 ? 5 : roll > 0.6 ? 4 : roll > 0.3 ? 3 : 2);
  const w = getWeaponForLevel(tier);
  drops.push({
    id: nextDropId++,
    x: pos.x,
    y: pos.y,
    tier,
    name: w.name,
    glyph: WEAPON_GLYPHS[tier - 1] || "*",
    color: WEAPON_COLORS[tier - 1] || "#ffb347",
    life: 45
  });
}

function randomOpenSpot() {
  for (let i = 0; i < 100; i++) {
    const x = 5 + Math.random() * (MAP_W - 10);
    const y = 5 + Math.random() * (MAP_H - 10);
    if (canOccupy(x, y)) return { x, y };
  }
  return { x: 42.5, y: 42.5 };
}

function spawnEnemy(typeOverride = null) {
  const pos = randomOpenSpot();
  const roll = Math.random();
  let type = typeOverride || "blade";
  if (!typeOverride) {
    if (roll > 0.7) type = "archer";
    else if (roll > 0.45 && wave >= 2) type = "heavy";
  }
  // Stronger bots
  const maxHp =
    type === "dokkaebi"
      ? 260 + wave * 45
      : type === "heavy"
      ? 145 + wave * 12
      : type === "archer"
      ? 68 + wave * 6
      : 95 + wave * 8;

  enemies.push({
    id: nextEnemyId++,
    x: pos.x,
    y: pos.y,
    type,
    hp: maxHp,
    maxHp,
    speed: type === "heavy" ? 3.7 : type === "archer" ? 4.3 : type === "dokkaebi" ? 4.7 : 5.5,
    cd: 0.5 + Math.random() * 0.7,
    windup: 0,
    windupMax: type === "dokkaebi" ? 0.55 : 0.4,
    aimX: 0,
    aimY: 0,
    stun: 0,
    bleed: 0,
    bleedTimer: 0,
    hitFlash: 0,
    teleportCd: 4.0
  });
}

function ensureEnemies() {
  const targetCount = Math.min(34, 14 + wave * 2 + clients.size * 2);
  while (enemies.length < targetCount) {
    const needDokkaebi = wave >= 2 && enemies.filter((e) => e.type === "dokkaebi").length < Math.min(3, Math.floor(wave / 2) + 1);
    spawnEnemy(needDokkaebi ? "dokkaebi" : null);
  }
}

// --- WebSocket RFC 6455 Helpers ---
function encodeFrame(str, opcode = 0x81) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(obj, excludeWs = null) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const [ws] of clients) {
    if (ws !== excludeWs && !ws.destroyed && ws.writable) {
      ws.write(frame);
    }
  }
}

function sendTo(ws, obj) {
  if (!ws.destroyed && ws.writable) {
    ws.write(encodeFrame(JSON.stringify(obj)));
  }
}

function resetPlayerProgress(player) {
  player.level = 1;
  player.weaponTier = 1;
  player.xp = 0;
  player.xpNext = xpForNextLevel(1);
  player.maxHp = 100;
  player.hp = 100;
  player.blood = 40;
  player.score = 0;
  player.kills = 0;
  player.comboStep = 0;
  player.powerTime = 0;
  player.drainCd = 0;
}

function awardXpAndScore(player, xpGain, scoreGain, isKill = false) {
  if (!player || !player.alive) return;
  player.xp += xpGain;
  player.score += scoreGain;
  if (isKill) player.kills += 1;

  while (player.xp >= player.xpNext) {
    player.xp -= player.xpNext;
    player.level += 1;
    player.xpNext = xpForNextLevel(player.level);
    player.maxHp += 15;
    player.hp = Math.min(player.maxHp, player.hp + 12);
    player.blood = Math.min(player.maxBlood, player.blood + 35);
    const w = getWeaponForLevel(player.level);
    broadcast({
      type: "fx",
      kind: "levelup",
      x: player.x,
      y: player.y,
      playerId: player.id,
      level: player.level,
      weaponName: w.name
    });
  }
}

function damagePlayer(target, amount, attacker = null) {
  if (!target.alive || target.invuln > 0) return false;
  if (target.parryTime > 0) {
    target.parryTime = 0;
    target.invuln = 0.5;
    target.blood = Math.min(target.maxBlood, target.blood + 30);
    target.score += 75;
    broadcast({ type: "fx", kind: "parry", x: target.x, y: target.y, playerId: target.id });
    if (attacker && attacker.id) attacker.stun = 0.9;
    return false;
  }

  target.hp -= amount;
  target.invuln = 0.32;
  broadcast({ type: "fx", kind: "hit", x: target.x, y: target.y, dmg: amount, color: "#e63946" });

  if (target.hp <= 0) {
    const finalScore = target.score;
    const finalLevel = target.level;
    resetPlayerProgress(target);
    target.hp = 0;
    target.alive = false;
    broadcast({ type: "fx", kind: "kill", x: target.x, y: target.y, color: "#e63946" });
    sendTo(target.ws, { type: "died", finalScore, finalLevel });
    if (attacker && attacker !== target && attacker.alive) {
      awardXpAndScore(attacker, 100, 500, true);
    }
  }
  return true;
}

function damageEnemy(e, amount, kx, ky, attacker, isCrit = false) {
  e.hp -= amount;
  e.hitFlash = 0.16;
  e.stun = Math.max(e.stun, 0.16);
  if (canOccupy(e.x + kx, e.y + ky)) {
    e.x += kx;
    e.y += ky;
  }
  broadcast({
    type: "fx",
    kind: "hit",
    x: e.x,
    y: e.y,
    dmg: Math.round(amount),
    crit: isCrit,
    color: isCrit ? "#ffb347" : "#e63946"
  });

  if (attacker) {
    const tier = Math.max(attacker.level, attacker.weaponTier || 1);
    const w = getWeaponForLevel(tier);
    if (w.bleed > 0) {
      e.bleed = w.bleed;
      e.bleedTimer = 3.0;
    }
    if (w.lifesteal > 0) {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + w.lifesteal);
    }
    attacker.blood = Math.min(attacker.maxBlood, attacker.blood + 9);
  }

  if (e.hp <= 0 && attacker) {
    const xp = e.type === "dokkaebi" ? 95 : e.type === "heavy" ? 45 : 30;
    const sc = e.type === "dokkaebi" ? 350 : e.type === "heavy" ? 160 : 100;
    awardXpAndScore(attacker, xp, sc, true);
    if (e.type === "dokkaebi" || (e.type === "heavy" && Math.random() < 0.5) || Math.random() < 0.22) {
      const dropTier = e.type === "dokkaebi" ? 4 + (Math.random() > 0.5 ? 1 : 0) : e.type === "heavy" ? 3 : 2;
      spawnWeaponDrop(e.x, e.y, dropTier);
    }
  }
}

function handleClientMessage(ws, msg) {
  const p = clients.get(ws);
  if (!p) return;

  if (msg.type === "join") {
    p.lastActive = Date.now();
    const cleanName = String(msg.name || "").trim().slice(0, 16) || `Vampiro-${p.id}`;
    p.name = cleanName;
    p.skin = String(msg.skin || "vampire").slice(0, 16);
    resetPlayerProgress(p);
    p.alive = true;
    const pos = randomOpenSpot();
    p.x = pos.x;
    p.y = pos.y;
    sendTo(ws, { type: "welcome", id: p.id, name: p.name, mapW: MAP_W, mapH: MAP_H, map, lanterns });
  } else if (msg.type === "skin") {
    p.lastActive = Date.now();
    p.skin = String(msg.skin || "vampire").slice(0, 16);
  } else if (msg.type === "respawn") {
    p.lastActive = Date.now();
    resetPlayerProgress(p);
    const pos = randomOpenSpot();
    p.x = pos.x;
    p.y = pos.y;
    p.alive = true;
    p.invuln = 1.0;
  } else if (msg.type === "state" && p.alive) {
    const moved =
      msg.moving ||
      Math.hypot((msg.x ?? p.x) - p.x, (msg.y ?? p.y) - p.y) > 0.02;
    if (moved) p.lastActive = Date.now();
    if (typeof msg.x === "number" && typeof msg.y === "number" && canOccupy(msg.x, msg.y, 0.2)) {
      p.x = msg.x;
      p.y = msg.y;
    }
    p.fx = typeof msg.fx === "number" ? msg.fx : p.fx;
    p.fy = typeof msg.fy === "number" ? msg.fy : p.fy;
    p.moving = Boolean(msg.moving);
  } else if (msg.type === "action" && p.alive) {
    p.lastActive = Date.now();
    const effTier = Math.max(p.level, p.weaponTier || 1);
    const w = getWeaponForLevel(effTier);
    const fx = typeof msg.fx === "number" ? msg.fx : p.fx;
    const fy = typeof msg.fy === "number" ? msg.fy : p.fy;

    if (msg.kind === "slash") {
      p.comboStep = (p.comboStep + 1) % 3;
      const isCrit = p.comboStep === 2 || Math.random() < 0.16;
      const dmg = w.dmg * (isCrit ? 1.45 : 1.0) * (p.powerTime > 0 ? 1.35 : 1.0);

      broadcast({
        type: "fx",
        kind: "slash",
        playerId: p.id,
        x: p.x,
        y: p.y,
        fx,
        fy,
        level: p.level,
        comboStep: p.comboStep
      });

      const chainTargets = [];
      for (const e of enemies) {
        const ex = e.x - p.x;
        const ey = e.y - p.y;
        const dist = Math.hypot(ex, ey);
        if (dist < w.reach) {
          const dot = (ex / (dist || 1)) * fx + (ey / (dist || 1)) * fy;
          if (dot > w.arc || dist < 1.2) {
            damageEnemy(e, dmg, fx * 0.55, fy * 0.55, p, isCrit);
            chainTargets.push(e);
          }
        }
      }

      if (w.chain > 0 && chainTargets.length > 0) {
        const src = chainTargets[0];
        let chained = 0;
        for (const other of enemies) {
          if (other !== src && other.hp > 0 && Math.hypot(other.x - src.x, other.y - src.y) < 5.5) {
            damageEnemy(other, dmg * 0.55, 0, 0, p, false);
            broadcast({ type: "fx", kind: "chain", sx: src.x, sy: src.y, tx: other.x, ty: other.y });
            chained++;
            if (chained >= w.chain) break;
          }
        }
      }

      if (w.wave && p.comboStep === 2) {
        projectiles.push({
          x: p.x + fx * 0.8,
          y: p.y + fy * 0.8,
          vx: fx * 17,
          vy: fy * 17,
          life: 1.1,
          color: p.level >= 5 ? "#2ec4b6" : "#ff4d6d",
          ownerId: p.id,
          dmg: Math.round(w.dmg * 0.8)
        });
      }

      for (const [, other] of clients) {
        if (other === p || !other.alive) continue;
        const ox = other.x - p.x;
        const oy = other.y - p.y;
        const dist = Math.hypot(ox, oy);
        if (dist < w.reach) {
          const dot = (ox / (dist || 1)) * fx + (oy / (dist || 1)) * fy;
          if (dot > w.arc || dist < 1.2) {
            damagePlayer(other, Math.round(dmg * 0.6), p);
          }
        }
      }
    } else if (msg.kind === "dash") {
      p.invuln = 0.28;
      broadcast({ type: "fx", kind: "dash", x: p.x, y: p.y, playerId: p.id });
    } else if (msg.kind === "parry") {
      p.parryTime = 0.35;
    } else if (msg.kind === "power") {
      p.powerTime = 8.0;
      broadcast({ type: "fx", kind: "power", x: p.x, y: p.y, playerId: p.id });
    } else if (msg.kind === "drain") {
      if (p.drainCd > 0) return;
      let target = null;
      let bestDist = 3.8;
      for (const e of enemies) {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < bestDist) {
          bestDist = d;
          target = e;
        }
      }
      if (target) {
        p.drainCd = 8.0;
        const dmg = target.hp <= 42 ? 999 : 25;
        damageEnemy(target, dmg, 0, 0, p, target.hp <= 42);
        p.hp = Math.min(p.maxHp, p.hp + 8);
        p.blood = Math.min(p.maxBlood, p.blood + 20);
        broadcast({ type: "fx", kind: "drain", sx: target.x, sy: target.y, tx: p.x, ty: p.y });
      }
    } else if (msg.kind === "nova" && p.blood >= 50) {
      p.blood -= 50;
      broadcast({ type: "fx", kind: "nova", x: p.x, y: p.y, color: "#2ec4b6", radius: 6.5 });
      for (const e of enemies) {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < 6.5) {
          const nx = (e.x - p.x) / (d || 1);
          const ny = (e.y - p.y) / (d || 1);
          damageEnemy(e, 60 + p.level * 8, nx * 1.4, ny * 1.4, p, true);
          e.stun = 0.9;
        }
      }
      for (const [, other] of clients) {
        if (other !== p && other.alive && Math.hypot(other.x - p.x, other.y - p.y) < 6.5) {
          damagePlayer(other, 35, p);
        }
      }
    }
  }
}

// --- Heartbeat & Inactivity Sweeper (every 5s) ---
setInterval(() => {
  const now = Date.now();
  for (const [ws, p] of clients) {
    if (now - p.lastPong > HEARTBEAT_TIMEOUT_MS) {
      clients.delete(ws);
      ws.destroy();
      continue;
    }
    if (p.alive && now - p.lastActive > INACTIVITY_TIMEOUT_MS) {
      sendTo(ws, { type: "kicked", reason: "Sesión cerrada por inactividad (45s)" });
      clients.delete(ws);
      ws.end();
      continue;
    }
    if (!ws.destroyed && ws.writable) {
      ws.write(Buffer.from([0x89, 0x00])); // WebSocket Ping
    }
  }
}, 5000);

// --- Server Simulation Tick (15 Hz + Per-Client AOI & Quantized State) ---
let lastTick = Date.now();
let tickCount = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.12, (now - lastTick) / 1000);
  lastTick = now;
  tickCount++;

  ensureEnemies();

  for (const [, p] of clients) {
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    if (p.parryTime > 0) p.parryTime = Math.max(0, p.parryTime - dt);
    if (p.powerTime > 0) p.powerTime = Math.max(0, p.powerTime - dt);
    if (p.drainCd > 0) p.drainCd = Math.max(0, p.drainCd - dt);
  }

  // Random weapon drops on the map
  dropSpawnTimer -= dt;
  if (dropSpawnTimer <= 0) {
    dropSpawnTimer = 6.5;
    spawnWeaponDrop();
  }
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.life -= dt;
    if (d.life <= 0) {
      drops.splice(i, 1);
      continue;
    }
    let pickedBy = null;
    for (const [, p] of clients) {
      if (!p.alive) continue;
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (dx * dx + dy * dy < 1.44) {
        pickedBy = p;
        break;
      }
    }
    if (pickedBy) {
      const curTier = Math.max(pickedBy.level, pickedBy.weaponTier || 1);
      if (d.tier > curTier) {
        pickedBy.weaponTier = d.tier;
      } else {
        awardXpAndScore(pickedBy, 30, 150, false);
      }
      broadcast({
        type: "fx",
        kind: "pickup",
        x: d.x,
        y: d.y,
        weaponName: d.name,
        color: d.color
      });
      drops.splice(i, 1);
    }
  }

  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.bleedTimer > 0) {
      e.bleedTimer -= dt;
      e.hp -= e.bleed * dt * 2.5;
    }
    if (e.hp <= 0) {
      broadcast({
        type: "fx",
        kind: "kill",
        x: e.x,
        y: e.y,
        color: e.type === "dokkaebi" ? "#2ec4b6" : "#e63946"
      });
      enemies.splice(i, 1);
      continue;
    }
    if (e.hitFlash > 0) e.hitFlash -= dt;
    if (e.stun > 0) {
      e.stun -= dt;
      continue;
    }

    let target = null;
    let bestDistSq = Infinity;
    for (const [, p] of clients) {
      if (!p.alive) continue;
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        target = p;
      }
    }
    if (!target) continue;

    const dx = target.x - e.x;
    const dy = target.y - e.y;
    const dist = Math.sqrt(bestDistSq) || 1;
    const nx = dx / dist;
    const ny = dy / dist;

    if (e.type === "dokkaebi") {
      e.teleportCd -= dt;
      if (e.teleportCd <= 0 && dist > 6) {
        e.teleportCd = 4.2;
        const ang = Math.random() * Math.PI * 2;
        const tx = target.x + Math.cos(ang) * 5;
        const ty = target.y + Math.sin(ang) * 5;
        if (canOccupy(tx, ty)) {
          e.x = tx;
          e.y = ty;
          broadcast({ type: "fx", kind: "nova", x: e.x, y: e.y, color: "#2ec4b6", radius: 2.0 });
        }
      }
    }

    if (e.windup > 0) {
      e.windup -= dt;
      if (e.windup <= 0) {
        if (e.type === "archer") {
          projectiles.push({
            x: e.x,
            y: e.y,
            vx: e.aimX * 16,
            vy: e.aimY * 16,
            life: 2.0,
            color: "#ffb347",
            ownerId: null,
            dmg: 20
          });
        } else if (e.type === "dokkaebi") {
          for (let k = 0; k < 8; k++) {
            const ang = (Math.PI * 2 * k) / 8;
            projectiles.push({
              x: e.x,
              y: e.y,
              vx: Math.cos(ang) * 10.5,
              vy: Math.sin(ang) * 10.5,
              life: 2.2,
              color: "#2ec4b6",
              ownerId: null,
              dmg: 24
            });
          }
        } else {
          if (e.type === "heavy" && canOccupy(e.x + nx * 1.1, e.y + ny * 1.1)) {
            e.x += nx * 0.9;
            e.y += ny * 0.9;
          }
          if (dist < 2.5) {
            damagePlayer(target, e.type === "heavy" ? 32 : 20, e);
          }
        }
        e.cd = e.type === "archer" ? 1.45 : 1.05;
      }
      continue;
    }

    if (e.cd > 0) e.cd -= dt;

    if (e.type === "archer") {
      if (dist > 9.5) {
        if (canOccupy(e.x + nx * e.speed * dt, e.y)) e.x += nx * e.speed * dt;
        if (canOccupy(e.x, e.y + ny * e.speed * dt)) e.y += ny * e.speed * dt;
      } else if (dist < 5) {
        if (canOccupy(e.x - nx * e.speed * 0.7 * dt, e.y)) e.x -= nx * e.speed * 0.7 * dt;
        if (canOccupy(e.x, e.y - ny * e.speed * 0.7 * dt)) e.y -= ny * e.speed * 0.7 * dt;
      }
      if (e.cd <= 0 && dist < 14) {
        e.windup = e.windupMax;
        e.aimX = nx;
        e.aimY = ny;
      }
    } else if (e.type === "dokkaebi") {
      if (canOccupy(e.x + nx * e.speed * dt, e.y)) e.x += nx * e.speed * dt;
      if (canOccupy(e.x, e.y + ny * e.speed * dt)) e.y += ny * e.speed * dt;
      if (e.cd <= 0) e.windup = e.windupMax;
    } else {
      if (dist > 1.4) {
        if (canOccupy(e.x + nx * e.speed * dt, e.y)) e.x += nx * e.speed * dt;
        if (canOccupy(e.x, e.y + ny * e.speed * dt)) e.y += ny * e.speed * dt;
      } else if (e.cd <= 0) {
        e.windup = e.windupMax;
      }
    }
  }

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.life -= dt;
    if (pr.life <= 0 || isSolid(pr.x, pr.y)) {
      projectiles.splice(i, 1);
      continue;
    }

    if (pr.ownerId) {
      let hit = false;
      const owner = [...clients.values()].find((c) => c.id === pr.ownerId);
      for (const e of enemies) {
        if (Math.hypot(e.x - pr.x, e.y - pr.y) < 0.9) {
          damageEnemy(e, pr.dmg, 0, 0, owner, true);
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const [, p] of clients) {
          if (p.id !== pr.ownerId && p.alive && Math.hypot(p.x - pr.x, p.y - pr.y) < 0.8) {
            damagePlayer(p, Math.round(pr.dmg * 0.65), owner);
            hit = true;
            break;
          }
        }
      }
      if (hit) projectiles.splice(i, 1);
    } else {
      for (const [, p] of clients) {
        if (p.alive && Math.hypot(p.x - pr.x, p.y - pr.y) < 0.8) {
          damagePlayer(p, pr.dmg, null);
          projectiles.splice(i, 1);
          break;
        }
      }
    }
  }

  const maxKills = [...clients.values()].reduce((acc, c) => acc + c.kills, 0);
  wave = Math.max(1, 1 + Math.floor(maxKills / 10));

  const includeLeaderboard = tickCount % 8 === 0;
  const leaderboard = includeLeaderboard
    ? [...clients.values()]
        .map((c) => ({
          id: c.id,
          name: c.name,
          score: c.score,
          kills: c.kills,
          level: c.level
        }))
        .sort((a, b) => b.score - a.score || b.kills - a.kills)
        .slice(0, 10)
    : null;

  const playersPayload = [...clients.values()].map((c) => ({
    id: c.id,
    name: c.name,
    skin: c.skin || "vampire",
    x: q(c.x),
    y: q(c.y),
    fx: q(c.fx),
    fy: q(c.fy),
    moving: c.moving,
    hp: Math.round(c.hp),
    maxHp: c.maxHp,
    blood: Math.round(c.blood),
    maxBlood: c.maxBlood,
    level: c.level,
    xp: c.xp,
    xpNext: c.xpNext,
    score: c.score,
    kills: c.kills,
    alive: c.alive,
    parry: c.parryTime > 0,
    power: c.powerTime > 0,
    drainCd: q(c.drainCd || 0),
    weaponTier: Math.max(c.level, c.weaponTier || 1),
    weapon: getWeaponForLevel(Math.max(c.level, c.weaponTier || 1)).name
  }));

  for (const [ws, client] of clients) {
    if (ws.destroyed || !ws.writable) continue;
    const cx = client.x;
    const cy = client.y;

    const nearbyEnemies = [];
    for (const e of enemies) {
      const dx = e.x - cx;
      const dy = e.y - cy;
      if (dx * dx + dy * dy <= AOI_RADIUS_SQ) {
        nearbyEnemies.push({
          id: e.id,
          x: q(e.x),
          y: q(e.y),
          type: e.type,
          windup: e.windup > 0 ? 1 : 0,
          hitFlash: e.hitFlash > 0 ? 1 : 0,
          bleed: e.bleedTimer > 0 ? 1 : 0
        });
      }
    }

    const nearbyProjectiles = [];
    for (const pr of projectiles) {
      const dx = pr.x - cx;
      const dy = pr.y - cy;
      if (dx * dx + dy * dy <= AOI_RADIUS_SQ) {
        nearbyProjectiles.push({ x: q(pr.x), y: q(pr.y), color: pr.color });
      }
    }

    const nearbyDrops = [];
    for (const d of drops) {
      const dx = d.x - cx;
      const dy = d.y - cy;
      if (dx * dx + dy * dy <= AOI_RADIUS_SQ) {
        nearbyDrops.push({ id: d.id, x: q(d.x), y: q(d.y), glyph: d.glyph, color: d.color, name: d.name });
      }
    }

    const pkt = {
      type: "world",
      wave,
      players: playersPayload,
      enemies: nearbyEnemies,
      projectiles: nearbyProjectiles,
      drops: nearbyDrops
    };
    if (leaderboard) pkt.leaderboard = leaderboard;
    sendTo(ws, pkt);
  }
}, 66);

// --- HTTP + WebSocket Server (Dokploy / Traefik Reverse-Proxy Ready) ---
function applyProxyAndCorsHeaders(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN === "*" && origin ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

const server = http.createServer((req, res) => {
  applyProxyAndCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const cleanUrl = (req.url || "/").split("?")[0];
  if (cleanUrl === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ status: "ok", port: PORT, clients: clients.size }));
  }

  const relPath = cleanUrl === "/" ? "index.html" : cleanUrl.replace(/^\/+/, "");
  const filePath = path.join(ROOT, relPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    const mime = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "application/javascript" : "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const id = nextId++;
  const pos = randomOpenSpot();
  const now = Date.now();
  clients.set(socket, {
    ws: socket,
    id,
    name: `Vampiro-${id}`,
    skin: "vampire",
    x: pos.x,
    y: pos.y,
    fx: 1,
    fy: 0,
    moving: false,
    hp: 100,
    maxHp: 100,
    blood: 40,
    maxBlood: 100,
    level: 1,
    weaponTier: 1,
    xp: 0,
    xpNext: xpForNextLevel(1),
    score: 0,
    kills: 0,
    comboStep: 0,
    alive: false,
    invuln: 0,
    parryTime: 0,
    powerTime: 0,
    drainCd: 0,
    lastActive: now,
    lastPong: now
  });

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    const player = clients.get(socket);
    if (player) player.lastPong = Date.now();

    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return;

      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (masked && mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        clients.delete(socket);
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        const pong = Buffer.from(payload);
        socket.write(Buffer.concat([Buffer.from([0x8a, pong.length]), pong]));
        continue;
      }
      if (opcode === 0xa) {
        continue; // Pong received
      }
      if (opcode === 0x1) {
        try {
          handleClientMessage(socket, JSON.parse(payload.toString("utf8")));
        } catch (_) {}
      }
    }
  });

  const cleanup = () => clients.delete(socket);
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SEOUL ASCII IO server running at http://127.0.0.1:${PORT}`);
});
