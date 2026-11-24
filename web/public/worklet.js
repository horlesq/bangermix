// The bangermix AudioWorklet: runs the Rust engine (engine.wasm) on the audio thread.
//
// Plain JavaScript on purpose: it is loaded with audioWorklet.addModule and must not
// need bundling. The main thread compiles the module and passes it in.
//
// Messages in: {type: "set", params: [[deck, param, value], ...]},
//              {type: "load", deck, left, right, rate, token},
//              {type: "unload", deck}, {type: "mode", mode}.
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
    if (this.shared) {
      this.shared.set(this.state);
    } else if (++this.blocks % 4 === 0) {
      this.port.postMessage({ type: "state", state: this.state.slice() });
    }
    return true;
  }
}

registerProcessor("bangermix", BangermixProcessor);
