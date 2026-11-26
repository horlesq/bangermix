// The effects of a Pioneer DJM-900NXS2: the Beat FX unit (in the top bar, where it has
// room) and the Sound Color FX buttons along the bottom of the mixer, with their
// PARAMETER knob (each channel's FX knob applies the chosen one).

import { For } from "solid-js";
import { COLOR, FX, FX_TARGET_MASTER } from "../audio/params";
import { masterDeck } from "../state/deck";
import { BEAT_FX_ORDER, mixer, setColor, setFx, stepFxBeats } from "../state/mixer";
import { settings } from "../state/settings";
import { HoldButton, Knob } from "./controls";
import { IconLeft, IconRight } from "./icons";

/** Names, in the DJM's order (BEAT_FX_ORDER). `param` names the effect's second knob. */
export const BEAT_FX = [
  { id: FX.DELAY, name: "DELAY", param: "FEEDBACK" },
  { id: FX.ECHO, name: "ECHO", param: "FEEDBACK" },
  { id: FX.PING_PONG, name: "PING PONG", param: "FEEDBACK" },
  { id: FX.SPIRAL, name: "SPIRAL", param: "FEEDBACK" },
  { id: FX.REVERB, name: "REVERB", param: "SIZE" },
  { id: FX.TRANS, name: "TRANS", param: "OPEN" },
  { id: FX.FILTER, name: "FILTER", param: "RESO" },
  { id: FX.FLANGER, name: "FLANGER", param: "FEEDBACK" },
  { id: FX.PHASER, name: "PHASER", param: "FEEDBACK" },
  { id: FX.PITCH, name: "PITCH", param: "PITCH" },
  { id: FX.SLIP_ROLL, name: "SLIP ROLL", param: "—" },
  { id: FX.ROLL, name: "ROLL", param: "—" },
  { id: FX.VINYL_BRAKE, name: "VINYL BRAKE", param: "—" },
  { id: FX.HELIX, name: "HELIX", param: "INPUT" },
];

/** The Sound Color FX, as the DJM's buttons, each with its colour. */
export const COLOR_FX = [
  { id: COLOR.SPACE, name: "SPACE", color: "#4fb3ff", help: "Reverb: left low, right high" },
  { id: COLOR.DUB_ECHO, name: "DUB ECHO", color: "#ffb020", help: "Echo: left darker, right thinner" },
  { id: COLOR.SWEEP, name: "SWEEP", color: "#b98cff", help: "Left: gate (tighter), right: band-pass sweep" },
  { id: COLOR.NOISE, name: "NOISE", color: "#ff5b8a", help: "White noise through a filter: left closing, right opening" },
  { id: COLOR.CRUSH, name: "CRUSH", color: "#ff7a2f", help: "Bit crusher: left crushed, right crushed and high-passed" },
  { id: COLOR.FILTER, name: "FILTER", color: "#3ddc84", help: "Filter: left low-pass, right high-pass" },
];

if (import.meta.env.DEV && BEAT_FX.some((e, i) => e.id !== BEAT_FX_ORDER[i])) console.error("BEAT_FX and BEAT_FX_ORDER differ");

export const colorFx = () => COLOR_FX.find((c) => c.id === mixer.color.type) ?? COLOR_FX[5];

function beatLabel(b: number): string {
  if (b >= 1) return String(b);
  return { 0.0625: "1/16", 0.125: "1/8", 0.25: "1/4", 0.5: "1/2", 0.75: "3/4" }[b] ?? b.toFixed(2);
}

/** The top bar's Beat FX unit: effect, beat length, channel, LEVEL/DEPTH, its second knob, ON. */
export function BeatFxSection() {
  const fx = () => mixer.fx;
  const effect = () => BEAT_FX.find((e) => e.id === fx().type) ?? BEAT_FX[1];
  const targets = () => [...Array(settings.deckCount).keys(), FX_TARGET_MASTER];
  const ms = () => Math.round((60 / (masterDeck()?.currentBpm() || 120)) * fx().beats * 1000);
  return (
    <div class="fx">
      <span class="section-label">BEAT FX</span>
      <select class="fx-select" value={fx().type} onChange={(e) => setFx("type", Number(e.currentTarget.value))} title="Effect">
        <For each={BEAT_FX}>{(e) => <option value={e.id}>{e.name}</option>}</For>
      </select>
      <div class="fx-beats">
        <button class="icon" onClick={() => stepFxBeats(-1)} title="Fewer beats">
          <IconLeft size={12} />
        </button>
        <div class="fx-beat-readout" title="Beats (and the time they take at the master tempo)">
          <span>{beatLabel(fx().beats)}</span>
          <small>{ms()} ms</small>
        </div>
        <button class="icon" onClick={() => stepFxBeats(1)} title="More beats">
          <IconRight size={12} />
        </button>
      </div>
      <div class="seg" title="Channel the effect is on">
        <For each={targets()}>
          {(t) => (
            <button classList={{ on: fx().target === t }} onClick={() => setFx("target", t)}>
              {t === FX_TARGET_MASTER ? "MST" : t + 1}
            </button>
          )}
        </For>
      </div>
      <Knob label="DEPTH" value={fx().wet} reset={0.6} size={24} onChange={(v) => setFx("wet", v)} title="LEVEL/DEPTH" />
      <Knob label={effect().param} value={fx().param} reset={0.5} size={24} onChange={(v) => setFx("param", v)} />
      <button class="fx-on" classList={{ on: fx().on }} onClick={() => setFx("on", !fx().on)} title="Effect on/off">
        ON
      </button>
      <HoldButton class="fx-hold" onDown={() => setFx("on", true)} onUp={() => setFx("on", false)} title="Effect while held">
        HOLD
      </HoldButton>
    </div>
  );
}

export function ColorFxSection() {
  return (
    <div class="color-fx">
      <div class="color-fx-buttons">
        <For each={COLOR_FX}>
          {(c) => (
            <button
              classList={{ on: mixer.color.type === c.id }}
              style={{ "--lit": c.color }}
              onClick={() => setColor("type", c.id)}
              title={`${c.name}: ${c.help}`}
            >
              {c.name}
            </button>
          )}
        </For>
      </div>
      <Knob
        label="PARAMETER"
        value={mixer.color.param}
        reset={0.5}
        size={26}
        color={colorFx().color}
        onChange={(v) => setColor("param", v)}
        title="Sound Color FX parameter"
      />
    </div>
  );
}
