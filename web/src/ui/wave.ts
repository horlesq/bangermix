// Drawing waveforms. A track's waveform is painted once into tiles (one pixel per
// column of data), then every frame only copies and stretches the visible part.
//
// Two styles: "rgb" colours each slice by its spectrum (lows red, mids green, highs
// blue; kicks show warm, hats cool), "3band" layers the three bands.

export type WaveStyle = "rgb" | "3band";

const BANDS_3: [number, number, number][] = [
  [32, 110, 255], // low
  [255, 160, 30], // mid
  [245, 245, 245], // high
];

const TILE = 1024;

function percentile(data: Uint8Array, pick: (c: number) => number, p: number): number {
  const n = data.length / 4;
  const values: number[] = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let c = 0; c < n; c += step) values.push(pick(c));
  values.sort((a, b) => a - b);
  return Math.max(8, values[Math.floor(values.length * p)] ?? 255);
}

function shape(v: number, norm: number): number {
  return Math.min(1, Math.pow(v / norm, 0.8));
}

/** Paints column data into an ImageData-like pixel array. */
class Painter {
  private normPeak: number;
  private normBand: number;
  constructor(
    private data: Uint8Array,
    private style: WaveStyle,
  ) {
    this.normPeak = percentile(data, (c) => data[c * 4], 0.985);
    this.normBand = percentile(data, (c) => Math.max(data[c * 4 + 1], data[c * 4 + 2], data[c * 4 + 3]), 0.985);
  }

  /** Paints column `c`'s levels (or a max over a range) at pixel column x. */
  paint(px: Uint8ClampedArray, w: number, h: number, x: number, peak: number, l: number, m: number, hi: number) {
    const mid = h / 2;
    const put = (y0: number, y1: number, r: number, g: number, b: number) => {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
        const o = (y * w + x) * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
    };
    if (this.style === "rgb") {
      const half = shape(peak, this.normPeak) * (mid - 1);
      const top = Math.max(l, m, hi, 1);
      // Hue from the band balance, brightness lifted so quiet bands still show.
      const r = 40 + (215 * l) / top;
      const g = 40 + (215 * m) / top;
      const b = 40 + (215 * hi) / top;
      put(mid - half, mid + half, r * 0.62, g * 0.62, b * 0.62);
      const core = half * 0.55;
      put(mid - core, mid + core, r, g, b);
    } else {
      const bands = [l, m, hi];
      for (let k = 0; k < 3; k++) {
        const half = shape(bands[k], this.normBand) * (mid - 1);
        const [r, g, b] = BANDS_3[k];
        put(mid - half, mid + half, r, g, b);
      }
    }
  }
}

export class WaveTiles {
  readonly columns: number;
  readonly columnsPerS: number;
  readonly height: number;
  private tiles: (HTMLCanvasElement | null)[];
  private data: Uint8Array;
  private painter: Painter;

  constructor(data: Uint8Array, columnsPerS: number, height: number, style: WaveStyle = "rgb") {
    this.data = data;
    this.columns = data.length / 4;
    this.columnsPerS = columnsPerS;
    this.height = Math.max(8, Math.round(height));
    this.painter = new Painter(data, style);
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
    for (let x = 0; x < w; x++) {
      const c = (i * TILE + x) * 4;
      const d = this.data;
      this.painter.paint(img.data, w, this.height, x, d[c], d[c + 1], d[c + 2], d[c + 3]);
    }
    ctx.putImageData(img, 0, 0);
    this.tiles[i] = t;
    return t;
  }

  /** Draws track time [t0, t1) stretched over [x, x + w) of `ctx`, `h` high at `y`. */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t0: number, t1: number) {
    const pxPerCol = w / ((t1 - t0) * this.columnsPerS);
    let c = Math.max(0, Math.floor(t0 * this.columnsPerS));
    const end = Math.min(Math.ceil(t1 * this.columnsPerS), this.columns);
    ctx.imageSmoothingEnabled = pxPerCol < 1;
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
    const d = this.data;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * this.columns);
      const b = Math.max(a + 1, Math.floor(((x + 1) / w) * this.columns));
      let peak = 0;
      let l = 0;
      let m = 0;
      let hi = 0;
      for (let c = a; c < b && c < this.columns; c++) {
        peak = Math.max(peak, d[c * 4]);
        l = Math.max(l, d[c * 4 + 1]);
        m = Math.max(m, d[c * 4 + 2]);
        hi = Math.max(hi, d[c * 4 + 3]);
      }
      this.painter.paint(img.data, w, h, x, peak, l, m, hi);
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

export function formatTime(s: number, tenths = true): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return tenths
    ? `${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`
    : `${String(m).padStart(2, "0")}:${String(Math.floor(sec)).padStart(2, "0")}`;
}
