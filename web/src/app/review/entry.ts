// 見返しの入口（Issue #826）: map.html・map-audio.html の見返しを Foldkit の Runtime で #root に描く。
// 起動時に決まる値（ログの出来事・録音の URL・Mac かどうか）を受けて Context を作り、開いた時点の幅は Flags で init へ渡す。Model・update・view・Subscription をつなぐ。
// freezeModel は切らない（既定のまま）
import { Option } from "effect";
import { Runtime } from "foldkit";
import { Flags, readFlags } from "../startFlags.ts";
import { makeContext } from "./context.ts";
import { init, makeUpdate, makeView, Model } from "./main.ts";
import { makeSubscriptions } from "./subscription.ts";

const TITLE = "live-mindmap";
const ROOT_ID = "root";

export type ReviewInput = {
  container: HTMLElement;
  // ログの出来事（map.html に埋め込んだ JSON を読み戻したもの）
  events: readonly unknown[];
  // 録音つき（map-audio.html）なら、Blob の URL。<audio> 1 つに渡す
  maybeAudioUrl: Option.Option<string>;
  isMac: boolean;
};

export const runReview = ({ container, events, maybeAudioUrl, isMac }: ReviewInput): void => {
  const context = makeContext(events, { isMac, maybeAudioUrl });
  const view = makeView(context);
  Runtime.run(
    Runtime.makeApplication({
      Model,
      Flags,
      init: (startFlags) => ({ model: init(context, startFlags) }),
      update: makeUpdate(context),
      // Application は container の要素を view の根で置き換えるので、#root（styles.css が高さ 100% にする）を根として描く
      view: (model, h) => ({ title: TITLE, body: h.div([h.Id(ROOT_ID)], [view(model, h)]) }),
      subscriptions: makeSubscriptions(context),
      container,
    }),
    { flags: readFlags },
  );
};
