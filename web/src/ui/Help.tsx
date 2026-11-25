import { For } from "solid-js";
import { BINDINGS } from "./keyboard";

export function Help(p: { close: () => void }) {
  return (
    <div class="modal-back" onPointerDown={p.close}>
      <div class="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <h3>Keyboard and mouse</h3>
          <button onClick={p.close}>✕</button>
        </div>
        <div class="modal-body help">
          <table>
            <tbody>
              <For each={BINDINGS.filter((b) => b.label)}>
                {(b) => (
                  <tr>
                    <td>
                      <kbd>{b.label}</kbd>
                    </td>
                    <td>{b.what}</td>
                  </tr>
                )}
              </For>
              <tr>
                <td>
                  <kbd>Shift ← / →</kbd>
                </td>
                <td>Load the selected track to deck 1 / 2</td>
              </tr>
              <tr>
                <td>
                  <kbd>Ctrl F</kbd>
                </td>
                <td>Search the library</td>
              </tr>
              <tr>
                <td>
                  <kbd>Ctrl A</kbd>
                </td>
                <td>Select every track in the list</td>
              </tr>
            </tbody>
          </table>
          <h4>Mouse</h4>
          <ul>
            <li>Knobs and faders: drag; double-click resets; scroll for steps; hold Shift for fine moves.</li>
            <li>Waveforms: drag to scratch (or nudge with vinyl mode off); scroll to zoom.</li>
            <li>Jog wheels: drag round the platter to scratch, round the outer edge to nudge.</li>
            <li>Overview: click to jump. Hot cue pads: click to set or jump, right-click to delete.</li>
            <li>Tracks: double-click to load to a free deck, or drag onto a deck or a playlist. Ctrl-click and Shift-click select several, to drag into a playlist together or right-click for all of them.</li>
            <li>Folders: drag one from the sidebar onto a playlist to add all its tracks.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
