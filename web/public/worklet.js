// The bangermix AudioWorklet: runs the Rust engine (engine.wasm) on the audio thread.
//
// Plain JavaScript on purpose: it is loaded with audioWorklet.addModule and must not
// need bundling. The main thread compiles the module and passes it in.
//
// Messages in: {type: "set", params: [[deck, param, value], ...]},
//              {type: "load", deck, left, right, rate, token},
//              {type: "unload", deck}, {type: "mode", mode},
//              {type: "phones", sab} (or sab: null) to feed a second output device.
// Messages out: {type: "loaded", deck, token}, and {type: "state", state} when no
// SharedArrayBuffer was given.

class BangermixProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { module, sab, mode } = options.processorOptions;
    this.wasm = new WebAssembly.Instance(module, {}).exports;
    this.wasm.bm_init(sampleRate);
    this.maxBlock = this.wasm.bm_max_block();
    this.stateLen = this.wasm.bm_state_len();
    this.stagingFrames = this.wasm.bm_staging_frames();
    this.shared = sab ? new Float64Array(sab) : null;
    this.mode = mode || "stereo";
    this.loads = [];
    this.blocks = 0;
    this.mem = null;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  // Views into wasm memory go stale when it grows (a track load allocates).
  views() {
    if (this.mem === this.wasm.memory.buffer) return;
    const buf = (this.mem = this.wasm.memory.buffer);
    this.out = new Float32Array(buf, this.wasm.bm_out_ptr(), this.maxBlock * 4);
    this.state = new Float64Array(buf, this.wasm.bm_state_ptr(), this.stateLen);
    this.staging = new Float32Array(buf, this.wasm.bm_staging_ptr(), this.stagingFrames * 2);
  }

  onMessage(m) {
    switch (m.type) {
      case "set":
        for (const [d, p, v] of m.params) this.wasm.bm_set(d, p, v);
        break;
      case "load":
        this.loads = this.loads.filter((l) => l.deck !== m.deck);
        this.wasm.bm_load_begin(m.deck, m.left.length, m.rate);
        this.loads.push({ ...m, offset: 0 });
        break;
      case "unload":
        this.loads = this.loads.filter((l) => l.deck !== m.deck);
        this.wasm.bm_unload(m.deck);
        break;
      case "mode":
        this.mode = m.mode;
        break;
      case "phones":
        this.phones = m.sab ? new PhonesRing(m.sab) : null;
        break;
    }
  }

  // Copies the next chunk of a loading track into the engine: a whole track at once
  // would stall the audio thread.
  pushLoad() {
    const load = this.loads[0];
    if (!load) return;
    this.views();
    const n = Math.min(this.stagingFrames, load.left.length - load.offset);
    this.staging.set(load.left.subarray(load.offset, load.offset + n), 0);
    this.staging.set(load.right.subarray(load.offset, load.offset + n), this.stagingFrames);
    this.wasm.bm_load_push(load.deck, n);
    load.offset += n;
    if (load.offset >= load.left.length) {
      this.loads.shift();
      this.port.postMessage({ type: "loaded", deck: load.deck, token: load.token });
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    this.pushLoad();
    this.wasm.bm_process(frames);
    this.views();
    const mb = this.maxBlock;
    const o = this.out;
    if (this.mode === "split") {
      // Master in mono on the left, headphones in mono on the right (splitter cable).
      for (let i = 0; i < frames; i++) {
        out[0][i] = 0.5 * (o[i] + o[mb + i]);
        if (out[1]) out[1][i] = 0.5 * (o[2 * mb + i] + o[3 * mb + i]);
      }
    } else {
      out[0].set(o.subarray(0, frames));
      if (out[1]) out[1].set(o.subarray(mb, mb + frames));
      if (this.mode === "quad" && out.length >= 4) {
        out[2].set(o.subarray(2 * mb, 2 * mb + frames));
        out[3].set(o.subarray(3 * mb, 3 * mb + frames));
      }
    }
    if (this.phones) {
      this.phones.write(o.subarray(2 * mb, 2 * mb + frames), o.subarray(3 * mb, 3 * mb + frames));
    }
    if (this.shared) {
      this.shared.set(this.state);
    } else if (++this.blocks % 4 === 0) {
      this.port.postMessage({ type: "state", state: this.state.slice() });
    }
    return true;
  }
}

registerProcessor("bangermix", BangermixProcessor);

// The headphones on a second output device: the engine writes their mix into a ring
// of shared memory, and this processor (in the second device's AudioContext) plays
// it. The two devices' clocks drift apart, so the reader runs a hair fast or slow to
// keep the ring about TARGET frames full.

const RING_FRAMES = 16384;
const TARGET = 1536;

class PhonesRing {
  constructor(sab) {
    this.head = new Int32Array(sab, 0, 2);
    this.data = new Float32Array(sab, 8, RING_FRAMES * 2);
  }

  write(left, right) {
    let w = Atomics.load(this.head, 0);
    for (let i = 0; i < left.length; i++) {
      const k = (w % RING_FRAMES) * 2;
      this.data[k] = left[i];
      this.data[k + 1] = right[i];
      w = (w + 1) | 0;
    }
    Atomics.store(this.head, 0, w);
  }
}

class PhonesProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ring = new PhonesRing(options.processorOptions.sab);
    this.read = -1;
    this.fill = TARGET;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const w = Atomics.load(this.ring.head, 0);
    if (this.read < 0 || w - this.read > RING_FRAMES - 512 || w - this.read < 2) {
      // Starting, or too far behind or ahead: start again TARGET frames back.
      this.read = w - TARGET;
      if (this.read < 0) {
        out.forEach((c) => c.fill(0));
        this.read = -1;
        return true;
      }
    }
    this.fill += (w - this.read - this.fill) * 0.01;
    const rate = 1 + Math.max(-0.003, Math.min(0.003, ((this.fill - TARGET) / TARGET) * 0.01));
    const d = this.ring.data;
    for (let i = 0; i < n; i++) {
      const p = Math.floor(this.read);
      const t = this.read - p;
      const a = (p % RING_FRAMES) * 2;
      const b = ((p + 1) % RING_FRAMES) * 2;
      out[0][i] = d[a] + (d[b] - d[a]) * t;
      if (out[1]) out[1][i] = d[a + 1] + (d[b + 1] - d[a + 1]) * t;
      this.read += rate;
    }
    Atomics.store(this.ring.head, 1, this.read | 0);
    return true;
  }
}

registerProcessor("bangermix-phones", PhonesProcessor);
