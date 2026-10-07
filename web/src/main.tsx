import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CAPTURE_SNAPSHOT_GLOBAL } from "../../server/src/core/capture.ts";
import { REVIEW_LOG_ELEMENT_ID, reviewSnapshot, type Snapshot } from "../../server/src/core/index.ts";
import { App } from "./App.tsx";
import { CaptureView } from "./CaptureView.tsx";
import { SessionView } from "./SessionView.tsx";
import "./styles.css";

// map.png の撮影では、サーバーがスナップショットをグローバル変数に入れてからこのページを開く
const captured = (globalThis as Record<string, unknown>)[CAPTURE_SNAPSHOT_GLOBAL] as Snapshot | undefined;
// map.html（見返し用）には、書き出しのときにログの出来事が JSON 要素として埋め込まれる。サーバーにはつながない
const reviewLog = document.getElementById(REVIEW_LOG_ELEMENT_ID)?.textContent;

function view() {
  if (captured) return <CaptureView snapshot={captured} />;
  // 取り込みの状態は渡さない（見返しでは、取り込みの知らせは出さない）
  if (reviewLog != null) return <SessionView snapshot={reviewSnapshot(JSON.parse(reviewLog))} speaking={{ 相手: "", 自分: "" }} />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(<StrictMode>{view()}</StrictMode>);
