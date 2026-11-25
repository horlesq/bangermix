// BangerMix as a desktop app: the web app's production build (web/dist), served from a
// private app:// origin with the same cross-origin isolation headers as the website, in
// Electron's own Chromium. So Web MIDI, WebHID, the folder picker and audio output
// selection work the same on Windows, macOS and Linux, with no browser prompts.
//
//   npm start          the build in ../web/dist (run `npm run build` in web/ first)
//   npm run dev        the Vite dev server on http://localhost:5173 instead

import { BrowserWindow, Menu, app, dialog, nativeTheme, powerSaveBlocker, protocol, screen, session, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const DEV = process.argv.includes("--dev");
const SCHEME = "app";
const ORIGIN = `${SCHEME}://bangermix`;
const START = DEV ? "http://localhost:5173/" : `${ORIGIN}/`;

/** The web build: beside the app when packaged, in the repository when not. */
const WEB_ROOT = app.isPackaged ? join(process.resourcesPath, "web") : join(import.meta.dirname, "..", "web", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".sql": "text/plain; charset=utf-8",
};

// Shared memory between the audio thread and the interface needs these, as on the web.
const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

// What the app asks for: controllers, the audio output, folders and USB sticks.
const ALLOWED = new Set([
  "midi",
  "midiSysex",
  "hid",
  "media",
  "speaker-selection",
  "fileSystem",
  "fullscreen",
  "clipboard-sanitized-write",
]);

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

// One copy at a time: two would share (and fight over) the same library database.
if (!app.requestSingleInstanceLock()) app.quit();

// Mixing goes on with the window in the background or the screen off.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let win = null;

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  nativeTheme.themeSource = "dark";
  serveWebApp();
  grantPermissions(session.defaultSession);
  setMenu();
  powerSaveBlocker.start("prevent-app-suspension");
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

function serveWebApp() {
  if (!DEV && !existsSync(join(WEB_ROOT, "index.html"))) {
    dialog.showErrorBox("BangerMix", `The web app isn't built: ${WEB_ROOT} has no index.html.\nRun "npm run build" in web/ first.`);
    app.quit();
    return;
  }
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "") path = "/index.html";
    const file = normalize(join(WEB_ROOT, path));
    if (!file.startsWith(WEB_ROOT + sep)) return new Response("Not found", { status: 404 });
    try {
      const body = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, { headers: { "Content-Type": type, ...ISOLATION } });
    } catch {
      return new Response("Not found", { status: 404, headers: ISOLATION });
    }
  });
}

function ours(url) {
  return typeof url === "string" && (url.startsWith(ORIGIN) || (DEV && url.startsWith("http://localhost:5173")));
}

function grantPermissions(ses) {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ours(details.requestingUrl) && ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => ours(origin) && ALLOWED.has(permission));
  // HID controllers once chosen stay allowed.
  ses.setDevicePermissionHandler((details) => details.deviceType === "hid" && ours(details.origin));

  // The browser's "choose a HID device" prompt: one device is taken as it is; several
  // are offered in a dialog.
  ses.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    const devices = details.deviceList ?? [];
    if (devices.length === 0) {
      dialog.showMessageBox(win, {
        type: "info",
        title: "HID controllers",
        message: "No supported HID controller found.",
        detail: "Plug it in (and switch it on), then try again.",
      });
      callback();
      return;
    }
    if (devices.length === 1) {
      callback(devices[0].deviceId);
      return;
    }
    const names = devices.map((d) => d.name || `Device ${d.vendorId.toString(16)}:${d.productId.toString(16)}`);
    dialog
      .showMessageBox(win, {
        type: "question",
        title: "HID controllers",
        message: "Which controller?",
        buttons: [...names, "Cancel"],
        cancelId: names.length,
      })
      .then(({ response }) => callback(response < devices.length ? devices[response].deviceId : undefined));
  });
}

// --- Window --------------------------------------------------------------------------

const statePath = () => join(app.getPath("userData"), "window.json");

function loadBounds() {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8"));
    // Only where a screen still is.
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width - 100 && s.x + s.width > a.x + 100 && s.y >= a.y - 20 && s.y < a.y + a.height - 100;
    });
    return onScreen ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return { width: 1600, height: 960, maximized: true };
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try {
    writeFileSync(statePath(), JSON.stringify({ ...b, maximized: win.isMaximized(), fullScreen: win.isFullScreen() }));
  } catch {
    /* not worth failing over */
  }
}

function createWindow() {
  const s = loadBounds();
  win = new BrowserWindow({
    x: s.x,
    y: s.y,
    width: s.width ?? 1600,
    height: s.height ?? 960,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: "BangerMix",
    backgroundColor: "#0d0d0d",
    icon: join(import.meta.dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
      spellcheck: false,
    },
  });
  if (s.maximized) win.maximize();
  if (s.fullScreen) win.setFullScreen(true);
  win.once("ready-to-show", () => win.show());
  win.on("close", saveBounds);
  win.on("closed", () => (win = null));

  // Links leave for the browser; the window itself stays on the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!ours(url)) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  // A few desktop keys: full screen, zoom, developer tools. Everything else is the app's.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    const wc = win.webContents;
    if (input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
    } else if (mod && (input.key === "=" || input.key === "+")) {
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4));
    } else if (mod && input.key === "-") {
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
    } else if (mod && input.key === "0") {
      wc.setZoomLevel(0);
    } else if (mod && input.shift && input.key.toLowerCase() === "i") {
      wc.toggleDevTools();
    } else return;
    event.preventDefault();
  });

  void win.loadURL(START);
}

function setMenu() {
  // Windows and Linux: no menu bar (the app has its own). macOS needs its app menu for
  // Quit, Hide and the clipboard.
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [{ role: "togglefullscreen" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }],
      },
      { role: "windowMenu" },
    ]),
  );
}
