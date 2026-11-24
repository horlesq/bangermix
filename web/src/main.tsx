import { render } from "solid-js/web";
import { App } from "./App";
import "./styles.css";

render(() => <App />, document.getElementById("root")!);

// Offline use once loaded (production only: in development it would cache stale code).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
