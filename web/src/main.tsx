import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CAPTURE_SNAPSHOT_GLOBAL } from "../../server/src/core/capture.ts";
import { REVIEW_AUDIO_ELEMENT_ID, REVIEW_LOG_ELEMENT_ID, type Snapshot } from "../../server/src/core/index.ts";
import { App } from "./App.tsx";
import { CaptureView } from "./CaptureView.tsx";
import { ReviewView } from "./ReviewView.tsx";
import { PrototypeSpeakerCaptions } from "./PrototypeSpeakerCaptions.tsx";
import "./styles.css";

// map.png の撮影では、サーバーがスナップショットをグローバル変数に入れてからこのページを開く
const captured = (globalThis as Record<string, unknown>)[CAPTURE_SNAPSHOT_GLOBAL] as Snapshot | undefined;
// map.html（見返し用）には、書き出しのときにログの出来事が JSON 要素として埋め込まれる。サーバーにはつながない
const reviewLog = document.getElementById(REVIEW_LOG_ELEMENT_ID)?.textContent;

// map-audio.html には、mix した録音が base64 で埋め込まれる。開いたときに Blob にして、その URL を <audio> 1 つに渡す
// （<audio src="data:…"> は WebKit で鳴らない）
const reviewAudio = document.getElementById(REVIEW_AUDIO_ELEMENT_ID)?.textContent;
const audioUrl = reviewAudio == null ? undefined : URL.createObjectURL(new Blob([Uint8Array.from(atob(reviewAudio.trim()), (c) => c.charCodeAt(0))], { type: "audio/mp4" }));

function view() {
  // PROTOTYPE（issue #372）: 開発サーバーで ?prototype=speaker-captions のときだけ
  if (import.meta.env.DEV && new URLSearchParams(location.search).get("prototype") === "speaker-captions") return <PrototypeSpeakerCaptions />;
  if (captured) return <CaptureView snapshot={captured} />;
  if (reviewLog != null) return <ReviewView events={JSON.parse(reviewLog)} audioUrl={audioUrl} />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(<StrictMode>{view()}</StrictMode>);
