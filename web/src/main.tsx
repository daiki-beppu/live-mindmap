import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CAPTURE_SNAPSHOT_GLOBAL } from "../../server/src/core/capture.ts";
import type { Snapshot } from "../../server/src/core/index.ts";
import { App } from "./App.tsx";
import { CaptureView } from "./CaptureView.tsx";
import "./styles.css";

// map.png の撮影では、サーバーがスナップショットをグローバル変数に入れてからこのページを開く
const captured = (globalThis as Record<string, unknown>)[CAPTURE_SNAPSHOT_GLOBAL] as Snapshot | undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>{captured ? <CaptureView snapshot={captured} /> : <App />}</StrictMode>,
);
