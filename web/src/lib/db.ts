// A small promise wrapper over IndexedDB, where the library lives.
//
// Stores: tracks (TrackRec by id), waveforms (Uint8Array by track id), art (Blob by
// track id), folders (FolderRec by id), playlists (PlaylistRec by id).

const NAME = "bangermix";
const VERSION = 1;
export type StoreName = "tracks" | "waveforms" | "art" | "folders" | "playlists";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("tracks", { keyPath: "id" });
      db.createObjectStore("waveforms");
      db.createObjectStore("art");
      db.createObjectStore("folders", { keyPath: "id" });
      db.createObjectStore("playlists", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await open();
  await wrap(db.transaction(store, "readwrite").objectStore(store).put(value, key));
}

/** Writes many records in one transaction. */
export async function putMany(store: StoreName, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  const s = tx.objectStore(store);
  for (const v of values) s.put(v);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function del(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await open();
  await wrap(db.transaction(store, "readwrite").objectStore(store).delete(key));
}
