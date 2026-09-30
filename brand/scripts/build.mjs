// Builds every Kleos brand asset (SVG + PNG) from code, so the kit stays consistent.
//   npm install && npm run build
import { mkdirSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

export const COLORS = {
  coral: "#FF5A36", // signature accent: the laurel, YES, reputation
  ground: "#0D0C0B", // background
  card: "#161413", // surfaces
  ink: "#F3EFE9", // text on dark
  muted: "#9A948C", // secondary text
  lavender: "#9D97F5", // NO and the money-only price
  dotOff: "#3B2D27", // unlit laurel dots
};

// The laurel: 7 dot pairs per side, bottom to top. The right side mirrors x → 64 − x.
const STEM = [[28, 57], [21, 53], [16, 47], [13, 40], [12, 32], [13, 24], [16, 17]];
const LEAF = [[21, 59], [13, 55], [8, 49], [5, 41], [5, 32], [6, 23], [10, 15]];

function laurel(x0, y0, scale, color, lit = 7, off = COLORS.dotOff) {
  return STEM.flatMap(([x, y], i) => {
    const [lx, ly] = LEAF[i];
    const fill = i < lit ? color : off;
    return [[x, y, 2.4], [lx, ly, 3], [64 - x, y, 2.4], [64 - lx, ly, 3]].map(([cx, cy, r]) =>
      `<circle cx="${(x0 + cx * scale).toFixed(2)}" cy="${(y0 + cy * scale).toFixed(2)}" r="${(r * scale).toFixed(2)}" fill="${fill}"/>`,
    );
  }).join("");
}

// 5×7 dot-matrix letters, matching the Doto wordmark. Drawn as dots, so no font is needed.
const GLYPHS = {
  K: ["X...X", "X..X.", "X.X..", "XX...", "X.X..", "X..X.", "X...X"],
  L: ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  E: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  O: [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  S: [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
};

function dots(rows, x0, y0, pitch, color, ratio = 0.42) {
  let out = "";
  rows.forEach((row, r) =>
    [...row].forEach((c, col) => {
      if (c === "X") out += `<circle cx="${(x0 + col * pitch).toFixed(2)}" cy="${(y0 + r * pitch).toFixed(2)}" r="${(pitch * ratio).toFixed(2)}" fill="${color}"/>`;
    }),
  );
  return out;
}

function wordmark(x0, y0, pitch, color) {
  let out = "";
  let x = x0;
  for (const ch of "KLEOS") {
    out += dots(GLYPHS[ch], x, y0, pitch, color);
    x += pitch * 7; // 5 columns + 2 columns of tracking
  }
  return { svg: out, width: x - x0 - pitch * 3 };
}

const files = [];
function emit(path, svg, pngWidth) {
  files.push([path, svg, pngWidth]);
}

// ─── Logos ────────────────────────────────────────────────────────────────────
// Variants: primary (coral laurel + ink wordmark, for dark backgrounds), coral, black, white.
const VARIANTS = {
  primary: { laurel: COLORS.coral, text: COLORS.ink, bg: COLORS.ground },
  coral: { laurel: COLORS.coral, text: COLORS.coral, bg: COLORS.ground },
  black: { laurel: COLORS.ground, text: COLORS.ground, bg: "#FFFFFF" },
  white: { laurel: COLORS.ink, text: COLORS.ink, bg: COLORS.coral },
};

for (const [name, v] of Object.entries(VARIANTS)) {
  // Full logo: laurel + KLEOS
  const pitch = 7;
  const h = 96;
  const pad = 16;
  const word = wordmark(pad + 64 + 28, (h - pitch * 6) / 2, pitch, v.text);
  const w = Math.ceil(pad + 64 + 28 + word.width + pitch + pad);
  const full = (bg) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 4}" height="${h * 4}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ""}${laurel(pad, 11, 1, v.laurel)}${word.svg}</svg>`;
  emit(`logos/full-logo/full-logo-${name}.svg`, full(null), 2048);
  emit(`logos/full-logo/full-logo-${name}-bg.svg`, full(v.bg), 2048);

  // Compact logo: the laurel
  const compact = (bg) =>
    bg
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512"><rect width="100" height="100" rx="22" fill="${bg}"/>${laurel(18, 13, 1, v.laurel)}</svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -1 72 72" width="512" height="512">${laurel(0, -2, 1, v.laurel)}</svg>`;
  emit(`logos/compact-logo/compact-logo-${name}.svg`, compact(null), 1024);
  emit(`logos/compact-logo/compact-logo-${name}-bg.svg`, compact(v.bg), 1024);
}

// ─── Tier laurels: dots light up bottom to top as reputation grows ────────────
const LIT_BY_TIER = [1, 2, 3, 5, 6, 7]; // no tier, I, II, III, IV, V
LIT_BY_TIER.forEach((lit, tier) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512"><rect width="100" height="100" rx="22" fill="${COLORS.ground}"/>${laurel(18, 13, 1, COLORS.coral, lit)}</svg>`;
  emit(`tiers/tier-${tier === 0 ? "none" : ["", "I", "II", "III", "IV", "V"][tier]}.svg`, svg, 512);
});

// ─── Iconography: 7×7 dot-matrix icons ───────────────────────────────────────
const ICONS = {
  upvote: [".......", "...X...", "..XXX..", ".XXXXX.", "XXXXXXX", ".......", "......."],
  downvote: [".......", ".......", "XXXXXXX", ".XXXXX.", "..XXX..", "...X...", "......."],
  check: [".......", "......X", ".....X.", "X...X..", ".X.X...", "..X....", "......."],
  cross: ["X.....X", ".X...X.", "..X.X..", "...X...", "..X.X..", ".X...X.", "X.....X"],
  call: ["XXXXXXX", "X.....X", "X.X.X.X", "X.....X", "XXXXXXX", "..X....", ".X....."],
  court: ["XXXXXXX", ".......", "X.X.X.X", "X.X.X.X", "X.X.X.X", ".......", "XXXXXXX"],
  passkey: [".XXX...", "X...X..", "X...XXX", "X...X.X", ".XXX..X", ".......", "......."],
  chart: ["......X", ".....X.", "X...X..", ".X.X...", "..X....", ".......", "XXXXXXX"],
  clock: [".XXXXX.", "X..X..X", "X..X..X", "X..XX.X", "X.....X", "X.....X", ".XXXXX."],
  eye: [".......", ".XXXXX.", "X..X..X", "X.XXX.X", "X..X..X", ".XXXXX.", "......."],
  bolt: ["....XX.", "...XX..", "..XX...", ".XXXXX.", "...XX..", "..XX...", ".XX...."],
  user: ["..XXX..", "..XXX..", "..XXX..", ".......", ".XXXXX.", "XXXXXXX", "XXXXXXX"],
};
for (const [name, rows] of Object.entries(ICONS)) {
  emit(`iconography/${name}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="112" height="112">${dots(rows, 2, 2, 4, COLORS.coral, 0.45)}</svg>`, 256);
}

// ─── Palette swatches (for the README, so it doesn't depend on a placeholder service) ─
for (const [name, hex] of Object.entries(COLORS)) {
  emit(`palette/${name}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><rect width="40" height="40" rx="8" fill="${hex}" stroke="#3A3531"/></svg>`, 80);
}

// ─── Write ────────────────────────────────────────────────────────────────────
for (const [path, svg, pngWidth] of files) {
  mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(path, svg);
  if (!path.startsWith("palette/")) {
    writeFileSync(path.replace(/\.svg$/, ".png"), new Resvg(svg, { fitTo: { mode: "width", value: pngWidth } }).render().asPng());
  }
}
console.log(`Built ${files.length} assets.`);
