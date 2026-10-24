import { Array as Arr, Context, Effect, FiberSet, Layer, PubSub, Ref } from "effect";
import { Socket } from "effect/socket";
import type { CaptionsFrame, DiffUpdateFrame, IntakeFrame, ScreenNoticeFrame, SelfPauseFrame, SessionModeFrame, Snapshot, SpeakerNamesFrame, TapNoticeFrame } from "./core/index.ts";

const FEED_END = Symbol("live-mindmap/server/Viewers/end");
type Feed = string | typeof FEED_END;

type Retained = {
  readonly diffUpdate: string | undefined;
  readonly snapshot: string | undefined;
  readonly captions: string | undefined;
  readonly intake: string | undefined;
  readonly screenNotice: string | undefined;
  readonly tapNotice: string | undefined;
  readonly selfPause: string | undefined;
  readonly sessionMode: string | undefined;
  readonly speakerNames: string | undefined;
};

const NOTHING_RETAINED: Retained = { snapshot: undefined, captions: undefined, intake: undefined, screenNotice: undefined, tapNotice: undefined, diffUpdate: undefined, selfPause: undefined, sessionMode: undefined, speakerNames: undefined };

const retainedFrames = (retained: Retained): string[] => [
  ...(retained.snapshot === undefined ? [] : [retained.snapshot]),
  ...(retained.captions === undefined ? [] : [retained.captions]),
  ...(retained.intake === undefined ? [] : [retained.intake]),
  ...(retained.screenNotice === undefined ? [] : [retained.screenNotice]),
  ...(retained.tapNotice === undefined ? [] : [retained.tapNotice]),
  ...(retained.selfPause === undefined ? [] : [retained.selfPause]),
  ...(retained.diffUpdate === undefined ? [] : [retained.diffUpdate]),
  ...(retained.sessionMode === undefined ? [] : [retained.sessionMode]),
  ...(retained.speakerNames === undefined ? [] : [retained.speakerNames]),
];

export class Viewers extends Context.Service<Viewers, {
  publish: (snapshot: Snapshot) => Effect.Effect<void>;
  speak: (frame: CaptionsFrame) => Effect.Effect<void>;
  intake: (frame: IntakeFrame) => Effect.Effect<void>;
  diffUpdate: (frame: DiffUpdateFrame) => Effect.Effect<void>;
  screenNotice: (frame: ScreenNoticeFrame) => Effect.Effect<void>;
  tapNotice: (frame: TapNoticeFrame) => Effect.Effect<void>;
  selfPause: (frame: SelfPauseFrame) => Effect.Effect<void>;
  sessionMode: (frame: SessionModeFrame) => Effect.Effect<void>;
  speakerNames: (frame: SpeakerNamesFrame) => Effect.Effect<void>;
  connect: (socket: Socket.Socket) => Effect.Effect<void, Socket.SocketError>;
  drained: Effect.Effect<void>;
}>()("live-mindmap/server/Viewers") {
  static readonly layer: Layer.Layer<Viewers> = Layer.effect(Viewers)(Effect.gen(function* () {
    const retained = yield* Ref.make(NOTHING_RETAINED);
    const updates = yield* PubSub.unbounded<Feed>();
    const connections = yield* FiberSet.make();

    const send = Effect.fnUntraced(function* (data: string, retain: (current: Retained) => Retained) {
      yield* Ref.update(retained, retain);
      yield* PubSub.publish(updates, data);
    });

    const publish = (snapshot: Snapshot) => {
      const data = JSON.stringify(snapshot);
      return send(data, (current) => ({ ...current, snapshot: data }));
    };

    const speak = (frame: CaptionsFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, captions: frame.bubbles.length === 0 ? undefined : data }));
    };

    const intake = (frame: IntakeFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, intake: data }));
    };
    const diffUpdate = (frame: DiffUpdateFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, diffUpdate: data }));
    };

    const screenNotice = (frame: ScreenNoticeFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, screenNotice: frame.text === null ? undefined : data }));
    };

    const sessionMode = (frame: SessionModeFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, sessionMode: data }));
    };

    const speakerNames = (frame: SpeakerNamesFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, speakerNames: data }));
    };

    const deliver = Effect.fnUntraced(function* (subscription: PubSub.Subscription<Feed>, writer: Socket.Writer) {
      for (;;) {
        const taken = yield* PubSub.takeAll(subscription);
        const frames = taken.filter((frame): frame is string => frame !== FEED_END);
        if (Arr.isArrayNonEmpty(frames)) yield* writer.writeAll(frames);
        if (frames.length < taken.length) return;
      }
    });

    const connect = Effect.fnUntraced(function* (socket: Socket.Socket) {
      // reader を取るところで upgrade が確定する。ブラウザ向けの配信は送信だけなので、
      // pull の値は使わず、切断（pull の失敗）を知るためだけに読む
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const subscription = yield* PubSub.subscribe(updates);
      yield* Effect.withFiber((fiber) => FiberSet.add(connections, fiber));
      for (const data of retainedFrames(yield* Ref.get(retained))) yield* writer.write(data);
      return yield* Effect.raceFirst(deliver(subscription, writer), Effect.forever(reader.pull));
    }, Effect.scoped);

    const drained = Effect.andThen(PubSub.end(updates, FEED_END), FiberSet.awaitEmpty(connections));

    const tapNotice = (frame: TapNoticeFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, tapNotice: frame.text === null ? undefined : data }));
    };

    const selfPause = (frame: SelfPauseFrame) => {
      const data = JSON.stringify(frame);
      return send(data, (current) => ({ ...current, selfPause: frame.paused ? data : undefined }));
    };

    return Viewers.of({ publish, speak, intake, diffUpdate, screenNotice, tapNotice, selfPause, sessionMode, speakerNames, connect, drained });
  }));
}
