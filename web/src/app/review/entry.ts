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
  events: readonly unknown[];
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
