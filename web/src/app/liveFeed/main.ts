// ライブの受信（Issue #828）の Foldkit のプログラムの状態と update。状態の更新の規則は web/src/liveFeed.ts（applyFrame / applyOpen / applyClose）を使う。
// Model は「無い」を Option で持ち、update の中で FeedState と移し替えて、その規則に通す
import { Option, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { DiffUpdateState, SelfPaused, SessionIntakeStatus, Snapshot } from "../../../../server/src/core/index.ts";
import { CaptionState } from "../../captions.ts";
import { applyCaptionDeadline, applyClose, applyFrame, applyOpen, createFeedState, type FeedState } from "../../liveFeed.ts";
import { Message } from "./message.ts";

export const Model = Schema.Struct({
  snapshot: Schema.Option(Snapshot),
  captions: CaptionState,
  intake: SessionIntakeStatus,
  screenNotice: Schema.Option(Schema.String),
  tapNotice: Schema.Option(Schema.String),
  diffUpdate: Schema.Option(DiffUpdateState),
  local: Schema.Boolean,
  selfPaused: SelfPaused,
  // 話者の名前の表（ラベル → 名前。Issue #1026）
  speakerNames: Schema.Record(Schema.String, Schema.String),
});
export type Model = typeof Model.Type;

const toModel = (feed: FeedState): Model => ({
  snapshot: Option.fromNullishOr(feed.snapshot),
  captions: feed.captions,
  intake: feed.intake,
  screenNotice: Option.fromNullishOr(feed.screenNotice),
  tapNotice: Option.fromNullishOr(feed.tapNotice),
  diffUpdate: Option.fromNullishOr(feed.diffUpdate),
  local: feed.local,
  selfPaused: feed.selfPaused,
  speakerNames: feed.speakerNames,
});

const toFeed = (model: Model): FeedState => ({
  snapshot: Option.getOrNull(model.snapshot),
  captions: model.captions,
  intake: model.intake,
  screenNotice: Option.getOrNull(model.screenNotice),
  tapNotice: Option.getOrNull(model.tapNotice),
  diffUpdate: Option.getOrNull(model.diffUpdate),
  local: model.local,
  selfPaused: model.selfPaused,
  speakerNames: model.speakerNames,
});

export const init = (): Model => toModel(createFeedState());

type Return = Update.Return<Model, Message>;

const apply = (model: Model, step: (feed: FeedState) => FeedState): Return => {
  const next = toModel(step(toFeed(model)));
  return {
    model: modifyFields(model, {
      snapshot: () => next.snapshot,
      captions: () => next.captions,
      intake: () => next.intake,
      screenNotice: () => next.screenNotice,
      tapNotice: () => next.tapNotice,
      diffUpdate: () => next.diffUpdate,
      local: () => next.local,
      selfPaused: () => next.selfPaused,
      speakerNames: () => next.speakerNames,
    }),
  };
};

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ConnectedLiveFeed: () => apply(model, applyOpen),
    ReceivedLiveFrame: ({ frame, receivedAt }) => apply(model, (feed) => applyFrame(feed, frame, receivedAt)),
    ReachedCaptionDeadline: ({ at }) => apply(model, (feed) => applyCaptionDeadline(feed, at)),
    DisconnectedLiveFeed: () => apply(model, applyClose),
  });
