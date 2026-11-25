// Dragging tracks from the browser (or files from the desktop) onto a deck.

import type { Deck } from "../state/deck";
import { addDropped, trackById } from "../state/library";

export const TRACK_MIME = "application/x-bangermix-track";
/** A library folder dragged from the sidebar (onto a playlist). */
export const FOLDER_MIME = "application/x-bangermix-folder";

export function dragLoad(d: Deck) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (e.dataTransfer.types.includes(TRACK_MIME) || e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    },
    onDrop: async (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      // Several dragged tracks: the deck takes the first.
      const id = e.dataTransfer.getData(TRACK_MIME).split("\n")[0];
      if (id) {
        const t = trackById(id);
        if (t) void d.load(t);
        return;
      }
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      await addDropped(files);
      const first = files[0];
      const t = trackById(`drop:${first.name}:${first.size}`);
      if (t) void d.load(t);
    },
  };
}
