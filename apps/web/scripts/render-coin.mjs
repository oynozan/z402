#!/usr/bin/env node
/*
 * Renders public/coin.png, the picture under the hero's Dither Veil. A thick gold coin seen at a three-quarter angle,
 * with a reeded edge, a raised rim and a raised Z, lit like a studio product shot on the page ground (#161616), so the
 * veil reads the edge of the picture as a plain matte and the cursor reveals gold.
 *
 * Each pixel is supersampled. A ray is clipped to the coin's bounding slab and cylinder, then sphere traced through a
 * signed distance field in the coin's own frame. A hit is shaded as metal, Schlick Fresnel over a gold F0 times an
 * analytic studio environment (two softboxes, a strip light and a dim backdrop) averaged over a lobe whose width is
 * the roughness of that part of the coin, then darkened by a short ambient occlusion probe. Colour is mixed in linear
 * light, tone mapped and written as an 8-bit RGB PNG with node:zlib. No dependencies.
 *
 * Run it as node scripts/render-coin.mjs [out.png] [--scale 0.25] [--samples 3], which writes public/coin.png by default.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const OUT = resolve(positional[0] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../public/coin.png"));
const SCALE = flag("--scale", 1);
const SS = Math.max(1, Math.round(flag("--samples", 3)));

const W = Math.round(1600 * SCALE);
const H = Math.round(1100 * SCALE);
const GROUND = 22;

/* Coin geometry, in units of the coin radius */

const HALF_T = 0.092;
const EDGE_R = 0.034;
const RIM_IN = 0.835;
const RIM_OUT = 0.962;
const RIM_UP = 0.03;
const RIM_ROUND = 0.014;
const REL_UP = 0.026;
const REL_ROUND = 0.01;
const REEDS = 132;
const REED_DEPTH = 0.0055;
const Z_SCALE = 1.16;
const BOUND_R = 1.01;
const BOUND_Z = HALF_T + RIM_UP + REL_UP + 0.01;

/* Camera and pose */

const CAM_Z = 8;
const TAN_HALF = Math.tan(((19 / 2) * Math.PI) / 180);
const ASPECT = W / H;
const YAW = (-34 * Math.PI) / 180;
const PITCH = (-16 * Math.PI) / 180;
const ROLL = (-9 * Math.PI) / 180;
const SHIFT_X = 0.0;
const SHIFT_Y = 0.02;

/* Material */

/* Linear #F4B728, so mid tones land on that gold and Fresnel pales it only at grazing angles */
const F0 = [1.0, 0.523, 0.0234];
const EXPOSURE = 1.0;
/* A near-mirror field keeps the softbox gradient, a frosted Z averages it, which is what sets the Z apart */
const ROUGH = [0.07, 0.06, 0.14, 0.5];

/* Rotation from the coin frame to the world, columns are the coin axes */

function rotation(yaw, pitch, roll) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  const rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const mul = (a, b) => {
    const m = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) m[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return m;
  };
  return mul(ry, mul(rx, rz));
}
const M = rotation(YAW, PITCH, ROLL);

/* Signed distance field, in the coin frame */

function sdBox2(px, py, bx, by) {
  const dx = Math.abs(px) - bx;
  const dy = Math.abs(py) - by;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

const DIAG_LEN = Math.hypot(0.72, 0.5);
const DIAG_NX = -0.5 / DIAG_LEN;
const DIAG_NY = 0.72 / DIAG_LEN;

/** The Z with a short stroke above and below, in face coordinates */
function sdGlyph(x, y) {
  const px = x / Z_SCALE;
  const py = y / Z_SCALE;
  const top = sdBox2(px, py - 0.31, 0.36, 0.07);
  const bottom = sdBox2(px, py + 0.31, 0.36, 0.07);
  const diag = Math.max(Math.abs(DIAG_NX * px + DIAG_NY * py) - 0.082, Math.abs(py) - 0.31, Math.abs(px) - 0.36);
  const tickTop = sdBox2(px, py - 0.445, 0.042, 0.066);
  const tickBottom = sdBox2(px, py + 0.445, 0.042, 0.066);
  return Math.min(top, bottom, diag, tickTop, tickBottom) * Z_SCALE;
}

function roundedProfile(qx, qz, round) {
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - round;
}

/** Which part the last distance came from, 0 field, 1 rim, 2 edge, 3 relief */
let partHit = 0;

function sdCoin(x, y, z) {
  const r = Math.hypot(x, y);
  const az = Math.abs(z);
  const reed = REED_DEPTH * (0.5 + 0.5 * Math.cos(Math.atan2(y, x) * REEDS));
  const body = roundedProfile(r + reed - (1 - EDGE_R), az - (HALF_T - EDGE_R), EDGE_R);
  const rim = roundedProfile(
    Math.abs(r - (RIM_IN + RIM_OUT) / 2) - ((RIM_OUT - RIM_IN) / 2 - RIM_ROUND),
    az - (HALF_T + RIM_UP - RIM_ROUND),
    RIM_ROUND,
  );
  let relief = 1e9;
  if (z > 0 && r < RIM_IN) {
    const bottom = HALF_T - 0.01;
    const topZ = HALF_T + REL_UP;
    relief = roundedProfile(sdGlyph(x, y) + REL_ROUND, Math.abs(z - (bottom + topZ) / 2) - ((topZ - bottom) / 2 - REL_ROUND), REL_ROUND);
  }
  let d = body;
  partHit = r > 0.975 && az < HALF_T ? 2 : 0;
  if (rim < d) {
    d = rim;
    partHit = 1;
  }
  if (relief < d) {
    d = relief;
    partHit = 3;
  }
  return d;
}

/* Studio environment, white light in world directions, y up and the camera on +z */

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function softbox(c, u, v, hu, hv, soft) {
  return { c, u, v, hu, hv, soft };
}

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function frame(center, roll = 0) {
  const c = norm3(center);
  const up = Math.abs(c[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  let u = norm3(cross(up, c));
  let v = cross(c, u);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  [u, v] = [
    [u[0] * cr + v[0] * sr, u[1] * cr + v[1] * sr, u[2] * cr + v[2] * sr],
    [v[0] * cr - u[0] * sr, v[1] * cr - u[1] * sr, v[2] * cr - u[2] * sr],
  ];
  return [c, u, v];
}

/* Where the flat face mirrors the camera, so the key can be placed so its soft edge crosses the face */
const FACE_N = [M[2], M[5], M[8]];
const FACE_R = [2 * FACE_N[2] * FACE_N[0], 2 * FACE_N[2] * FACE_N[1], 2 * FACE_N[2] * FACE_N[2] - 1];
const [, FACE_U, FACE_V] = frame(FACE_R);
const offset = (a, b) => norm3([0, 1, 2].map((i) => FACE_R[i] + a * FACE_U[i] + b * FACE_V[i]));

const LIGHTS = [
  { power: 2.6, ...softbox(...frame(offset(0.1, 0.56)), 0.7, 0.3, 0.26) },
  { power: 3.0, ...softbox(...frame([1, 0.12, -0.3]), 0.08, 0.7, 0.06) },
  { power: 0.95, ...softbox(...frame(offset(-0.1, -0.6)), 0.7, 0.25, 0.3) },
];

function env(dx, dy, dz) {
  let radiance = 0.05 + 0.07 * smoothstep(-0.6, 1, dy);
  for (const l of LIGHTS) {
    const along = dx * l.c[0] + dy * l.c[1] + dz * l.c[2];
    if (along <= 0.05) continue;
    const pu = (dx * l.u[0] + dy * l.u[1] + dz * l.u[2]) / along;
    const pv = (dx * l.v[0] + dy * l.v[1] + dz * l.v[2]) / along;
    const inside = (1 - smoothstep(l.hu - l.soft, l.hu + l.soft, Math.abs(pu))) * (1 - smoothstep(l.hv - l.soft, l.hv + l.soft, Math.abs(pv)));
    if (inside > 0) radiance += l.power * inside * (1 - 0.35 * Math.min(1, (pu / l.hu) ** 2));
  }
  return radiance;
}

/* A fixed lobe of directions, rotated per sample so the blur has no pattern */

const LOBE = 16;
const LOBE_DIRS = [];
for (let i = 0; i < LOBE; i++) {
  const y = 1 - (2 * (i + 0.5)) / LOBE;
  const rad = Math.sqrt(1 - y * y);
  const phi = i * 2.399963229728653;
  LOBE_DIRS.push([Math.cos(phi) * rad, y, Math.sin(phi) * rad]);
}

let seed = 0x2f6b;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

/* Tone mapping */

function aces(x) {
  return Math.min(Math.max((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0), 1);
}
/* Tone maps luminance and scales the channels with it, so gold stays gold instead of bleaching to lemon */
function tonemap(c) {
  const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (luma <= 0) return [0, 0, 0];
  const k = aces(luma) / luma;
  return [Math.min(c[0] * k, 1), Math.min(c[1] * k, 1), Math.min(c[2] * k, 1)];
}
function encode(linear) {
  const v = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.round(Math.min(Math.max(v, 0), 1) * 255);
}
function decode(byte) {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
const GROUND_LINEAR = decode(GROUND);

/* One ray, returns null on a miss or the linear colour of the hit */

function trace(wx, wy, wz, ox, oy, oz) {
  const lx = M[0] * wx + M[3] * wy + M[6] * wz;
  const ly = M[1] * wx + M[4] * wy + M[7] * wz;
  const lz = M[2] * wx + M[5] * wy + M[8] * wz;
  const px0 = M[0] * ox + M[3] * oy + M[6] * oz;
  const py0 = M[1] * ox + M[4] * oy + M[7] * oz;
  const pz0 = M[2] * ox + M[5] * oy + M[8] * oz;

  let t0 = 0;
  let t1 = 100;
  if (Math.abs(lz) < 1e-9) {
    if (Math.abs(pz0) > BOUND_Z) return null;
  } else {
    const a = (-BOUND_Z - pz0) / lz;
    const b = (BOUND_Z - pz0) / lz;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  const qa = lx * lx + ly * ly;
  const qb = 2 * (px0 * lx + py0 * ly);
  const qc = px0 * px0 + py0 * py0 - BOUND_R * BOUND_R;
  if (qa > 1e-12) {
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    t0 = Math.max(t0, (-qb - s) / (2 * qa));
    t1 = Math.min(t1, (-qb + s) / (2 * qa));
  } else if (qc > 0) {
    return null;
  }
  if (t0 >= t1) return null;

  let t = t0;
  let hit = false;
  for (let i = 0; i < 220 && t < t1; i++) {
    const d = sdCoin(px0 + lx * t, py0 + ly * t, pz0 + lz * t);
    if (d < 2e-5 * (1 + t)) {
      hit = true;
      break;
    }
    t += d * 0.82;
  }
  if (!hit) return null;

  const hx = px0 + lx * t;
  const hy = py0 + ly * t;
  const hz = pz0 + lz * t;
  sdCoin(hx, hy, hz);
  const part = partHit;
  const e = 4e-4;
  let nx = sdCoin(hx + e, hy, hz) - sdCoin(hx - e, hy, hz);
  let ny = sdCoin(hx, hy + e, hz) - sdCoin(hx, hy - e, hz);
  let nz = sdCoin(hx, hy, hz + e) - sdCoin(hx, hy, hz - e);
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;

  let occ = 0;
  for (let k = 1; k <= 5; k++) {
    const h = 0.012 * k;
    occ += (h - sdCoin(hx + nx * h, hy + ny * h, hz + nz * h)) / 2 ** k;
  }
  const ao = Math.min(Math.max(1 - 9 * occ, 0.25), 1);

  const Nx = M[0] * nx + M[1] * ny + M[2] * nz;
  const Ny = M[3] * nx + M[4] * ny + M[5] * nz;
  const Nz = M[6] * nx + M[7] * ny + M[8] * nz;
  const dn = wx * Nx + wy * Ny + wz * Nz;
  const rx = wx - 2 * dn * Nx;
  const ry = wy - 2 * dn * Ny;
  const rz = wz - 2 * dn * Nz;
  const rough = ROUGH[part];

  const spin = random() * Math.PI * 2;
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  let sum = 0;
  let weight = 0;
  for (const [ax, ay, az] of LOBE_DIRS) {
    const bx = ax * cs - az * sn;
    const bz = ax * sn + az * cs;
    let sx = rx + bx * rough;
    let sy = ry + ay * rough;
    let sz = rz + bz * rough;
    const sl = Math.hypot(sx, sy, sz);
    sx /= sl;
    sy /= sl;
    sz /= sl;
    const facing = sx * Nx + sy * Ny + sz * Nz;
    if (facing <= 0) continue;
    const w = Math.max(0, sx * rx + sy * ry + sz * rz) ** 4;
    sum += env(sx, sy, sz) * w;
    weight += w;
  }
  const radiance = weight > 0 ? sum / weight : env(rx, ry, rz);
  const cosv = Math.min(Math.max(-dn, 0), 1);
  const schlick = (1 - cosv) ** 5;
  return [0, 1, 2].map((c) => (F0[c] + (1 - F0[c]) * schlick) * radiance * ao * EXPOSURE);
}

/* PNG */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1);
    rows[at] = 1;
    for (let i = 0; i < width * 3; i++) {
      const left = i >= 3 ? rgb[y * width * 3 + i - 3] : 0;
      rows[at + 1 + i] = (rgb[y * width * 3 + i] - left) & 0xff;
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* Render */

const pixels = new Uint8Array(W * H * 3).fill(GROUND);
const started = Date.now();
let lastReport = started;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const u = ((2 * (x + (sx + 0.5) / SS)) / W - 1) * ASPECT * TAN_HALF;
        const v = (1 - (2 * (y + (sy + 0.5) / SS)) / H) * TAN_HALF;
        const len = Math.hypot(u, v, 1);
        const colour = trace(u / len, v / len, -1 / len, -SHIFT_X, -SHIFT_Y, CAM_Z);
        if (colour === null) {
          r += GROUND_LINEAR;
          g += GROUND_LINEAR;
          b += GROUND_LINEAR;
        } else {
          const mapped = tonemap(colour);
          r += mapped[0];
          g += mapped[1];
          b += mapped[2];
          hits++;
        }
      }
    }
    if (hits === 0) continue;
    const n = SS * SS;
    const at = (y * W + x) * 3;
    pixels[at] = encode(r / n);
    pixels[at + 1] = encode(g / n);
    pixels[at + 2] = encode(b / n);
  }
  if (Date.now() - lastReport > 5000) {
    lastReport = Date.now();
    process.stdout.write(`  ${Math.round(((y + 1) / H) * 100)}%\n`);
  }
}

writeFileSync(OUT, png(W, H, pixels));
console.log(`wrote ${OUT} (${W}x${H}, ${SS * SS} samples a pixel) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
