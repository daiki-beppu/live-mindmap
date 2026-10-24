import { Option } from "effect";
import { CAPTURE_SNAPSHOT_GLOBAL } from "../../server/src/core/capture.ts";
import { REVIEW_AUDIO_ELEMENT_ID, REVIEW_LOG_ELEMENT_ID, type Snapshot } from "../../server/src/core/index.ts";
import { runCapture } from "./app/capture/entry.ts";
import { runMeeting } from "./app/meeting/entry.ts";
import { runReview } from "./app/review/entry.ts";
import "./styles.css";

const captured = (globalThis as Record<string, unknown>)[CAPTURE_SNAPSHOT_GLOBAL] as Snapshot | undefined;
const reviewLog = document.getElementById(REVIEW_LOG_ELEMENT_ID)?.textContent;

// <audio src="data:…"> は WebKit で鳴らないので、Blob の URL を渡す
const reviewAudio = document.getElementById(REVIEW_AUDIO_ELEMENT_ID)?.textContent;
const audioUrl = reviewAudio == null ? undefined : URL.createObjectURL(new Blob([Uint8Array.from(atob(reviewAudio.trim()), (c) => c.charCodeAt(0))], { type: "audio/mp4" }));

const root = document.getElementById("root")!;
const isMac = navigator.userAgent.indexOf("Mac") >= 0;

if (captured) {
  runCapture({ container: root, snapshot: captured });
} else if (reviewLog != null) {
  runReview({ container: root, events: JSON.parse(reviewLog), maybeAudioUrl: Option.fromNullishOr(audioUrl), isMac });
} else {
  runMeeting({ container: root, isMac });
}
