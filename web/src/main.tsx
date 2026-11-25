import { render } from "solid-js/web";
import { App } from "./App";
import { desktop } from "./lib/platform";
import "./styles.css";

render(() => <App />, document.getElementById("root")!);

// Offline use once loaded (production only: in development it would cache stale code).
// The desktop app has its files on disk already.
if (import.meta.env.PROD && !desktop && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
