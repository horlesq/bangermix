// Controllers with a mapping in the Mixxx project (github.com/mixxxdj/mixxx,
// res/controllers), by brand. The mapping files themselves are fetched from there
// when a controller is first used, at a fixed release, and cached. They are GPL-2.0+
// and are not part of this repository.

/** The Mixxx release the mappings come from. */
export const MIXXX_RELEASE = "2.5.6";
/** A commit on Mixxx's main branch, for mappings newer than the release. */
const MIXXX_MAIN = "9b38fdab905481daa57ddcefce52d95cc1dfba82";

export type Brand = "Pioneer" | "Native Instruments" | "Numark" | "Denon DJ";

export interface HidId {
  vendorId: number;
  productId: number;
  usagePage?: number;
  usage?: number;
}

export interface CatalogEntry {
  /** Stable id: the mapping file's name. */
  file: string;
  brand: Brand;
  model: string;
  /** Matched against the MIDI port name. */
  port?: RegExp;
  hid?: HidId[];
  /** Git ref the file is fetched at. */
  ref: string;
  note?: string;
}

const R = MIXXX_RELEASE;
const ni = (productId: number, usagePage?: number, usage?: number): HidId[] => [
  { vendorId: 0x17cc, productId, usagePage, usage },
];

export const CATALOG: CatalogEntry[] = [
  // Pioneer
  { brand: "Pioneer", model: "DDJ-FLX4", file: "Pioneer-DDJ-FLX4.midi.xml", port: /DDJ-?FLX4/i, ref: R },
  { brand: "Pioneer", model: "DDJ-400", file: "Pioneer-DDJ-400.midi.xml", port: /DDJ-?400/i, ref: R },
  { brand: "Pioneer", model: "DDJ-200", file: "Pioneer DDJ-200.midi.xml", port: /DDJ-?200/i, ref: R },
  { brand: "Pioneer", model: "DDJ-SB", file: "Pioneer-DDJ-SB.midi.xml", port: /DDJ-?SB(?![0-9])/i, ref: R },
  { brand: "Pioneer", model: "DDJ-SB2", file: "Pioneer-DDJ-SB2.midi.xml", port: /DDJ-?SB2/i, ref: R },
  { brand: "Pioneer", model: "DDJ-SB3", file: "Pioneer-DDJ-SB3.midi.xml", port: /DDJ-?SB3/i, ref: R },
  { brand: "Pioneer", model: "DDJ-SX", file: "Pioneer DDJ-SX.midi.xml", port: /DDJ-?SX(?![0-9])/i, ref: R },
  { brand: "Pioneer", model: "CDJ-2000", file: "Pioneer CDJ-2000.midi.xml", port: /CDJ-?2000/i, ref: R, note: "MIDI mode" },
  { brand: "Pioneer", model: "CDJ-850", file: "Pioneer CDJ-850.midi.xml", port: /CDJ-?850/i, ref: R, note: "MIDI mode" },
  { brand: "Pioneer", model: "CDJ-350 (MIDI channel 1)", file: "Pioneer CDJ-350 Ch1.midi.xml", port: /CDJ-?350/i, ref: R },
  { brand: "Pioneer", model: "CDJ-350 (MIDI channel 2)", file: "Pioneer CDJ-350 Ch2.midi.xml", ref: R },
  {
    brand: "Pioneer",
    model: "CDJ-2000NXS / CDJ-900NXS (HID mode)",
    file: "Pioneer CDJ HID.hid.xml",
    hid: [
      { vendorId: 0x08e4, productId: 0x0157, usagePage: 0xffa0, usage: 0x1 },
      { vendorId: 0x08e4, productId: 0x014b, usagePage: 0xffa0, usage: 0x1 },
    ],
    ref: R,
  },

  // Native Instruments Traktor. Most are HID devices: connect them with the HID
  // button in Settings → Controllers.
  { brand: "Native Instruments", model: "Traktor Kontrol S4 MK3", file: "Traktor Kontrol S4 MK3.hid.xml", hid: ni(0x1720, 0xff01), ref: R },
  { brand: "Native Instruments", model: "Traktor Kontrol S4 MK2", file: "Traktor Kontrol S4 MK2.hid.xml", hid: ni(0x1310, 0xff01, 0x1), ref: R },
  { brand: "Native Instruments", model: "Traktor Kontrol S3", file: "Traktor Kontrol S3.hid.xml", hid: ni(0x1900, 0xff01, 0x1), ref: R },
  { brand: "Native Instruments", model: "Traktor Kontrol S2 MK3", file: "Traktor Kontrol S2 MK3.hid.xml", hid: ni(0x1710, 0xff01, 0x1), ref: R },
  { brand: "Native Instruments", model: "Traktor Kontrol S2 MK2", file: "Traktor Kontrol S2 Mk2.hid.xml", hid: ni(0x1320), ref: R },
  { brand: "Native Instruments", model: "Traktor Kontrol S2 MK1", file: "Traktor Kontrol S2 Mk1.hid.xml", hid: ni(0x1101), ref: R },
  { brand: "Native Instruments", model: "Traktor MX2", file: "Traktor MX2.hid.xml", hid: ni(0x2420, 0xff01, 0x1), ref: MIXXX_MAIN },
  { brand: "Native Instruments", model: "Traktor Kontrol Z1", file: "Traktor Kontrol Z1.hid.xml", hid: ni(0x1210), ref: R },
  { brand: "Native Instruments", model: "Traktor Kontrol F1", file: "Traktor Kontrol F1.hid.xml", hid: ni(0x1120, 0x1ff, 0x1), ref: R },
  { brand: "Native Instruments", model: "Traktor Kontrol X1 (MK1, MIDI)", file: "Traktor Kontrol X1.midi.xml", port: /Kontrol X1/i, ref: R },

  // Numark
  { brand: "Numark", model: "Mixtrack Platinum FX", file: "Numark Mixtrack Platinum FX.midi.xml", port: /Mix ?Track ?Platinum ?FX/i, ref: R },
  { brand: "Numark", model: "Mixtrack Pro FX", file: "Numark Mixtrack Pro FX.midi.xml", port: /Mix ?Track ?Pro ?FX/i, ref: R },
  { brand: "Numark", model: "Mixtrack Platinum", file: "Numark Mixtrack Platinum.midi.xml", port: /Mix ?Track ?Platinum(?! ?FX)/i, ref: R },
  { brand: "Numark", model: "Mixtrack (Pro) 3", file: "Numark-Mixtrack-3.midi.xml", port: /Mix ?Track( ?Pro)? ?(3|III)/i, ref: R },
  { brand: "Numark", model: "Mixtrack (Pro) II", file: "Numark Mixtrack 2.midi.xml", port: /Mix ?Track( ?Pro)? ?(2|II)(?!I)/i, ref: R },
  { brand: "Numark", model: "Mixtrack Pro", file: "Numark Mixtrack Pro.midi.xml", port: /Mix ?Track ?Pro(?! ?(FX|2|3|II))/i, ref: R },
  { brand: "Numark", model: "Mixtrack", file: "Numark MIXTRACK.midi.xml", port: /Mix ?Track(?! ?(Pro|Platinum|2|3|II))/i, ref: R },
  { brand: "Numark", model: "Mixstream Pro", file: "Numark-Mixstream-Pro.midi.xml", port: /Mixstream ?Pro/i, ref: MIXXX_MAIN },
  { brand: "Numark", model: "NS4FX", file: "Numark NS4FX.midi.xml", port: /NS4 ?FX/i, ref: MIXXX_MAIN },
  { brand: "Numark", model: "NS6II", file: "Numark NS6II.midi.xml", port: /NS6 ?(II|2)/i, ref: R },
  { brand: "Numark", model: "NS7", file: "Numark NS7.midi.xml", port: /NS7/i, ref: R },
  { brand: "Numark", model: "N4", file: "Numark N4.midi.xml", port: /\bN4\b/i, ref: R },
  { brand: "Numark", model: "V7", file: "Numark V7.midi.xml", port: /\bV7\b/i, ref: R },
  { brand: "Numark", model: "Party Mix", file: "Numark-Party-Mix.midi.xml", port: /Party ?Mix/i, ref: R },
  { brand: "Numark", model: "DJ2GO2 Touch", file: "Numark_DJ2GO2_Touch.midi.xml", port: /DJ2GO2/i, ref: R },
  { brand: "Numark", model: "DJ2Go", file: "Numark DJ2Go.midi.xml", port: /DJ2GO(?!2)/i, ref: R },
  { brand: "Numark", model: "iDJ Live II", file: "Numark iDJ Live II.midi.xml", port: /iDJ ?Live ?(II|2)/i, ref: R },
  { brand: "Numark", model: "Omni Control", file: "Numark Omni Control.midi.xml", port: /Omni ?Control/i, ref: R },
  { brand: "Numark", model: "Total Control", file: "Numark Total Control.midi.xml", port: /Total ?Control/i, ref: R },
  { brand: "Numark", model: "Scratch", file: "Numark-Scratch.midi.xml", port: /Numark ?Scratch|^Scratch\b/i, ref: R },

  // Denon DJ
  { brand: "Denon DJ", model: "MC7000", file: "Denon-MC7000.midi.xml", port: /MC7000/i, ref: R },
  { brand: "Denon DJ", model: "MC6000MK2", file: "Denon-MC6000MK2.midi.xml", port: /MC6000/i, ref: R },
  { brand: "Denon DJ", model: "MC4000", file: "Denon MC4000.midi.xml", port: /MC4000/i, ref: R },
  { brand: "Denon DJ", model: "MC3000", file: "Denon MC3000.midi.xml", port: /MC3000/i, ref: R },
  { brand: "Denon DJ", model: "DN-SC2000", file: "Denon DN SC2000.midi.xml", port: /SC2000/i, ref: R },
  { brand: "Denon DJ", model: "DN-HS5500", file: "Denon DN HS5500.midi.xml", port: /HS5500/i, ref: R },
];

export const BRANDS: Brand[] = ["Pioneer", "Native Instruments", "Numark", "Denon DJ"];

export const catalogByFile = new Map(CATALOG.map((c) => [c.file, c]));

/** The mapping for a MIDI port name: the most specific pattern that matches. */
export function matchPort(name: string): CatalogEntry | undefined {
  let best: CatalogEntry | undefined;
  let bestLen = 0;
  for (const c of CATALOG) {
    const m = c.port ? name.match(c.port) : null;
    if (m && m[0].length > bestLen) {
      best = c;
      bestLen = m[0].length;
    }
  }
  return best;
}

export function matchHid(vendorId: number, productId: number): CatalogEntry | undefined {
  return CATALOG.find((c) => c.hid?.some((h) => h.vendorId === vendorId && h.productId === productId));
}

export function fileUrl(ref: string, file: string): string {
  return `https://raw.githubusercontent.com/mixxxdj/mixxx/${ref}/res/controllers/${encodeURIComponent(file)}`;
}
