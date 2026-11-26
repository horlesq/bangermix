// The mixer, laid out like a Pioneer DJM-900NXS2: channel strips (trim, 3-band EQ,
// COLOR, headphone cue, fader, meter, crossfader assign), master and headphones, and the
// Sound Color FX buttons and the crossfader below. The Beat FX unit is in the top bar.

import { For, onCleanup, onMount } from "solid-js";
import { S, SG } from "../audio/params";
import { maybeEngine } from "../state/app";
import { type XfAssign, mixer, setChannel, setCrossfader, setMixerValue } from "../state/mixer";
import { Fader, Knob, meterSegments } from "./controls";
import { ColorFxSection, colorFx } from "./FxPanel";
import { onFrame } from "./frame";
import { IconHeadphones } from "./icons";
import { deckColor } from "./theme";

const SEGMENTS = 16;

export function MixerPanel(p: { channels: number[]; compact?: boolean }) {
  return (
    <div class="mixer" classList={{ compact: p.compact }}>
      <div class="mixer-channels">
        <For each={p.channels}>{(k) => <Strip k={k} compact={p.compact} />}</For>
        <Master />
      </div>
      <ColorFxSection />
      <div class="crossfader-row">
        <span>A</span>
        <Fader value={mixer.crossfader} reset={0.5} length={200} onChange={setCrossfader} class="crossfader" title="Crossfader (double-click centres)">
          <div class="xf-center" />
        </Fader>
        <span>B</span>
      </div>
    </div>
  );
}

function Strip(p: { k: number; compact?: boolean }) {
  const c = () => mixer.channels[p.k];
  return (
    <div class="strip" style={{ "--deck": deckColor(p.k) }}>
      <div class="strip-num">{p.k + 1}</div>
      <Knob label="TRIM" size={26} value={c().trim} min={-1} max={1} reset={0} onChange={(v) => setChannel(p.k, "trim", v)} />
      <div class="eq-group">
        <Knob label="HI" value={c().high} reset={0.5} onChange={(v) => setChannel(p.k, "high", v)} />
        <Knob label="MID" value={c().mid} reset={0.5} onChange={(v) => setChannel(p.k, "mid", v)} />
        <Knob label="LOW" value={c().low} reset={0.5} onChange={(v) => setChannel(p.k, "low", v)} />
      </div>
      <Knob
        label="FX"
        value={c().filter}
        min={-1}
        max={1}
        reset={0}
        color={colorFx().color}
        onChange={(v) => setChannel(p.k, "filter", v)}
        title={`FX knob, playing ${colorFx().name}: ${colorFx().help}. Pick the effect below.`}
      />
      <button class="cue-ch" classList={{ on: c().cue }} onClick={() => setChannel(p.k, "cue", !c().cue)} title="Headphone cue">
        <IconHeadphones size={13} />
      </button>
      <div class="fader-meter">
        <Meter deck={p.k} />
        <Fader vertical value={c().fader} reset={1} length={p.compact ? 76 : 112} onChange={(v) => setChannel(p.k, "fader", v)} title="Channel fader" class="ch-fader" />
      </div>
      <div class="xf-assign" title="Crossfader assign">
        <For each={["a", "thru", "b"] as XfAssign[]}>
          {(side) => (
            <button classList={{ on: c().xf === side }} onClick={() => setChannel(p.k, "xf", side)}>
              {side === "thru" ? "T" : side.toUpperCase()}
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
      <div class="strip-num">MASTER</div>
      <Knob label="LEVEL" size={34} value={mixer.master} reset={0.8} onChange={(v) => setMixerValue("master", v)} />
      <div class="master-meters">
        <MasterMeter />
      </div>
      <div class="phones-label">
        <IconHeadphones size={12} />
      </div>
      <Knob label="MIX" value={mixer.phonesMix} reset={0.5} onChange={(v) => setMixerValue("phonesMix", v)} title="Headphones: cue ↔ master" />
      <Knob label="LEVEL" value={mixer.phonesLevel} reset={0.7} onChange={(v) => setMixerValue("phonesLevel", v)} title="Headphones level" />
    </div>
  );
}

function segments() {
  return <For each={Array(SEGMENTS).fill(0)}>{() => <i />}</For>;
}

function light(segs: HTMLElement[], peak: number) {
  const n = meterSegments(peak, segs.length);
  segs.forEach((s, i) => s.classList.toggle("lit", segs.length - 1 - i < n));
}

function Meter(p: { deck: number }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const segs = Array.from(el.children) as HTMLElement[];
    onCleanup(
      onFrame(() => {
        const e = maybeEngine();
        light(segs, e ? Math.max(e.deck(p.deck, S.PEAK_L), e.deck(p.deck, S.PEAK_R)) : 0);
      }),
    );
  });
  return (
    <div class="meter" ref={el}>
      {segments()}
    </div>
  );
}

function MasterMeter() {
  let l!: HTMLDivElement;
  let r!: HTMLDivElement;
  onMount(() => {
    const ls = Array.from(l.children) as HTMLElement[];
    const rs = Array.from(r.children) as HTMLElement[];
    onCleanup(
      onFrame(() => {
        const e = maybeEngine();
        light(ls, e ? e.global(SG.MASTER_PEAK_L) : 0);
        light(rs, e ? e.global(SG.MASTER_PEAK_R) : 0);
      }),
    );
  });
  return (
    <>
      <div class="meter wide" ref={l}>
        {segments()}
      </div>
      <div class="meter wide" ref={r}>
        {segments()}
      </div>
    </>
  );
}
