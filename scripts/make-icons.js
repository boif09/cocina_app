// Genera los iconos PNG de la PWA (una "C" blanca sobre naranja, como el logo de la app) sin dependencias.
// Uso: node scripts/make-icons.js   (los PNG resultantes se guardan en public/icons/)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.resolve(__dirname, '..', 'public', 'icons');

const BACKGROUND = [0xdd, 0x6b, 0x3d];
const FOREGROUND = [0xff, 0xff, 0xff];
const SUPERSAMPLE = 4;

// "C": anillo con una abertura a la derecha y extremos redondeados.
const RING_RADIUS = 0.25;
const RING_HALF_WIDTH = 0.075;
const GAP_HALF_ANGLE = (42 * Math.PI) / 180;

function insideLetter(u, v) {
  const distance = Math.hypot(u, v);
  const angle = Math.atan2(v, u); // 0 = derecha
  if (Math.abs(Math.abs(distance - RING_RADIUS) - 0) <= RING_HALF_WIDTH && Math.abs(angle) >= GAP_HALF_ANGLE) {
    return true;
  }
  // Extremos redondeados del trazo
  for (const sign of [-1, 1]) {
    const capX = RING_RADIUS * Math.cos(GAP_HALF_ANGLE);
    const capY = sign * RING_RADIUS * Math.sin(GAP_HALF_ANGLE);
    if (Math.hypot(u - capX, v - capY) <= RING_HALF_WIDTH) return true;
  }
  return false;
}

// Forma del icono en coordenadas 0..1. `scale` encoge el símbolo (zona segura de los iconos "maskable").
function shapeAt(x, y, { rounded, scale }) {
  if (rounded) {
    const r = 0.22;
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r ** 2) return null; // fuera de la esquina redondeada
  }
  const u = (x - 0.5) / scale;
  const v = (y - 0.5) / scale;
  return insideLetter(u, v) ? FOREGROUND : BACKGROUND;
}

function render(size, options) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const color = shapeAt((px + (sx + 0.5) / SUPERSAMPLE) / size, (py + (sy + 0.5) / SUPERSAMPLE) / size, options);
          if (!color) continue;
          r += color[0]; g += color[1]; b += color[2]; a += 255;
        }
      }
      const samples = SUPERSAMPLE ** 2;
      const offset = (py * size + px) * 4;
      const coverage = a / 255;
      pixels[offset] = coverage ? Math.round(r / coverage) : 0;
      pixels[offset + 1] = coverage ? Math.round(g / coverage) : 0;
      pixels[offset + 2] = coverage ? Math.round(b / coverage) : 0;
      pixels[offset + 3] = Math.round(a / samples);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // sin filtro
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, scale: 1.1 },
  { file: 'icon-512.png', size: 512, rounded: true, scale: 1.1 },
  { file: 'maskable-512.png', size: 512, rounded: false, scale: 1 },
  { file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 1 }
];

fs.mkdirSync(outDir, { recursive: true });
for (const icon of ICONS) {
  fs.writeFileSync(path.join(outDir, icon.file), encodePng(icon.size, render(icon.size, icon)));
  console.log(`public/icons/${icon.file}`);
}
