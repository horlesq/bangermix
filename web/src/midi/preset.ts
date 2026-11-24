// A controller preset: code that turns a controller's messages into actions and
// lights its LEDs.

export type MidiOut = (bytes: number[]) => void;

export interface Preset {
  name: string;
  /** Matched against the MIDI port name. */
  match: RegExp;
  /** Needs SysEx (Chrome asks the user once). */
  sysex?: boolean;
  start?(out: MidiOut, sysex?: MidiOut): void;
  stop?(): void;
  message(data: Uint8Array, out: MidiOut): void;
  /** Called every animation frame, for LEDs and meters. */
  frame?(out: MidiOut): void;
}
