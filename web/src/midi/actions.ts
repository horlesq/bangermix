// Things a controller can do, by name: what presets and MIDI learn map messages to.
// `value` is 0..1 for knobs and faders, 1/0 for press and release.

import { moveSelection, selected } from "../state/browser";
import { decks } from "../state/deck";
import { trackById } from "../state/library";
import { mixer, setChannel, setCrossfader, setFx, setMixerValue } from "../state/mixer";
import { settings, setSettings } from "../state/settings";

export interface Action {
  id: string;
  label: string;
  kind: "button" | "knob";
  run: (value: number) => void;
}

const press = (f: () => void) => (v: number) => {
  if (v > 0.5) f();
};

function deckActions(i: number): Action[] {
  const d = () => decks[i];
  const n = i + 1;
  const a: Action[] = [
    { id: `deck${n}.play`, label: `Deck ${n} play / pause`, kind: "button", run: press(() => d().togglePlay()) },
    {
      id: `deck${n}.cue`,
      label: `Deck ${n} cue`,
      kind: "button",
      run: (v) => (v > 0.5 ? d().cueDown() : d().cueUp()),
    },
    { id: `deck${n}.sync`, label: `Deck ${n} sync`, kind: "button", run: press(() => d().setSync(!d().sync())) },
    { id: `deck${n}.load`, label: `Deck ${n} load selected track`, kind: "button", run: press(() => {
      const t = selected() ? trackById(selected()!) : undefined;
      if (t) void d().load(t);
    }) },
    { id: `deck${n}.tempo`, label: `Deck ${n} tempo fader`, kind: "knob", run: (v) => d().setTempoFader(v * 2 - 1) },
    { id: `deck${n}.loop4`, label: `Deck ${n} 4-beat loop`, kind: "button", run: press(() => d().autoLoop(4)) },
    { id: `deck${n}.loopIn`, label: `Deck ${n} loop in`, kind: "button", run: press(() => d().loopIn()) },
    { id: `deck${n}.loopOut`, label: `Deck ${n} loop out`, kind: "button", run: press(() => d().loopOut()) },
    { id: `deck${n}.reloop`, label: `Deck ${n} reloop / exit`, kind: "button", run: press(() => d().reloopExit()) },
    { id: `deck${n}.jumpBack`, label: `Deck ${n} beat jump back`, kind: "button", run: press(() => d().beatJump(-d().jumpBeats())) },
    { id: `deck${n}.jumpFwd`, label: `Deck ${n} beat jump forward`, kind: "button", run: press(() => d().beatJump(d().jumpBeats())) },
    { id: `deck${n}.slip`, label: `Deck ${n} slip`, kind: "button", run: press(() => d().setSlip(!d().slip())) },
    { id: `deck${n}.keylock`, label: `Deck ${n} master tempo (keylock)`, kind: "button", run: press(() => d().setKeylock(!d().keylock())) },
    { id: `deck${n}.keyUp`, label: `Deck ${n} key up`, kind: "button", run: press(() => d().setKeyShift(d().keyShift() + 1)) },
    { id: `deck${n}.keyDown`, label: `Deck ${n} key down`, kind: "button", run: press(() => d().setKeyShift(d().keyShift() - 1)) },
    { id: `deck${n}.keySync`, label: `Deck ${n} key sync`, kind: "button", run: press(() => d().keySync()) },
    { id: `deck${n}.trim`, label: `Channel ${n} trim`, kind: "knob", run: (v) => setChannel(i, "trim", v * 2 - 1) },
    { id: `deck${n}.high`, label: `Channel ${n} EQ high`, kind: "knob", run: (v) => setChannel(i, "high", v) },
    { id: `deck${n}.mid`, label: `Channel ${n} EQ mid`, kind: "knob", run: (v) => setChannel(i, "mid", v) },
    { id: `deck${n}.low`, label: `Channel ${n} EQ low`, kind: "knob", run: (v) => setChannel(i, "low", v) },
    { id: `deck${n}.filter`, label: `Channel ${n} filter`, kind: "knob", run: (v) => setChannel(i, "filter", v * 2 - 1) },
    { id: `deck${n}.fader`, label: `Channel ${n} fader`, kind: "knob", run: (v) => setChannel(i, "fader", v) },
    {
      id: `deck${n}.pfl`,
      label: `Channel ${n} headphone cue`,
      kind: "button",
      run: press(() => setChannel(i, "cue", !mixer.channels[i].cue)),
    },
  ];
  for (let h = 0; h < 8; h++) {
    a.push({
      id: `deck${n}.hotcue${h + 1}`,
      label: `Deck ${n} hot cue ${"ABCDEFGH"[h]}`,
      kind: "button",
      run: press(() => d().hotCue(h)),
    });
  }
  return a;
}

export const ACTIONS: Action[] = [
  ...deckActions(0),
  ...deckActions(1),
  ...deckActions(2),
  ...deckActions(3),
  { id: "crossfader", label: "Crossfader", kind: "knob", run: (v) => setCrossfader(v) },
  { id: "master", label: "Master level", kind: "knob", run: (v) => setMixerValue("master", v) },
  { id: "phonesMix", label: "Headphones cue/master", kind: "knob", run: (v) => setMixerValue("phonesMix", v) },
  { id: "phonesLevel", label: "Headphones level", kind: "knob", run: (v) => setMixerValue("phonesLevel", v) },
  { id: "fx.on", label: "Beat FX on/off", kind: "button", run: press(() => setFx("on", !mixer.fx.on)) },
  { id: "fx.level", label: "Beat FX level", kind: "knob", run: (v) => setFx("wet", v) },
  { id: "browse.up", label: "Browse up", kind: "button", run: press(() => moveSelection(-1)) },
  { id: "browse.down", label: "Browse down", kind: "button", run: press(() => moveSelection(1)) },
  {
    id: "quantize",
    label: "Quantize on/off",
    kind: "button",
    run: press(() => setSettings("quantize", !settings.quantize)),
  },
];

export const actionById = new Map(ACTIONS.map((a) => [a.id, a]));
