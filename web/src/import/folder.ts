// A folder picked for an import (another app's library folder, or a USB stick), read the
// same way whether it came from the folder picker (Chrome, Edge, the desktop app) or a
// directory <input> (other browsers).

export interface PickedFolder {
  name: string;
  /** From the folder picker: lets a stick's music be added to the library. */
  handle?: FileSystemDirectoryHandle;
  /** A file by its path inside the folder ("a/b.txt"), matched without regard to case. */
  file(path: string): Promise<File | undefined>;
  /** The files directly in a subfolder ("" for the folder itself). */
  list(dir: string): Promise<string[]>;
}

const parts = (path: string) => path.split(/[\\/]+/).filter(Boolean);

export function fromHandle(handle: FileSystemDirectoryHandle): PickedFolder {
  const entries = async function* (dir: FileSystemDirectoryHandle) {
    for await (const e of (dir as any).values() as AsyncIterable<FileSystemHandle>) yield e;
  };
  const find = async (dir: FileSystemDirectoryHandle, name: string, kind: "file" | "directory") => {
    try {
      return kind === "file" ? await dir.getFileHandle(name) : await dir.getDirectoryHandle(name);
    } catch {
      const lower = name.toLowerCase();
      for await (const e of entries(dir)) if (e.kind === kind && e.name.toLowerCase() === lower) return e as any;
      return undefined;
    }
  };
  const dirAt = async (path: string[]) => {
    let d: FileSystemDirectoryHandle | undefined = handle;
    for (const p of path) d = d && (await find(d, p, "directory"));
    return d;
  };
  return {
    name: handle.name,
    handle,
    async file(path) {
      const p = parts(path);
      const dir = await dirAt(p.slice(0, -1));
      const f = dir && ((await find(dir, p[p.length - 1], "file")) as FileSystemFileHandle | undefined);
      return f?.getFile();
    },
    async list(path) {
      const dir = await dirAt(parts(path));
      const names: string[] = [];
      if (dir) for await (const e of entries(dir)) if (e.kind === "file") names.push(e.name);
      return names;
    },
  };
}

/** From `<input type="file" webkitdirectory>`: paths start with the folder's name. */
export function fromFileList(files: File[]): PickedFolder {
  const byPath = new Map<string, File>();
  let name = "";
  for (const f of files) {
    const p = parts((f as any).webkitRelativePath || f.name);
    name ||= p.length > 1 ? p[0] : "";
    byPath.set(p.slice(p.length > 1 ? 1 : 0).join("/").toLowerCase(), f);
  }
  return {
    name,
    async file(path) {
      return byPath.get(parts(path).join("/").toLowerCase());
    },
    async list(dir) {
      const prefix = parts(dir).join("/").toLowerCase();
      const out: string[] = [];
      for (const [p, f] of byPath) {
        const rest = prefix ? (p.startsWith(prefix + "/") ? p.slice(prefix.length + 1) : null) : p;
        if (rest !== null && !rest.includes("/")) out.push(f.name);
      }
      return out;
    },
  };
}

/** Lets the user pick a folder: the picker where there is one, else a directory input. */
export async function pickFolder(): Promise<PickedFolder | undefined> {
  const picker = (window as any).showDirectoryPicker;
  if (typeof picker === "function") {
    try {
      return fromHandle(await picker({ id: "bangermix-import", mode: "read" }));
    } catch (e) {
      if ((e as Error).name === "AbortError") return undefined;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    (input as any).webkitdirectory = true;
    input.onchange = () => resolve(input.files?.length ? fromFileList(Array.from(input.files)) : undefined);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

/** Lets the user pick one file. */
export function pickFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}
