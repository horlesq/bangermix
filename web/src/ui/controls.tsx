// Knobs, faders and buttons, made for the mouse: drag to move, double-click to reset,
// scroll for fine steps, Shift for finer still.

import { createSignal, type JSX } from "solid-js";

interface KnobProps {
  value: number;
  min?: number;
  max?: number;
  /** Double-click resets here (and a bipolar knob's arc starts here). */
  reset?: number;
  label?: string;
  size?: number;
  color?: string;
  onChange: (v: number) => void;
  title?: string;
}

export function Knob(p: KnobProps) {
  const min = () => p.min ?? 0;
  const max = () => p.max ?? 1;
  const reset = () => p.reset ?? min();
  const size = () => p.size ?? 34;
  const frac = () => (p.value - min()) / (max() - min());
  const angle = (f: number) => -135 + f * 270;

  const down = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = e.clientY;
    const move = (ev: PointerEvent) => {
      const dy = last - ev.clientY;
      last = ev.clientY;
      const range = max() - min();
      const per = ev.shiftKey ? 600 : 160;
      let v = p.value + (dy / per) * range;
      // A little detent at the reset point.
      if (Math.abs(v - reset()) < range * 0.015 && Math.abs(p.value - reset()) >= range * 0.015) v = reset();
      p.onChange(Math.max(min(), Math.min(max(), v)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const range = max() - min();
    const step = (e.shiftKey ? 0.005 : 0.025) * range * (e.deltaY < 0 ? 1 : -1);
    p.onChange(Math.max(min(), Math.min(max(), p.value + step)));
  };

  const arc = () => {
    const r = size() / 2 - 3;
    const c = size() / 2;
    const a0 = angle((reset() - min()) / (max() - min()));
    const a1 = angle(frac());
    const [from, to] = a0 < a1 ? [a0, a1] : [a1, a0];
    const pt = (a: number) => {
      const rad = ((a - 90) * Math.PI) / 180;
      return `${c + r * Math.cos(rad)} ${c + r * Math.sin(rad)}`;
    };
    if (to - from < 0.5) return "";
    return `M ${pt(from)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${pt(to)}`;
  };

  return (
    <div class="knob" title={p.title ?? p.label}>
      <svg
        width={size()}
        height={size()}
        onPointerDown={down}
        onWheel={wheel}
        onDblClick={() => p.onChange(reset())}
      >
        <circle cx={size() / 2} cy={size() / 2} r={size() / 2 - 3} class="knob-track" />
        <path d={arc()} class="knob-arc" style={{ stroke: p.color }} />
        <circle cx={size() / 2} cy={size() / 2} r={size() / 2 - 7} class="knob-body" />
        <line
          x1={size() / 2}
          y1={size() / 2}
          x2={size() / 2}
          y2={7}
          class="knob-pointer"
          transform={`rotate(${angle(frac())} ${size() / 2} ${size() / 2})`}
        />
      </svg>
      {p.label && <span class="knob-label">{p.label}</span>}
    </div>
  );
}

interface FaderProps {
  value: number;
  min?: number;
  max?: number;
  reset?: number;
  vertical?: boolean;
  /** Vertical faders put max at the top unless inverted (tempo: + at the bottom). */
  invert?: boolean;
  length?: number;
  class?: string;
  onChange: (v: number) => void;
  title?: string;
  children?: JSX.Element;
}

export function Fader(p: FaderProps) {
  const min = () => p.min ?? 0;
  const max = () => p.max ?? 1;
  const frac = () => (p.value - min()) / (max() - min());
  let track!: HTMLDivElement;

  const fromPointer = (e: PointerEvent, grabOffset: number) => {
    const r = track.getBoundingClientRect();
    let f: number;
    if (p.vertical) {
      f = 1 - (e.clientY - grabOffset - r.top) / r.height;
      if (p.invert) f = 1 - f;
    } else {
      f = (e.clientX - grabOffset - r.left) / r.width;
    }
    f = Math.max(0, Math.min(1, f));
    p.onChange(min() + f * (max() - min()));
  };

  const down = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    // Grabbing the cap moves it relatively; clicking the track jumps there.
    const cap = (e.target as HTMLElement).closest(".fader-cap");
    let offset = 0;
    if (cap) {
      const cr = cap.getBoundingClientRect();
      offset = p.vertical ? e.clientY - (cr.top + cr.height / 2) : e.clientX - (cr.left + cr.width / 2);
    } else {
      fromPointer(e, 0);
    }
    const move = (ev: PointerEvent) => {
      if (ev.shiftKey) {
        // Fine: move a quarter as far.
        const r = track.getBoundingClientRect();
        const d = p.vertical ? -(ev.movementY / r.height) * (p.invert ? -1 : 1) : ev.movementX / r.width;
        p.onChange(Math.max(min(), Math.min(max(), p.value + (d / 4) * (max() - min()))));
      } else {
        fromPointer(ev, offset);
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const step = (e.shiftKey ? 0.002 : 0.02) * (max() - min()) * dir * (p.invert ? -1 : 1);
    p.onChange(Math.max(min(), Math.min(max(), p.value + step)));
  };

  const capPos = () => {
    const f = frac();
    if (p.vertical) return { top: `${(p.invert ? f : 1 - f) * 100}%` };
    return { left: `${f * 100}%` };
  };

  return (
    <div
      class={`fader ${p.vertical ? "vertical" : "horizontal"} ${p.class ?? ""}`}
      style={p.vertical ? { height: `${p.length ?? 120}px` } : { width: `${p.length ?? 160}px` }}
      onPointerDown={down}
      onWheel={wheel}
      onDblClick={() => p.reset !== undefined && p.onChange(p.reset)}
      title={p.title}
    >
      <div class="fader-track" ref={track}>
        {p.children}
        <div class="fader-cap" style={capPos()} />
      </div>
    </div>
  );
}

/** A button that reports press and release (for CUE, bends, hot cue previews). */
export function HoldButton(p: {
  class?: string;
  onDown: () => void;
  onUp?: () => void;
  children: JSX.Element;
  title?: string;
  style?: JSX.CSSProperties;
  disabled?: boolean;
}) {
  const [held, setHeld] = createSignal(false);
  return (
    <button
      class={`${p.class ?? ""} ${held() ? "held" : ""}`}
      style={p.style}
      title={p.title}
      disabled={p.disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setHeld(true);
        p.onDown();
      }}
      onPointerUp={() => {
        if (!held()) return;
        setHeld(false);
        p.onUp?.();
      }}
      onPointerCancel={() => {
        if (!held()) return;
        setHeld(false);
        p.onUp?.();
      }}
    >
      {p.children}
    </button>
  );
}

/** Level meter: a column of segments from a peak level 0..1. */
export function meterSegments(peak: number, segments = 15): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  // -42 dB to 0 dB over the segments.
  return Math.max(0, Math.min(segments, Math.round(((db + 42) / 42) * segments)));
}
