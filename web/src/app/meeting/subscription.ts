import { Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { keyPressStream } from "../keys/subscription.ts";
import * as LiveFeed from "../liveFeed/subscription.ts";
import { subscriptions as mapSurfaceSubscriptions } from "../mapSurface/subscription.ts";
import type { Model } from "./main.ts";
import { Message } from "./message.ts";

const own = Subscription.make<Model, Message>()((entry) => ({
  keys: entry(
    { hasSession: Schema.Boolean, hasSelection: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ hasSession: Option.isSome(model.session), hasSelection: Option.exists(model.session, (s) => s.mapSurface.viewing.selection !== undefined) }),
      // 張り直すのはセッションの有無が変わったときだけ。選択の有無は keydown のたびに readDependencies から読む（Issue #1133）
      keepAliveEquivalence: (a, b) => a.hasSession === b.hasSession,
      dependenciesToStream: ({ hasSession }, readDependencies) => (hasSession ? keyPressStream({ screen: "live", hasSelection: () => readDependencies().hasSelection }) : Stream.empty),
    },
  ),
}));
const feed = Subscription.lift({ liveFeed: LiveFeed.subscriptions.liveFeed, captionDeadline: LiveFeed.subscriptions.captionDeadline })<Model, Message>({
  read: (model) => Option.some(model.feed),
  toParentMessage: (message) => Message.GotLiveFeedMessage({ message }),
});
const surface = Subscription.lift({ mapSurfaceAnimationFrame: mapSurfaceSubscriptions.animationFrame, mapSurfacePointer: mapSurfaceSubscriptions.pointer })<Model, Message>({
  read: (model) => Option.flatMap(model.session, (s) => Option.map(model.feed.snapshot, (snapshot) => ({ mode: "live" as const, snapshot, speakerNames: {}, ...s.mapSurface }))),
  toParentMessage: (message) => Message.GotMapSurfaceMessage({ message }),
});
export const subscriptions = Subscription.aggregate(own, feed, surface);
