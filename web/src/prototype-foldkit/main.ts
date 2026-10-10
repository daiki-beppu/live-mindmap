// 試作（Issue #736）: Foldkit 版の見返しの入口。map.html・map-audio.html と同じ埋め込み（ログの JSON 要素・base64 の音声）を読む
import { Runtime } from "foldkit";
import { REVIEW_AUDIO_ELEMENT_ID, REVIEW_LOG_ELEMENT_ID } from "../../../server/src/core/index.ts";
import "../styles.css";
import "./prototype.css";
import { makeSubscriptions } from "./effects.ts";
import { initModel, makeContext, ModelSchema } from "./model.ts";
import { makeUpdate } from "./update.ts";
import { makeView } from "./view.ts";

const log = document.getElementById(REVIEW_LOG_ELEMENT_ID)?.textContent;
const audio = document.getElementById(REVIEW_AUDIO_ELEMENT_ID)?.textContent;
// <audio src="data:…"> は WebKit で鳴らないので Blob の URL にする（今の main.tsx と同じ）
const audioUrl = audio == null ? undefined : URL.createObjectURL(new Blob([Uint8Array.from(atob(audio.trim()), (c) => c.charCodeAt(0))], { type: "audio/mp4" }));
const ctx = makeContext(log == null ? [] : JSON.parse(log), audioUrl !== undefined, /Mac|iPhone|iPad/.test(navigator.userAgent));

// 試作の見比べ用: 最新の Model を DevTools から読めるように置く（globalThis.__foldkitModel）
const update = makeUpdate(ctx);
const inspect: typeof update = (model, message) => {
  const out = update(model, message);
  (globalThis as Record<string, unknown>).__foldkitModel = out.model;
  return out;
};

Runtime.run(
  Runtime.makeApplication({
    Model: ModelSchema,
    init: () => ({ model: initModel(ctx) }),
    update: inspect,
    view: makeView(ctx, audioUrl),
    subscriptions: makeSubscriptions(ctx.audio),
    container: document.getElementById("root")!,
    freezeModel: false,
  }),
);
