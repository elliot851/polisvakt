// QR-kodgenerator. Byte-läge, felkorrigeringsnivå M, version 1-10.
//
// Skriven från grunden istället för att hämtas från ett CDN, av två skäl:
// appen ska fungera utan nät efter första laddningen, och en QR-kod som pekar
// på din egen sajt ska inte behöva skickas till någon annans server för att
// ritas.
//
// Version 10 rymmer 213 tecken i byte-läge, vilket räcker med god marginal
// för vilken adress som helst. Nivå M tål att ungefär 15 % av koden är
// skadad eller skymd — lagom när koden ska läsas av en telefon som hålls
// snett mot en skärm.

/* ---------------- Tabeller ---------------- */

// Antal datakodord och felkorrigeringsblock per version, nivå M
const VERSIONS = [
  null,
  { total: 26,  ecPerBlock: 10, blocks: [[1, 16]] },
  { total: 44,  ecPerBlock: 16, blocks: [[1, 28]] },
  { total: 70,  ecPerBlock: 26, blocks: [[1, 44]] },
  { total: 100, ecPerBlock: 18, blocks: [[2, 32]] },
  { total: 134, ecPerBlock: 24, blocks: [[2, 43]] },
  { total: 172, ecPerBlock: 16, blocks: [[4, 27]] },
  { total: 196, ecPerBlock: 18, blocks: [[4, 31]] },
  { total: 242, ecPerBlock: 22, blocks: [[2, 38], [2, 39]] },
  { total: 292, ecPerBlock: 22, blocks: [[3, 36], [2, 37]] },
  { total: 346, ecPerBlock: 26, blocks: [[4, 43], [1, 44]] },
];

const ALIGNMENT = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/* ---------------- Galoisfält GF(256) ---------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;      // primitivt polynom x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/** Generatorpolynom för n felkorrigeringskodord. */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomdivision i GF(256) — resten är felkorrigeringskodorden. */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

/* ---------------- Kodning ---------------- */

function utf8Bytes(str) {
  return Array.from(new TextEncoder().encode(str));
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const info = VERSIONS[v];
    const dataCodewords = info.blocks.reduce((s, [n, k]) => s + n * k, 0);
    const header = 4 + (v <= 9 ? 8 : 16);
    if (byteLen * 8 + header <= dataCodewords * 8) return v;
  }
  throw new Error('Texten är för lång för en QR-kod av version 10.');
}

function buildDataCodewords(bytes, version) {
  const info = VERSIONS[version];
  const dataCodewords = info.blocks.reduce((s, [n, k]) => s + n * k, 0);

  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  push(0b0100, 4);                                   // byte-läge
  push(bytes.length, version <= 9 ? 8 : 16);         // teckenräknare
  for (const b of bytes) push(b, 8);

  // Avslutare, högst fyra nollor
  const capacity = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  }
  // Utfyllnad med de två föreskrivna bytena, växelvis
  const PAD = [0xec, 0x11];
  let p = 0;
  while (out.length < dataCodewords) out.push(PAD[p++ % 2]);
  return out;
}

/** Dela i block, felkorrigera varje block, och fläta ihop igen. */
function interleave(dataCodewords, version) {
  const info = VERSIONS[version];
  const blocks = [];
  let pos = 0;
  for (const [count, k] of info.blocks) {
    for (let i = 0; i < count; i++) {
      const data = dataCodewords.slice(pos, pos + k);
      pos += k;
      blocks.push({ data, ec: rsEncode(data, info.ecPerBlock) });
    }
  }

  const out = [];
  const maxData = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < info.ecPerBlock; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

/* ---------------- Matris ---------------- */

function makeMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setF = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r][c] = v; reserved[r][c] = true;
  };

  // Sökmönster med separator
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setF(row + r, col + c, (inRing || inCore) ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Synkroniseringsmönster
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    setF(6, i, v);
    setF(i, 6, v);
  }

  // Justeringsmönster
  const centers = ALIGNMENT[version];
  for (const r of centers) {
    for (const c of centers) {
      // Hoppa över de tre hörnen där sökmönstren redan sitter
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          setF(r + dr, c + dc, (ring === 1) ? 0 : 1);
        }
      }
    }
  }

  // Mörk modul
  setF(size - 8, 8, 1);

  // Reservera formatinformationens rutor
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) { m[8][i] = 0; reserved[8][i] = true; }
    if (m[i][8] === null) { m[i][8] = 0; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) { m[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
    if (m[size - 1 - i][8] === null) { m[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
  }

  // Versionsinformation, från version 7
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = (bits >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      setF(size - 11 + c, r, b);
      setF(r, size - 11 + c, b);
    }
  }

  return { m, reserved, size };
}

function versionBits(version) {
  let d = version << 12;
  for (let i = 0; i < 6; i++) {
    if (d & (1 << (17 - i))) d ^= 0x1f25 << (5 - i);
  }
  return (version << 12) | d;
}

function formatBits(mask) {
  // Nivå M har indikator 00
  const data = (0b00 << 3) | mask;
  let d = data << 10;
  for (let i = 0; i < 5; i++) {
    if (d & (1 << (14 - i))) d ^= 0x537 << (4 - i);
  }
  return ((data << 10) | d) ^ 0x5412;
}

function placeFormat(m, size, mask) {
  const bits = formatBits(mask);
  // Formatinformationen placeras med den mest signifikanta biten först —
  // tvärtom mot versionsinformationen längre ner, som går från den minst
  // signifikanta. Blandar man ihop dem blir koden nästan rätt: strängen är
  // så när ett palindrom att bara fyra av femton bitar hamnar fel.
  const get = i => (bits >> (14 - i)) & 1;

  // Runt det övre vänstra sökmönstret
  for (let i = 0; i <= 5; i++) m[8][i] = get(i);
  m[8][7] = get(6);
  m[8][8] = get(7);
  m[7][8] = get(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = get(i);

  // Kopia längs de andra två sökmönstren. Den lodräta delen är bara sju
  // moduler — den åttonde rutan nedifrån är den mörka modulen, som alltid är
  // svart och inte hör till formatinformationen.
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = get(i);
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = get(i);
}

/** Placera databitarna i sicksack nedifrån höger, hoppa över kolumn 6. */
function placeData(m, reserved, size, codewords) {
  let bitIndex = 0;
  const nextBit = () => {
    const byte = codewords[bitIndex >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;                 // synkroniseringskolumnen
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        m[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, reserved, size, mask) {
  const fn = MASKS[mask];
  const out = m.map(row => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (fn(r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

/** Straffpoäng enligt standarden — lägst poäng vinner. */
function penalty(m, size) {
  let score = 0;

  // Regel 1: fem eller fler lika i rad
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map(row => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Regel 2: 2x2-block av samma färg
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Regel 3: mönster som liknar ett sökmönster
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, start, pat) => pat.every((v, k) => line[start + k] === v);
  for (let i = 0; i < size; i++) {
    const row = m[i], col = m.map(r => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (matches(row, j, P1) || matches(row, j, P2)) score += 40;
      if (matches(col, j, P1) || matches(col, j, P2)) score += 40;
    }
  }

  // Regel 4: obalans mellan svart och vitt
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ---------------- Publikt API ---------------- */

/**
 * @param {string} text
 * @returns {{ size:number, modules:number[][], version:number, mask:number }}
 */
export function encodeQR(text) {
  if (!text) throw new Error('Ingen text att koda.');
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length);

  const data = buildDataCodewords(bytes, version);
  const codewords = interleave(data, version);

  const { m, reserved, size } = makeMatrix(version);
  placeData(m, reserved, size, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(m, reserved, size, mask);
    placeFormat(masked, size, mask);
    const p = penalty(masked, size);
    if (!best || p < best.penalty) best = { penalty: p, modules: masked, mask };
  }

  return { size, modules: best.modules, version, mask: best.mask };
}

/**
 * Rita som SVG. Ren vektor, så den är skarp i alla storlekar och går att
 * skriva ut lika bra som att visa på en skärm.
 */
export function qrToSVG(text, { moduleSize = 8, margin = 4, dark = '#000', light = '#fff', title = '' } = {}) {
  const { size, modules } = encodeQR(text);
  const dim = (size + margin * 2) * moduleSize;

  // Slå ihop intilliggande moduler på samma rad till en rektangel — färre
  // element ger en mindre fil och snabbare rendering
  let path = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r][c]) { c++; continue; }
      let len = 1;
      while (c + len < size && modules[r][c + len]) len++;
      path += `M${(c + margin) * moduleSize} ${(r + margin) * moduleSize}h${len * moduleSize}v${moduleSize}h-${len * moduleSize}z`;
      c += len;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img"${title ? ` aria-label="${title}"` : ''}>` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`;
}

/** Rita in i ett canvas-element. */
export function qrToCanvas(canvas, text, { moduleSize = 8, margin = 4, dark = '#000', light = '#fff' } = {}) {
  const { size, modules } = encodeQR(text);
  const dim = (size + margin * 2) * moduleSize;
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = dark;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        ctx.fillRect((c + margin) * moduleSize, (r + margin) * moduleSize, moduleSize, moduleSize);
      }
    }
  }
  return canvas;
}
