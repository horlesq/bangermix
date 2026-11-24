// The mixer: channel strips (trim, 3-band EQ, colour filter, cue, fader, meter), the
// crossfader, master and headphones.

import { For, onCleanup, onMount } from "solid-js";
import { S, SG } from "../audio/params";
import { maybeEngine } from "../state/app";
import { type XfAssign, mixer, setChannel, setCrossfader, setMixerValue } from "../state/mixer";
import { Fader, Knob, meterSegments } from "./controls";
import { onFrame } from "./frame";
import { deckColor } from "./theme";

export function MixerPanel(p: { channels: number[] }) {
  return (
    <div class="mixer">
      <div class="mixer-channels">
        <For each={p.channels}>{(k) => <Strip k={k} />}</For>
        <Master />
      </div>
      <div class="crossfader-row">
        <span>A</span>
        <Fader value={mixer.crossfader} reset={0.5} length={180} onChange={setCrossfader} class="crossfader" title="Crossfader" />
        <span>B</span>
      </div>
    </div>
  );
}

function Strip(p: { k: number }) {
  const c = () => mixer.channels[p.k];
  const color = deckColor(p.k);
  return (
    <div class="strip" style={{ "--deck": color }}>
      <div class="strip-num">{p.k + 1}</div>
      <Knob label="TRIM" value={c().trim} min={-1} max={1} reset={0} size={26} onChange={(v) => setChannel(p.k, "trim", v)} />
      <Knob label="HI" size={28} value={c().high} reset={0.5} color={color} onChange={(v) => setChannel(p.k, "high", v)} />
      <Knob label="MID" size={28} value={c().mid} reset={0.5} color={color} onChange={(v) => setChannel(p.k, "mid", v)} />
      <Knob label="LOW" size={28} value={c().low} reset={0.5} color={color} onChange={(v) => setChannel(p.k, "low", v)} />
      <Knob
        label="COLOR"
        size={28}
        value={c().filter}
        min={-1}
        max={1}
        reset={0}
        color="#ffb020"
        onChange={(v) => setChannel(p.k, "filter", v)}
        title="Filter: left low-pass, right high-pass"
      />
      <button class="cue-ch" classList={{ on: c().cue }} onClick={() => setChannel(p.k, "cue", !c().cue)} title="Headphone cue">
        CUE
      </button>
      <div class="fader-meter">
        <Meter deck={p.k} />
        <Fader vertical value={c().fader} reset={1} length={96} onChange={(v) => setChannel(p.k, "fader", v)} title="Channel fader" />
      </div>
      <div class="xf-assign">
        <For each={["a", "thru", "b"] as XfAssign[]}>
          {(side) => (
            <button classList={{ on: c().xf === side }} onClick={() => setChannel(p.k, "xf", side)}>
              {side === "thru" ? "THRU" : side.toUpperCase()}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function Master() {
  return (
    <div class="strip master-strip">
      <div class="strip-num">M</div>
      <Knob label="MASTER" value={mixer.master} reset={0.8} size={38} color="#fff" onChange={(v) => setMixerValue("master", v)} />
      <div class="master-meters">
        <MasterMeter />
      </div>
      <Knob label="CUE/MST" value={mixer.phonesMix} reset={0.5} onChange={(v) => setMixerValue("phonesMix", v)} title="Headphones: cue ↔ master" />
      <Knob label="PHONES" value={mixer.phonesLevel} reset={0.7} onChange={(v) => setMixerValue("phonesLevel", v)} />
    </div>
  );
}

function Meter(p: { deck: number }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const segs = Array.from(el.children) as HTMLElement[];
    const off = onFrame(() => {
      const e = maybeEngine();
      const peak = e ? Math.max(e.deck(p.deck, S.PEAK_L), e.deck(p.deck, S.PEAK_R)) : 0;
      const n = meterSegments(peak, segs.length);
      segs.forEach((s, i) => s.classList.toggle("lit", segs.length - 1 - i < n));
    });
    onCleanup(off);
  });
  return (
    <div class="meter" ref={el}>
      <For each={Array(15).fill(0)}>{() => <i />}</For>
    </div>
  );
}

function MasterMeter() {
  let l!: HTMLDivElement;
  let r!: HTMLDivElement;
  onMount(() => {
    const ls = Array.from(l.children) as HTMLElement[];
    const rs = Array.from(r.children) as HTMLElement[];
    const off = onFrame(() => {
      const e = maybeEngine();
      const nl = meterSegments(e ? e.global(SG.MASTER_PEAK_L) : 0, ls.length);
      const nr = meterSegments(e ? e.global(SG.MASTER_PEAK_R) : 0, rs.length);
      ls.forEach((s, i) => s.classList.toggle("lit", ls.length - 1 - i < nl));
      rs.forEach((s, i) => s.classList.toggle("lit", rs.length - 1 - i < nr));
    });
    onCleanup(off);
  });
  return (
    <>
      <div class="meter" ref={l}>
        <For each={Array(15).fill(0)}>{() => <i />}</For>
      </div>
      <div class="meter" ref={r}>
        <For each={Array(15).fill(0)}>{() => <i />}</For>
      </div>
    </>
  );
}
