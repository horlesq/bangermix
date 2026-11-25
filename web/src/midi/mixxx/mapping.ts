// Fetches a Mixxx controller mapping (the XML and its scripts) and parses it. Files
// are cached in the browser, so a controller keeps working offline after its first use.

import { type CatalogEntry, fileUrl } from "./catalog";

export interface InputMapping {
  group: string;
  key: string;
  options: Set<string>;
}

export interface OutputMapping {
  group: string;
  key: string;
  status: number;
  midino: number;
  on: number;
  off: number;
  min: number;
  max: number;
}

export interface ScriptFile {
  name: string;
  prefix: string;
  code: string;
}

export interface Mapping {
  name: string;
  controllerId: string;
  scripts: ScriptFile[];
  /** By (status << 8 | control); control is 0xFF where it is part of the value. */
  inputs: Map<number, InputMapping[]>;
  outputs: OutputMapping[];
  settings: Record<string, boolean | number | string>;
}

/** Always loaded first, as Mixxx does. */
const COMMON = "common-controller-scripts.js";
const CACHE = "bangermix-mixxx-1";

async function fetchText(url: string): Promise<string> {
  const cache = "caches" in window ? await caches.open(CACHE) : null;
  const hit = await cache?.match(url);
  if (hit) return hit.text();
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`${res.status} for ${decodeURIComponent(url.split("/").pop() ?? url)}`);
  await cache?.put(url, res.clone());
  return res.text();
}

const num = (s: string | null | undefined, fallback: number): number => {
  if (s === null || s === undefined || s.trim() === "") return fallback;
  const t = s.trim();
  const v = /^0x/i.test(t) ? parseInt(t, 16) : /^0[0-7]+$/.test(t) ? parseInt(t, 8) : Number(t);
  return Number.isFinite(v) ? v : fallback;
};

const text = (el: Element, tag: string): string | null => {
  for (const c of el.children) if (c.tagName === tag) return c.textContent?.trim() ?? "";
  return null;
};

/** Mixxx keys a message by status and data byte, except where the data byte is part
 * of the value (pitch bend, channel pressure, program change). */
export function inputKey(status: number, control: number): number {
  const op = status & 0xf0;
  const twoBytes = op === 0x80 || op === 0x90 || op === 0xa0 || op === 0xb0;
  return (status << 8) | (twoBytes ? control : 0xff);
}

export async function loadMapping(entry: CatalogEntry): Promise<Mapping> {
  const xml = await fetchText(fileUrl(entry.ref, entry.file));
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`${entry.file} is not valid XML`);
  const controller = doc.querySelector("controller");
  if (!controller) throw new Error(`${entry.file} has no controller section`);

  const files: { name: string; prefix: string }[] = [{ name: COMMON, prefix: "" }];
  for (const f of controller.querySelectorAll("scriptfiles > file")) {
    const name = f.getAttribute("filename") ?? "";
    if (!name || name === COMMON) continue;
    files.push({ name, prefix: f.getAttribute("functionprefix") ?? "" });
  }
  const scripts = await Promise.all(
    files.map(async (f) => ({ ...f, code: await fetchText(fileUrl(entry.ref, f.name)) })),
  );

  const inputs = new Map<number, InputMapping[]>();
  for (const c of controller.querySelectorAll("controls > control")) {
    const status = num(text(c, "status"), 0);
    const midino = num(text(c, "midino"), 0);
    const options = new Set<string>();
    for (const o of c.querySelector("options")?.children ?? []) options.add(o.tagName.toLowerCase());
    const m: InputMapping = { group: text(c, "group") ?? "", key: text(c, "key") ?? "", options };
    const k = inputKey(status, midino);
    const list = inputs.get(k);
    if (list) list.push(m);
    else inputs.set(k, [m]);
  }

  const outputs: OutputMapping[] = [];
  for (const o of controller.querySelectorAll("outputs > output")) {
    outputs.push({
      group: text(o, "group") ?? "",
      key: text(o, "key") ?? "",
      status: num(text(o, "status"), 0),
      midino: num(text(o, "midino"), 0),
      on: num(text(o, "on"), 0x7f),
      off: num(text(o, "off"), 0x00),
      min: num(text(o, "minimum"), 0),
      max: num(text(o, "maximum"), 1),
    });
  }

  const settings: Mapping["settings"] = {};
  for (const o of doc.querySelectorAll("settings option")) {
    const name = o.getAttribute("variable");
    if (!name) continue;
    const type = o.getAttribute("type");
    const def = o.getAttribute("default");
    if (type === "boolean") settings[name] = def === "true";
    else if (type === "integer" || type === "real") settings[name] = num(def, 0);
    else if (type === "enum") {
      const values = [...o.querySelectorAll("value")];
      const chosen = values.find((v) => v.getAttribute("default") === "true") ?? values[0];
      settings[name] = chosen?.textContent?.trim() ?? "";
    } else if (type === "color") settings[name] = def ? parseInt(def.replace("#", ""), 16) : 0;
    else settings[name] = def ?? "";
  }

  const name = doc.querySelector("info > name")?.textContent?.trim() || `${entry.brand} ${entry.model}`;
  return { name, controllerId: controller.getAttribute("id") ?? entry.model, scripts, inputs, outputs, settings };
}
