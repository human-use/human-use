// QR code, byte mode, error correction level M, versions 1 to 10 (up to 213 bytes). Enough for a pairing link.
// Follows ISO/IEC 18004; the structure mirrors Project Nayuki's reference encoder.

const BLOCKS = [null, [10, [16]], [16, [28]], [26, [44]], [18, [32, 32]], [24, [43, 43]], [16, [27, 27, 27, 27]],
  [18, [31, 31, 31, 31]], [22, [38, 38, 39, 39]], [22, [36, 36, 36, 37, 37]], [26, [43, 43, 43, 43, 44]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function mul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = mul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = mul(root, 2);
  }
  return result;
}

function remainder(data, div) {
  const result = div.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    div.forEach((coef, i) => { result[i] ^= mul(coef, factor); });
  }
  return result;
}

/** The codewords for `bytes`, error correction added and blocks interleaved. */
function codewords(bytes, version) {
  const [ecLength, lengths] = BLOCKS[version];
  const capacity = lengths.reduce((sum, n) => sum + n, 0);
  const bits = [];
  const put = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(4, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach(byte => put(byte, 8));
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => byte << 1 | bit, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  const div = divisor(ecLength);
  const blocks = [];
  let offset = 0;
  for (const length of lengths) {
    const block = data.slice(offset, offset += length);
    blocks.push([block, remainder(block, div)]);
  }
  const out = [];
  for (let i = 0; i < Math.max(...lengths); i++) for (const [block] of blocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < ecLength; i++) for (const [, ec] of blocks) out.push(ec[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
];

function penalty(grid) {
  const size = grid.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(grid[i]);
    lines.push(grid.map(row => row[i]));
  }
  const finder = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  for (const line of lines) {
    for (let i = 0, run = 1; i < size; i++, run++) {
      if (i === size - 1 || line[i] !== line[i + 1]) {
        if (run >= 5) score += run - 2;
        run = 0;
      }
    }
    for (let i = 0; i + 11 <= size; i++) {
      if (finder.every((bit, j) => line[i + j] === !!bit) || finder.every((bit, j) => line[i + 10 - j] === !!bit)) score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && grid[y][x] === grid[y][x + 1] && grid[y][x] === grid[y + 1][x] && grid[y][x] === grid[y + 1][x + 1]) score += 3;
    }
  }
  return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
}

/** The module grid for `text`: rows of booleans, true for dark. */
export function qr(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > BLOCKS[version][1].reduce((sum, n) => sum + n, 0) * 8) version++;
  if (version > 10) throw new Error("Text too long for a version 10 QR code");
  const size = 17 + version * 4;
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { grid[y][x] = dark; fixed[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, ring = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
    }
  }
  const align = ALIGN[version], last = align.length - 1;
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = mask => {
    const data = mask;   // level M is 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = (data << 10 | rem) ^ 0x5412;
    const bit = i => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = version << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  const data = codewords(bytes, version);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && index < data.length * 8) {
          grid[y][x] = ((data[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
          index++;
        }
      }
    }
  }

  const apply = mask => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) grid[y][x] = !grid[y][x];
  };
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask);
    format(mask);
    const score = penalty(grid);
    if (score < bestScore) { best = mask; bestScore = score; }
    apply(mask);
  }
  apply(best);
  format(best);
  return grid;
}

/** An SVG of `text` as a QR code with a four-module quiet zone, drawn in currentColor. */
export function qrSvg(text) {
  const grid = qr(text);
  const size = grid.length + 8;
  let path = "";
  grid.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><path fill="currentColor" d="${path}"/></svg>`;
}
