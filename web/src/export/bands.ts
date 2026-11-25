// bangermix's waveform (4 bytes per column: peak, low, mid, high) summarised over
// stretches of time, for exporters. The same as crates/bm-export/src/waveform.rs.

export interface Bands {
  peak: number;
  low: number;
  mid: number;
  high: number;
}

export class Columns {
  private readonly count: number;
  constructor(
    private readonly data: Uint8Array,
    private readonly perS: number,
  ) {
    this.count = Math.floor(data.length / 4);
  }

  /** The loudest peak and the RMS of each band between `t0` and `t1` seconds (0 to 1). */
  span(t0: number, t1: number): Bands {
    const n = this.count;
    if (n === 0) return { peak: 0, low: 0, mid: 0, high: 0 };
    const a = Math.min(n - 1, Math.max(0, Math.floor(t0 * this.perS)));
    const b = Math.min(n, Math.max(a + 1, Math.ceil(t1 * this.perS)));
    let peak = 0;
    const sums = [0, 0, 0];
    for (let i = a; i < b; i++) {
      peak = Math.max(peak, this.data[i * 4]);
      for (let k = 0; k < 3; k++) {
        const v = this.data[i * 4 + 1 + k] / 255;
        sums[k] += v * v;
      }
    }
    const c = b - a;
    return { peak: peak / 255, low: Math.sqrt(sums[0] / c), mid: Math.sqrt(sums[1] / c), high: Math.sqrt(sums[2] / c) };
  }
}

/** `count` equal stretches over `duration` seconds. */
export function evenly(columns: Columns, duration: number, count: number): Bands[] {
  const step = Math.max(0, duration) / count;
  return Array.from({ length: count }, (_, i) => columns.span(i * step, (i + 1) * step));
}
