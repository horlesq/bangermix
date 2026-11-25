// WebHID: controllers that are not MIDI devices (most Traktor Kontrol models, CDJs in
// HID mode) run their Mixxx mapping over HID reports. Chrome asks once per device;
// after that the device reconnects by itself.

import { createSignal } from "solid-js";
import { notify } from "../state/app";
import { onFrame } from "../ui/frame";
import { CATALOG, type CatalogEntry, matchHid } from "./mixxx/catalog";
import type { MixxxRuntime } from "./mixxx/runtime";

export interface HidInfo {
  key: string;
  name: string;
  status: string;
}

export const hidSupported = typeof navigator !== "undefined" && "hid" in navigator;
export const [hidDevices, setHidDevices] = createSignal<HidInfo[]>([]);

interface Running {
  device: HIDDevice;
  entry: CatalogEntry;
  rt: MixxxRuntime | null;
  status: string;
}
const running = new Map<HIDDevice, Running>();
let started = false;

function publish() {
  setHidDevices(
    [...running.values()].map((r, i) => ({
      key: `${r.device.vendorId}:${r.device.productId}:${i}`,
      name: `${r.entry.brand} ${r.entry.model}`,
      status: r.status,
    })),
  );
}

/** Asks Chrome for a controller (needs a click). */
export async function connectHid() {
  if (!hidSupported) return;
  const filters = CATALOG.flatMap((c) => c.hid ?? []).map((h) => ({
    vendorId: h.vendorId,
    productId: h.productId,
    ...(h.usagePage ? { usagePage: h.usagePage } : {}),
    ...(h.usage ? { usage: h.usage } : {}),
  }));
  try {
    const devices = await navigator.hid.requestDevice({ filters });
    for (const d of devices) await startDevice(d);
  } catch (e) {
    notify(`Could not open the controller: ${(e as Error).message}`);
  }
  watch();
}

/** Reconnects controllers allowed on an earlier visit. */
export async function initHid() {
  if (!hidSupported) return;
  for (const d of await navigator.hid.getDevices()) await startDevice(d);
  watch();
}

function watch() {
  if (started || !hidSupported) return;
  started = true;
  navigator.hid.addEventListener("connect", (e) => void startDevice((e as HIDConnectionEvent).device));
  navigator.hid.addEventListener("disconnect", (e) => stopDevice((e as HIDConnectionEvent).device));
  onFrame(() => {
    for (const r of running.values()) r.rt?.flush();
  });
}

/** Bytes per report id, from the device's report descriptors. */
function reportSizes(device: HIDDevice, kind: "inputReports" | "featureReports"): Map<number, number> {
  const sizes = new Map<number, number>();
  const walk = (cs: readonly HIDCollectionInfo[] | undefined) => {
    for (const c of cs ?? []) {
      for (const r of c[kind] ?? []) {
        let bits = 0;
        for (const item of r.items ?? []) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
        sizes.set(r.reportId ?? 0, Math.ceil(bits / 8));
      }
      walk(c.children);
    }
  };
  walk(device.collections);
  return sizes;
}

async function startDevice(device: HIDDevice) {
  if (running.has(device)) return;
  const entry = matchHid(device.vendorId, device.productId);
  if (!entry) return;
  // A device shows up once per top-level collection: take the one the mapping is for.
  const id = entry.hid!.find((h) => h.vendorId === device.vendorId && h.productId === device.productId)!;
  if (id.usagePage && !device.collections.some((c) => c.usagePage === id.usagePage)) return;
  const r: Running = { device, entry, rt: null, status: "loading the mapping…" };
  running.set(device, r);
  publish();
  try {
    if (!device.opened) await device.open();
    const [{ loadMapping }, { MixxxRuntime }] = await Promise.all([import("./mixxx/mapping"), import("./mixxx/runtime")]);
    const mapping = await loadMapping(entry);
    const inputSizes = reportSizes(device, "inputReports");
    const featureSizes = reportSizes(device, "featureReports");

    // Scripts read feature reports synchronously at start: read the ones they ask for.
    const featureReports = new Map<number, ArrayBuffer>();
    const wanted = new Set<number>();
    for (const s of mapping.scripts) {
      for (const m of s.code.matchAll(/getFeatureReport\(\s*(0x[0-9a-f]+|\d+)/gi)) wanted.add(Number(m[1]));
    }
    for (const fid of wanted) {
      try {
        const view = await device.receiveFeatureReport(fid);
        let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (bytes[0] === fid && bytes.length === (featureSizes.get(fid) ?? -1) + 1) bytes = bytes.slice(1);
        featureReports.set(fid, bytes.slice().buffer);
      } catch {
        /* not readable on this device */
      }
    }

    const inputReports = new Map<number, ArrayBuffer>();
    // Output reports go out one at a time; a newer report of an id replaces one
    // still waiting, as they carry the whole state of the LEDs they drive.
    const pending = new Map<number, Uint8Array>();
    let sending = false;
    const pump = async () => {
      if (sending) return;
      sending = true;
      while (pending.size) {
        const [rid, data] = pending.entries().next().value!;
        pending.delete(rid);
        try {
          await device.sendReport(rid, data as BufferSource);
        } catch {
          /* device gone */
        }
      }
      sending = false;
    };

    const rt = new MixxxRuntime(mapping, {
      name: entry.model,
      hidReport: (rid, data) => {
        pending.set(rid, data);
        void pump();
      },
      hidFeature: (rid, data) => void device.sendFeatureReport(rid, data as BufferSource).catch(() => {}),
      featureReports,
      inputReports,
      inputReportSize: (rid) => inputSizes.get(rid) ?? 64,
      featureReportSize: (rid) => featureSizes.get(rid) ?? 64,
    });
    rt.onError = () => {
      r.status = `running, with ${rt.errors.length} script error${rt.errors.length > 1 ? "s" : ""} (see the console)`;
      publish();
    };
    device.addEventListener("inputreport", (e) => {
      const ev = e as HIDInputReportEvent;
      const body = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
      inputReports.set(ev.reportId, body.slice().buffer);
      if (ev.reportId === 0) {
        rt.hidIn(body);
      } else {
        const withId = new Uint8Array(body.length + 1);
        withId[0] = ev.reportId;
        withId.set(body, 1);
        rt.hidIn(withId);
      }
    });
    r.rt = rt;
    rt.start();
    if (!rt.errors.length) r.status = "ready";
    notify(`${entry.brand} ${entry.model} connected`);
  } catch (e) {
    r.status = `could not start: ${(e as Error).message}`;
  }
  publish();
}

function stopDevice(device: HIDDevice) {
  const r = running.get(device);
  if (!r) return;
  r.rt?.stop();
  running.delete(device);
  publish();
  notify(`${r.entry.model} disconnected`);
}
