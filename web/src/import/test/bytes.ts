// Byte builders for the import tests.

export const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const num = (size: number, set: (v: DataView) => void) => {
  const b = new Uint8Array(size);
  set(new DataView(b.buffer));
  return b;
};
export const u32 = (n: number, le = false) => num(4, (v) => v.setUint32(0, n, le));
export const i32 = (n: number, le = false) => num(4, (v) => v.setInt32(0, n, le));
export const f32 = (n: number) => num(4, (v) => v.setFloat32(0, n));
export const f64 = (n: number, le = false) => num(8, (v) => v.setFloat64(0, n, le));
export const i64 = (n: number, le = false) => num(8, (v) => v.setBigInt64(0, BigInt(n), le));

export const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
export const utf16be = (s: string) => num(s.length * 2, (v) => [...s].forEach((c, i) => v.setUint16(2 * i, c.charCodeAt(0))));
export const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
