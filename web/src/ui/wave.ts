// Drawing 3-band waveforms. A track's waveform is painted once into tiles (one pixel
// per column of data), then every frame only copies and stretches the visible part.

export const BAND_COLORS: [number, number, number][] = [
  [123, 92, 255], // low: violet
  [255, 79, 163], // mid: hot pink
  [196, 246, 255], // high: ice
];

const TILE = 1024;

/** Level scaling for a waveform: its loud parts reach the top. */
function normOf(data: Uint8Array): number {
  const n = data.length / 4;
  const levels: number[] = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let c = 0; c < n; c += step) {
    levels.push(Math.max(data[c * 4 + 1], data[c * 4 + 2], data[c * 4 + 3]));
  }
  levels.sort((a, b) => a - b);
  return Math.max(8, levels[Math.floor(levels.length * 0.98)] ?? 255);
}

function shape(v: number, norm: number): number {
  return Math.min(1, Math.pow(v / norm, 0.85));
}

export class WaveTiles {
  readonly columns: number;
  readonly columnsPerS: number;
  readonly height: number;
  private tiles: (HTMLCanvasElement | null)[];
  private data: Uint8Array;
  private norm: number;

  constructor(data: Uint8Array, columnsPerS: number, height: number) {
    this.data = data;
    this.columns = data.length / 4;
    this.columnsPerS = columnsPerS;
    this.height = Math.max(8, Math.round(height));
    this.norm = normOf(data);
    this.tiles = new Array(Math.ceil(this.columns / TILE)).fill(null);
  }

  private tile(i: number): HTMLCanvasElement {
    let t = this.tiles[i];
    if (t) return t;
    t = document.createElement("canvas");
    const w = Math.min(TILE, this.columns - i * TILE);
    t.width = w;
    t.height = this.height;
    const ctx = t.getContext("2d")!;
    const img = ctx.createImageData(w, this.height);
    const px = img.data;
    const h = this.height;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const c = (i * TILE + x) * 4;
      // Low first, then mid and high on top: each band shows where it is louder.
      for (let band = 0; band < 3; band++) {
        const half = Math.round(shape(this.data[c + 1 + band], this.norm) * (mid - 1));
        const [r, g, b] = BAND_COLORS[band];
        for (let y = Math.floor(mid - half); y < Math.ceil(mid + half); y++) {
          const o = (y * w + x) * 4;
          px[o] = r;
          px[o + 1] = g;
          px[o + 2] = b;
          px[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    this.tiles[i] = t;
    return t;
  }

  /** Draws track time [t0, t1) stretched over [x, x + w) of `ctx`, `h` high at `y`. */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t0: number, t1: number) {
    const pxPerCol = w / ((t1 - t0) * this.columnsPerS);
    let c0 = Math.floor(t0 * this.columnsPerS);
    const c1 = Math.ceil(t1 * this.columnsPerS);
    if (c0 < 0) c0 = 0;
    const end = Math.min(c1, this.columns);
    ctx.imageSmoothingEnabled = pxPerCol < 1;
    let c = c0;
    while (c < end) {
      const ti = Math.floor(c / TILE);
      const tileStart = ti * TILE;
      const n = Math.min(end, tileStart + TILE) - c;
      const tile = this.tile(ti);
      const dx = x + (c / this.columnsPerS - t0) * this.columnsPerS * pxPerCol;
      ctx.drawImage(tile, c - tileStart, 0, n, this.height, dx, y, n * pxPerCol + 0.5, h);
      c += n;
    }
  }

  /** Paints the whole track into `w` × `h` (for the overview). */
  overview(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const img = ctx.createImageData(w, h);
    const px = img.data;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * this.columns);
      const b = Math.max(a + 1, Math.floor(((x + 1) / w) * this.columns));
      const bands = [0, 0, 0];
      for (let c = a; c < b && c < this.columns; c++) {
        for (let k = 0; k < 3; k++) bands[k] = Math.max(bands[k], this.data[c * 4 + 1 + k]);
      }
      for (let k = 0; k < 3; k++) {
        const half = Math.round(shape(bands[k], this.norm) * (mid - 1));
        const [r, g, bl] = BAND_COLORS[k];
        for (let y = Math.floor(mid - half); y < Math.ceil(mid + half); y++) {
          const o = (y * w + x) * 4;
          px[o] = r;
          px[o + 1] = g;
          px[o + 2] = bl;
          px[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

/** Keeps a canvas's backing store matched to its size on screen. Returns the device
 * pixel ratio when the canvas was resized, 0 when unchanged. */
export function fitCanvas(c: HTMLCanvasElement): number {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
    return dpr;
  }
  return 0;
}

export function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
}
