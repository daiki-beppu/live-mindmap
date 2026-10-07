import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CAPTURE_SNAPSHOT_GLOBAL } from "../../server/src/core/capture.ts";
import { REVIEW_LOG_ELEMENT_ID, type Snapshot } from "../../server/src/core/index.ts";
import { App } from "./App.tsx";
import { CaptureView } from "./CaptureView.tsx";
import { ReviewView } from "./ReviewView.tsx";
import "./styles.css";

// map.png の撮影では、サーバーがスナップショットをグローバル変数に入れてからこのページを開く
const captured = (globalThis as Record<string, unknown>)[CAPTURE_SNAPSHOT_GLOBAL] as Snapshot | undefined;
// map.html（見返し用）には、書き出しのときにログの出来事が JSON 要素として埋め込まれる。サーバーにはつながない
const reviewLog = document.getElementById(REVIEW_LOG_ELEMENT_ID)?.textContent;

function view() {
  if (captured) return <CaptureView snapshot={captured} />;
  if (reviewLog != null) return <ReviewView events={JSON.parse(reviewLog)} />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(<StrictMode>{view()}</StrictMode>);
