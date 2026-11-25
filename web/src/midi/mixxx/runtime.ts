// Runs a Mixxx controller mapping: its scripts get the `engine`, `midi` and
// `controller` objects Mixxx gives them, and its XML controls and LEDs are applied
// the way Mixxx applies them (src/controllers/midi/midicontroller.cpp,
// src/controllers/scripting/legacy/controllerscriptinterfacelegacy.cpp). Scripts run
// in a hidden iframe, a separate JavaScript realm, so their many globals (Deck,
// Button, script, components…) never meet the app's own.

import { type Control, control, resetPlainValues } from "./controls";
import { type InputMapping, inputKey, type Mapping } from "./mapping";

export interface Transport {
  name: string;
  /** MIDI out (short messages and SysEx). */
  midi?: (bytes: number[]) => void;
  /** HID output report. */
  hidReport?: (reportId: number, data: Uint8Array) => void;
  hidFeature?: (reportId: number, data: Uint8Array) => void;
  /** Feature reports read before the scripts start (scripts read them synchronously). */
  featureReports?: Map<number, ArrayBuffer>;
  /** The last input report of each id, for controller.getInputReport. */
  inputReports?: Map<number, ArrayBuffer>;
  inputReportSize?: (reportId: number) => number;
  featureReportSize?: (reportId: number) => number;
}

type Callback = (value: number, group: string, key: string) => void;

interface Watch {
  group: string;
  key: string;
  c: Control;
  last: number;
  conns: Set<Connection>;
}

interface Connection {
  callback: Callback;
  watch: Watch;
  connected: boolean;
  /** What the script holds: { disconnect, trigger, isConnected }. */
  proxy: { disconnect(): boolean; [k: string]: unknown } | null;
}

const MAX_ERRORS = 20;

export class MixxxRuntime {
  readonly errors: string[] = [];
  onError?: (message: string) => void;

  private frame: HTMLIFrameElement | null = null;
  private w: any = null;
  private prefixes: string[] = [];
  private fnCache = new Map<string, (...a: unknown[]) => unknown>();
  private watches = new Map<string, Watch>();
  private outputs: { o: Mapping["outputs"][number]; c: Control; last: number }[] = [];
  private timers = new Map<number, { id: number; oneShot: boolean }>();
  private nextTimer = 1;
  private fourteen: { m: InputMapping; value: number }[] = [];
  private st = new Map<Control, { time: number; prev: number }>();
  private flushQueued = false;
  private stopped = false;
  private scratch = new Scratcher(this);

  constructor(
    readonly mapping: Mapping,
    readonly transport: Transport,
  ) {}

  // --- Lifecycle ------------------------------------------------------------------

  start() {
    resetPlainValues();
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.setAttribute("aria-hidden", "true");
    frame.title = `${this.mapping.name} mapping`;
    document.body.appendChild(frame);
    this.frame = frame;
    const w = frame.contentWindow as any;
    this.w = w;
    w.addEventListener("error", (e: ErrorEvent) => this.error(`${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
    w.engine = this.engineApi();
    w.midi = this.midiApi();
    w.controller = this.controllerApi();
    w.ColorMapper = ColorMapper;

    for (const s of this.mapping.scripts) {
      const el = w.document.createElement("script");
      // Mixxx's script engine lets a mapping's `class Deck` replace the common
      // script's `var Deck`; a browser refuses a class over a var. As plain global
      // properties the common script's names can be replaced the same way.
      const code = s.name === "common-controller-scripts.js" ? s.code.replace(/^var (\w+) = /gm, "globalThis.$1 = ") : s.code;
      el.textContent = `${code}\n//# sourceURL=mixxx/${s.name}`;
      w.document.head.appendChild(el);
      if (s.prefix) this.prefixes.push(s.prefix);
    }
    for (const p of this.prefixes) this.callOn(p, "init", [this.mapping.controllerId, false]);

    for (const o of this.mapping.outputs) {
      const c = control(o.group, o.key);
      if (c) this.outputs.push({ o, c, last: -1 });
    }
    this.flush();
  }

  stop() {
    if (this.stopped) return;
    for (const p of this.prefixes) this.callOn(p, "shutdown", []);
    this.stopped = true;
    for (const t of this.timers.values()) {
      clearTimeout(t.id);
      clearInterval(t.id);
    }
    this.timers.clear();
    this.scratch.stopAll();
    this.watches.clear();
    this.frame?.remove();
    this.frame = null;
  }

  // --- Input ----------------------------------------------------------------------

  /** A MIDI message from the controller. */
  midiIn(data: Uint8Array) {
    if (this.stopped || data.length === 0) return;
    const status = data[0];
    if (status === 0xf8) return;
    if (status === 0xf0) {
      const list = this.mapping.inputs.get(inputKey(0xf0, 0xff));
      if (list?.some((m) => m.options.has("script-binding"))) this.incoming(data);
      return;
    }
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;
    const list = this.mapping.inputs.get(inputKey(status, d1));
    if (!list) return;
    for (const m of list) {
      try {
        this.apply(m, status, d1, d2);
      } catch (e) {
        this.error(describe(e));
      }
    }
    this.queueFlush();
  }

  /** An HID input report: report id first (when the device numbers its reports). */
  hidIn(data: Uint8Array) {
    if (this.stopped) return;
    this.incoming(data);
    this.queueFlush();
  }

  private incoming(data: Uint8Array) {
    const arr = new this.w.Uint8Array(data.length);
    arr.set(data);
    for (const p of this.prefixes) this.callOn(p, "incomingData", [arr, data.length]);
  }

  private apply(m: InputMapping, status: number, d1: number, d2: number) {
    const op = status & 0xf0;
    if (m.options.has("script-binding")) {
      this.fn(m.key, 5)(status & 0x0f, d1, d2, status, m.group);
      return;
    }
    const c = control(m.group, m.key);
    if (!c) return;
    let value: number = d2;
    const msb = m.options.has("fourteen-bit-msb");
    const lsb = m.options.has("fourteen-bit-lsb");
    if (!msb && !lsb && this.fourteen.length) this.fourteen = [];
    if (msb || lsb) {
      const i = this.fourteen.findIndex((q) => q.m.group === m.group && q.m.key === m.key);
      if (i < 0) {
        this.fourteen.push({ m, value: d2 });
        return;
      }
      const q = this.fourteen.splice(i, 1)[0];
      if (q.m.options.has(msb ? "fourteen-bit-msb" : "fourteen-bit-lsb")) return;
      const joint = msb ? (d2 << 7) | q.value : (q.value << 7) | d2;
      value = Math.min(127, joint / 128);
    } else if (op === 0xe0) {
      value = Math.min(127, ((d2 << 7) | d1) / 128);
    } else {
      value = computeValue(m.options, c.valueToMidi(c.get()), d2);
    }
    let opcode = op;
    if (m.options.has("button") || m.options.has("switch")) opcode = 0x90;
    if (m.options.has("soft-takeover")) {
      if (!this.st.has(c)) this.st.set(c, { time: 0, prev: 0 });
      if (this.ignore(c, c.midiToParam(value))) return;
    }
    setFromMidi(c, opcode, value);
  }

  // --- Output and connections -----------------------------------------------------

  /** Delivers value changes to connected script callbacks and the XML's LEDs. Runs
   * every animation frame and right after each message. */
  flush() {
    if (this.stopped) return;
    for (const w of [...this.watches.values()]) {
      if (w.conns.size === 0) continue;
      const v = w.c.get();
      if (v === w.last) continue;
      w.last = v;
      for (const conn of [...w.conns]) this.call(conn.callback, [v, w.group, w.key]);
    }
    if (this.transport.midi) {
      for (const out of this.outputs) {
        const v = out.c.get();
        const byte = v >= out.o.min && v <= out.o.max ? out.o.on : out.o.off;
        if (byte === out.last || byte === 0xff) continue;
        out.last = byte;
        this.transport.midi([out.o.status, out.o.midino, byte]);
      }
    }
  }

  queueFlush() {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  // --- Calling into scripts -------------------------------------------------------

  private fn(code: string, n: number): (...a: unknown[]) => unknown {
    const id = `${n}|${code}`;
    let f = this.fnCache.get(id);
    if (!f) {
      const args = Array.from({ length: n }, (_, i) => `arg${i + 1}`);
      f = this.w.Function(...args, `(${code})(${args.join(",")});`) as (...a: unknown[]) => unknown;
      this.fnCache.set(id, f);
    }
    return f;
  }

  private callOn(prefix: string, method: string, args: unknown[]) {
    try {
      const obj = this.w.Function(`return typeof ${prefix} === "undefined" ? undefined : ${prefix};`)();
      const f = obj?.[method];
      if (typeof f === "function") f.apply(obj, args);
    } catch (e) {
      this.error(`${prefix}.${method}: ${describe(e)}`);
    }
  }

  call(f: (...a: any[]) => unknown, args: unknown[]) {
    try {
      f(...args);
    } catch (e) {
      this.error(describe(e));
    }
  }

  error(message: string) {
    if (this.errors.length >= MAX_ERRORS) return;
    this.errors.push(message);
    console.warn(`[${this.mapping.name}] ${message}`);
    this.onError?.(message);
  }

  // --- Soft takeover --------------------------------------------------------------

  /** Mixxx's soft takeover: ignore a knob that is far from the control's value until
   * it comes close or crosses it. */
  private ignore(c: Control, param: number): boolean {
    const s = this.st.get(c);
    if (!s) return false;
    const now = performance.now();
    let ignore = false;
    if (s.time === 0) {
      ignore = true;
      s.time = 1;
    } else if (now - s.time > 50) {
      const cur = c.toParam(c.get());
      const diff = cur - param;
      const prevDiff = cur - s.prev;
      if ((prevDiff < 0 && diff < 0) || (prevDiff > 0 && diff > 0)) {
        if (Math.abs(diff) > 3 / 128 && Math.abs(prevDiff) > 3 / 128) ignore = true;
      }
    }
    if (!ignore) s.time = now;
    s.prev = param;
    return ignore;
  }

  // --- The API scripts see --------------------------------------------------------

  private watch(group: string, key: string): Watch | null {
    const id = `${group} ${key}`;
    let w = this.watches.get(id);
    if (!w) {
      const c = control(group, key);
      if (!c) return null;
      w = { group, key, c, last: c.get(), conns: new Set() };
      this.watches.set(id, w);
    }
    return w;
  }

  private connect(group: string, key: string, callback: Callback): object | undefined {
    const w = this.watch(group, key);
    if (!w || typeof callback !== "function") {
      // As in Mixxx: no such control (or no callback) gives no connection.
      console.debug(`[${this.mapping.name}] no control to connect to:`, group, key);
      return undefined;
    }
    const conn: Connection = { callback, watch: w, connected: true, proxy: null };
    w.conns.add(conn);
    const rt = this;
    return (conn.proxy = {
      get isConnected() {
        return conn.connected;
      },
      group,
      key,
      disconnect() {
        conn.connected = false;
        w.conns.delete(conn);
        return true;
      },
      trigger() {
        if (conn.connected) rt.call(callback, [w.c.get(), group, key]);
      },
    });
  }

  private setWithTakeover(c: Control, value: number, param: number) {
    if (this.st.has(c) && this.ignore(c, param)) return;
    c.set(value);
    this.queueFlush();
  }

  private engineApi() {
    const rt = this;
    const settings = this.mapping.settings;
    return {
      getValue(group: string, key: string): number {
        return control(group, key)?.get() ?? 0;
      },
      // Scripts pass booleans too (`!engine.getValue(…)`); Mixxx takes them as 0/1.
      setValue(group: string, key: string, raw: unknown) {
        const c = control(group, key);
        const value = Number(raw);
        if (!c || !Number.isFinite(value)) return;
        rt.setWithTakeover(c, value, c.toParam(value));
      },
      getParameter(group: string, key: string): number {
        const c = control(group, key);
        return c ? c.toParam(c.get()) : 0;
      },
      setParameter(group: string, key: string, raw: unknown) {
        const c = control(group, key);
        const param = Number(raw);
        if (!c || !Number.isFinite(param)) return;
        rt.setWithTakeover(c, c.fromParam(param), param);
      },
      getParameterForValue(group: string, key: string, value: number): number {
        return control(group, key)?.toParam(value) ?? 0;
      },
      reset(group: string, key: string) {
        const c = control(group, key);
        if (c && c.kind === "value") c.set(c.fromParam(0.5));
      },
      getDefaultValue(group: string, key: string): number {
        const c = control(group, key);
        return c && c.kind === "value" ? c.fromParam(0.5) : 0;
      },
      getDefaultParameter(group: string, key: string): number {
        const c = control(group, key);
        return c && c.kind === "value" ? 0.5 : 0;
      },
      makeConnection(group: string, key: string, callback: Callback) {
        return rt.connect(group, key, callback);
      },
      makeUnbufferedConnection(group: string, key: string, callback: Callback) {
        return rt.connect(group, key, callback);
      },
      // The deprecated form, as Mixxx keeps it: a function always makes a new
      // connection; a function's name (a string) connects once and then returns that
      // connection; `disconnect` takes either, or a connection object.
      connectControl(group: string, key: string, callback: Callback | string | object, disconnect?: boolean) {
        if (typeof callback === "function" && !disconnect) return rt.connect(group, key, callback as Callback);
        const w = rt.watch(group, key);
        if (!w) return undefined;
        if (callback && typeof callback === "object") {
          if (!disconnect) return false;
          for (const conn of [...w.conns]) if (conn.proxy === callback) conn.proxy.disconnect();
          return true;
        }
        const f = typeof callback === "string" ? (rt.fn(callback, 3) as Callback) : (callback as Callback);
        if (disconnect) {
          for (const conn of [...w.conns]) if (conn.callback === f) conn.proxy?.disconnect();
          return true;
        }
        for (const conn of w.conns) if (conn.callback === f) return conn.proxy;
        return rt.connect(group, key, f) ?? false;
      },
      trigger(group: string, key: string) {
        const w = rt.watch(group, key);
        if (!w) return;
        const v = w.c.get();
        for (const conn of [...w.conns]) rt.call(conn.callback, [v, group, key]);
      },
      log(message: string) {
        console.log(`[${rt.mapping.name}] ${message}`);
      },
      getSetting(name: string) {
        return settings[name];
      },
      beginTimer(ms: number, callback: (() => void) | string, oneShot = false): number {
        const f = typeof callback === "string" ? rt.w.eval(`()=>${callback}`) : callback;
        if (typeof f !== "function") return 0;
        const n = rt.nextTimer++;
        const interval = Math.max(20, ms | 0);
        const run = () => {
          if (rt.stopped) return;
          if (oneShot) rt.timers.delete(n);
          rt.call(f, []);
          rt.queueFlush();
        };
        const id = oneShot ? window.setTimeout(run, interval) : window.setInterval(run, interval);
        rt.timers.set(n, { id, oneShot });
        return n;
      },
      stopTimer(n: number) {
        const t = rt.timers.get(n);
        if (!t) return;
        if (t.oneShot) clearTimeout(t.id);
        else clearInterval(t.id);
        rt.timers.delete(n);
      },
      scratchEnable(deck: number, intervalsPerRev: number, rpm: number, alpha?: number, beta?: number, ramp = true) {
        rt.scratch.enable(deck, intervalsPerRev, rpm, alpha, beta, ramp);
      },
      scratchTick(deck: number, interval: number) {
        rt.scratch.tick(deck, interval);
      },
      scratchDisable(deck: number, ramp = true) {
        rt.scratch.disable(deck, ramp);
      },
      isScratching(deck: number): boolean {
        return (control(`[Channel${deck}]`, "scratch2_enable")?.get() ?? 0) > 0;
      },
      softTakeover(group: string, key: string, enable: boolean) {
        const c = control(group, key);
        if (!c) return;
        if (enable) {
          if (!rt.st.has(c)) rt.st.set(c, { time: 0, prev: 0 });
        } else {
          rt.st.delete(c);
        }
      },
      softTakeoverIgnoreNextValue(group: string, key: string) {
        const c = control(group, key);
        const s = c && rt.st.get(c);
        if (s) s.time = 0;
      },
      brake(deck: number, activate: boolean, factor = 1, rate = 1) {
        rt.scratch.brake(deck, activate, factor, rate);
      },
      spinback(deck: number, activate: boolean, factor = 1.8, rate = -10) {
        rt.scratch.brake(deck, activate, -factor, rate);
      },
      softStart(deck: number, activate: boolean, factor = 1) {
        rt.scratch.softStart(deck, activate, factor);
      },
      isBrakeActive(deck: number) {
        return rt.scratch.state(deck).brake;
      },
      isSpinbackActive(deck: number) {
        return rt.scratch.state(deck).spinback;
      },
      isSoftStartActive(deck: number) {
        return rt.scratch.state(deck).softStart;
      },
    };
  }

  private midiApi() {
    const t = this.transport;
    return {
      sendShortMsg(status: number, d1: number, d2: number) {
        t.midi?.([status & 0xff, d1 & 0x7f, d2 & 0x7f]);
      },
      sendSysexMsg(data: ArrayLike<number>, length?: number) {
        const bytes = Array.from(data).slice(0, length ?? data.length);
        t.midi?.(bytes.map((b) => b & 0xff));
      },
      send(data: ArrayLike<number>) {
        t.midi?.(Array.from(data).map((b) => b & 0xff));
      },
    };
  }

  private controllerApi() {
    const t = this.transport;
    const rt = this;
    const last = new Map<number, string>();
    const bytes = (data: unknown, length?: number): Uint8Array => {
      const u =
        data instanceof ArrayBuffer || (data && (data as any).constructor?.name === "ArrayBuffer")
          ? new Uint8Array(data as ArrayBuffer)
          : ArrayBuffer.isView(data)
            ? new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength)
            : Uint8Array.from(data as ArrayLike<number>);
      return length !== undefined && length < u.length ? u.slice(0, length) : u.slice();
    };
    const empty = (id: number, size?: (id: number) => number) => new this.w.ArrayBuffer(size?.(id) ?? 64);
    return {
      /** Mixxx's older HID call: (data, length, reportId). */
      send(data: ArrayLike<number>, length: number, reportId = 0) {
        t.hidReport?.(reportId, bytes(data, length));
      },
      sendOutputReport(a: unknown, b: unknown, c?: unknown, d?: unknown) {
        // (reportId, data, resendUnchanged); one script still passes (data, null, id, resend).
        const [id, data, resend] = typeof a === "number" ? [a, b, !!c] : [c as number, a, !!d];
        const u = bytes(data);
        const key = u.join(",");
        if (!resend && last.get(id) === key) return;
        last.set(id, key);
        t.hidReport?.(id, u);
      },
      sendFeatureReport(id: number, data: unknown) {
        t.hidFeature?.(id, bytes(data));
      },
      getFeatureReport(id: number): ArrayBuffer {
        const r = t.featureReports?.get(id);
        if (!r) return empty(id, t.featureReportSize);
        const copy = new rt.w.ArrayBuffer(r.byteLength);
        new Uint8Array(copy).set(new Uint8Array(r));
        return copy;
      },
      getInputReport(id: number): ArrayBuffer {
        const r = t.inputReports?.get(id);
        if (!r) return empty(id, t.inputReportSize);
        const copy = new rt.w.ArrayBuffer(r.byteLength);
        new Uint8Array(copy).set(new Uint8Array(r));
        return copy;
      },
    };
  }
}

/** An error's message and where in the mapping's scripts it happened. */
function describe(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const at = String((e as Error)?.stack ?? "")
    .split("\n")
    .find((l) => l.includes("mixxx/"));
  const where = at?.match(/mixxx\/([^:)]+:\d+)/)?.[1];
  return where ? `${msg} (${where})` : msg;
}

// --- MIDI value rules (MidiController::computeValue, ControlBehavior::setValueFromMidi)

function computeValue(options: Set<string>, prev: number, value: number): number {
  if (options.has("invert")) return 127 - value;
  if (options.has("rot64") || options.has("rot64inv")) {
    let diff = value - 64;
    if (diff === -1 || diff === 1) diff /= 16;
    else diff += diff > 0 ? -1 : 1;
    const v = options.has("rot64") ? prev + diff : prev - diff;
    return Math.max(0, Math.min(127, v));
  }
  if (options.has("rot64fast")) return Math.max(0, Math.min(127, prev + (value - 64) * 1.5));
  let v = value;
  if (options.has("diff")) {
    if (v >= 64) v -= 128;
    v = prev + v;
  }
  if (options.has("selectknob")) {
    if (v >= 64) v -= 128;
  }
  if (options.has("button")) v = v !== 0 ? 1 : 0;
  if (options.has("switch")) v = 1;
  if (options.has("spread64")) v = v - 64;
  if (options.has("hercjog")) {
    if (v > 64) v -= 128;
    v += prev;
  }
  if (options.has("hercjogfast")) {
    if (v > 64) v -= 128;
    v = prev + v * 3;
  }
  return v;
}

function setFromMidi(c: Control, opcode: number, value: number) {
  if (c.kind === "toggle" || c.kind === "push") {
    const pressed = !(opcode === 0x80 || value === 0);
    if (c.kind === "push") c.set(pressed ? 1 : 0);
    else if (pressed) c.set((Math.round(c.get()) + 1) % (c.states ?? 2));
    return;
  }
  c.set(c.fromParam(c.midiToParam(value)));
}

// --- Scratching: Mixxx's alpha-beta filter, run every millisecond ---------------------

class AlphaBeta {
  x = 0;
  v = 0;
  alpha = 1 / 512;
  beta = 1 / 512 / 1024;
  init(v: number, alpha = 1 / 512, beta = 1 / 512 / 1024) {
    this.x = 0;
    this.v = v;
    this.alpha = alpha;
    this.beta = beta;
  }
  observation(dx: number) {
    const dt = 0.001;
    const px = this.x + this.v * dt;
    const r = dx - px;
    this.x = px + r * this.alpha;
    this.v = this.v + (r * this.beta) / dt;
    this.x -= dx;
  }
}

interface ScratchState {
  active: boolean;
  dx: number;
  acc: number;
  ramp: boolean;
  rampTo: number;
  rampFactor: number;
  brake: boolean;
  spinback: boolean;
  softStart: boolean;
  lastMovement: number;
  filter: AlphaBeta;
}

const BRAKE_RAMP_TO = 0.01;

class Scratcher {
  private decks: ScratchState[] = [0, 1, 2, 3, 4].map(() => ({
    active: false,
    dx: 0,
    acc: 0,
    ramp: false,
    rampTo: 0,
    rampFactor: 0.001,
    brake: false,
    spinback: false,
    softStart: false,
    lastMovement: 0,
    filter: new AlphaBeta(),
  }));
  private timer: number | undefined;
  private last = 0;

  constructor(private rt: MixxxRuntime) {}

  state(deck: number): ScratchState {
    return this.decks[deck] ?? this.decks[0];
  }

  private c(deck: number, key: string) {
    return control(`[Channel${deck}]`, key);
  }

  private playing(deck: number) {
    return (this.c(deck, "play")?.get() ?? 0) > 0;
  }

  private rate(deck: number) {
    return this.c(deck, "rate_ratio")?.get() ?? 1;
  }

  enable(deck: number, intervalsPerRev: number, rpm: number, alpha?: number, beta?: number, ramp = true) {
    const s = this.decks[deck];
    if (!s) return;
    const perSecond = (rpm * intervalsPerRev) / 60;
    if (!perSecond) return;
    s.dx = 1 / perSecond;
    s.acc = 0;
    s.ramp = false;
    s.rampFactor = 0.001;
    s.brake = false;
    let v = 0;
    if (ramp) {
      if ((this.c(deck, "scratch2_enable")?.get() ?? 0) === 1) v = this.c(deck, "scratch2")?.get() ?? 0;
      else if (this.playing(deck)) v = this.rate(deck);
    }
    if (alpha && beta) s.filter.init(v, alpha, beta);
    else s.filter.init(v);
    s.active = true;
    this.c(deck, "scratch2")?.set(v);
    this.c(deck, "scratch2_enable")?.set(1);
    this.run();
  }

  tick(deck: number, interval: number) {
    const s = this.decks[deck];
    if (!s) return;
    s.lastMovement = performance.now();
    s.acc += interval;
  }

  disable(deck: number, ramp = true) {
    const s = this.decks[deck];
    if (!s) return;
    s.rampTo = 0;
    if (!ramp) this.c(deck, "scratch2_enable")?.set(0);
    else if (this.playing(deck)) s.rampTo = this.rate(deck);
    s.lastMovement = performance.now();
    s.ramp = true;
  }

  brake(deck: number, activate: boolean, factor: number, rate: number) {
    const s = this.decks[deck];
    if (!s) return;
    this.c(deck, "scratch2_enable")?.set(activate ? 1 : 0);
    if (!activate) {
      s.brake = s.spinback = false;
      s.active = false;
      return;
    }
    let init: number;
    if (rate < -BRAKE_RAMP_TO) {
      s.spinback = true;
      s.brake = false;
      s.rampTo = -BRAKE_RAMP_TO;
      init = rate;
    } else if (rate > BRAKE_RAMP_TO) {
      if (s.spinback || s.brake) return;
      s.brake = true;
      s.spinback = false;
      s.rampTo = BRAKE_RAMP_TO;
      init = this.rate(deck);
      if (s.softStart) {
        s.softStart = false;
        init = s.filter.v;
      }
    } else {
      s.brake = s.spinback = false;
      s.active = false;
      this.c(deck, "play")?.set(0);
      return;
    }
    this.c(deck, "scratch2")?.set(init);
    if (factor > 1) factor = (factor - 1) / 10 + 1;
    s.filter.init(init, 1 / 512, (1 / 512 / 1024) * factor);
    s.ramp = true;
    s.active = true;
    this.run();
  }

  softStart(deck: number, activate: boolean, _factor: number) {
    const s = this.decks[deck];
    if (!s) return;
    s.active = false;
    this.c(deck, "scratch2_enable")?.set(activate ? 1 : 0);
    s.softStart = activate;
    if (!activate) return;
    let init = 0;
    s.rampTo = this.rate(deck);
    if (s.brake || s.spinback) {
      s.brake = s.spinback = false;
      init = s.filter.v;
    }
    this.c(deck, "play")?.set(1);
    this.c(deck, "scratch2")?.set(init);
    s.filter.init(init, 1 / 512, (1 / 512 / 1024) * _factor);
    s.active = true;
    this.run();
  }

  stopAll() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (let d = 1; d < this.decks.length; d++) {
      if (this.decks[d].active) this.c(d, "scratch2_enable")?.set(0);
      this.decks[d].active = false;
    }
  }

  private run() {
    if (this.timer !== undefined) return;
    this.last = performance.now();
    this.timer = window.setInterval(() => this.process(), 1);
  }

  private process() {
    const now = performance.now();
    // Browsers run 1 ms timers every few ms: catch up one millisecond at a time,
    // spreading the platter's ticks over the steps.
    const steps = Math.max(1, Math.min(50, Math.round(now - this.last)));
    this.last = now;
    let any = false;
    for (let deck = 1; deck < this.decks.length; deck++) {
      const s = this.decks[deck];
      if (!s.active) continue;
      any = true;
      const perStep = s.acc / steps;
      s.acc = 0;
      let rate = s.filter.v;
      let done = false;
      for (let i = 0; i < steps && !done; i++) {
        if (s.ramp && !s.softStart && now - s.lastMovement >= 1) s.filter.observation(s.rampTo * s.rampFactor);
        else if (s.softStart) s.filter.observation(s.rampTo * 0.001);
        else s.filter.observation(s.dx * perStep);
        rate = s.filter.v;
        const loaded = (this.c(deck, "track_loaded")?.get() ?? 0) > 0;
        done =
          (s.ramp && Math.abs(s.rampTo - rate) <= 0.00001) ||
          (s.brake && rate < s.rampTo) ||
          ((s.spinback || s.softStart) && rate > s.rampTo) ||
          ((s.brake || s.softStart) && !this.playing(deck)) ||
          !loaded;
      }
      this.c(deck, "scratch2")?.set(rate);
      if (done) {
        s.ramp = false;
        if (s.brake || s.spinback) {
          this.c(deck, "scratch2")?.set(0);
          this.c(deck, "play")?.set(0);
        }
        this.c(deck, "scratch2_enable")?.set(0);
        s.active = false;
        s.dx = 0;
        s.brake = s.spinback = s.softStart = false;
      }
    }
    this.rt.queueFlush();
    if (!any) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// --- ColorMapper: the nearest of a controller's palette colours ------------------------

class ColorMapper {
  private colors: { rgb: number; value: unknown }[];
  constructor(available: Record<string, unknown>) {
    this.colors = Object.entries(available ?? {})
      .map(([k, value]) => ({ rgb: Number(k), value }))
      .filter((c) => Number.isFinite(c.rgb));
  }
  private nearest(rgb: number) {
    const r = (rgb >> 16) & 255;
    const g = (rgb >> 8) & 255;
    const b = rgb & 255;
    let best = this.colors[0];
    let bestD = Infinity;
    for (const c of this.colors) {
      const cr = (c.rgb >> 16) & 255;
      const cg = (c.rgb >> 8) & 255;
      const cb = c.rgb & 255;
      // "Redmean" weighting, close to how eyes compare colours.
      const rm = (r + cr) / 2;
      const d = (2 + rm / 256) * (r - cr) ** 2 + 4 * (g - cg) ** 2 + (2 + (255 - rm) / 256) * (b - cb) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
  getNearestColor(rgb: number) {
    const c = this.nearest(rgb);
    if (!c) return {};
    return { red: (c.rgb >> 16) & 255, green: (c.rgb >> 8) & 255, blue: c.rgb & 255 };
  }
  getValueForNearestColor(rgb: number) {
    return this.nearest(rgb)?.value;
  }
}
