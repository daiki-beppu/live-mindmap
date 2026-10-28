import { Array as Arr, Context, Effect, FiberSet, Layer, PubSub, Ref, type Scope } from "effect";
import { Socket } from "effect/socket";
import type { ViewerFrame as ViewerFrameSchema } from "./core/index.ts";

const FEED_END = Symbol("live-mindmap/server/Viewers/end");
type Feed = string | typeof FEED_END;

export type ViewerFrame = typeof ViewerFrameSchema.Type;
export type SendFrame = (frame: ViewerFrame) => Effect.Effect<void>;

const END_FRAMES: {
  readonly [F in ViewerFrame as F["type"]]: F | "keep";
} = {
  snapshot: "keep",
  captions: { type: "captions", bubbles: [] },
  intake: { type: "intake", status: "none" },
  "screen-notice": { type: "screen-notice", text: null },
  "discussion-notice": { type: "discussion-notice", text: null },
  "tap-notice": { type: "tap-notice", text: null },
  "self-pause": { type: "self-pause", paused: false },
  "diff-update": { type: "diff-update", state: null },
  "session-mode": { type: "session-mode", local: false },
  "speaker-names": "keep",
};

const retainedFrames = (retained: ReadonlyMap<string, string>): string[] => Object.keys(END_FRAMES).flatMap((kind) => {
  const data = retained.get(kind);
  return data === undefined ? [] : [data];
});

export class Viewers extends Context.Service<Viewers, {
  forSession: Effect.Effect<SendFrame, never, Scope.Scope>;
  connect: (socket: Socket.Socket) => Effect.Effect<void, Socket.SocketError>;
  drained: Effect.Effect<void>;
}>()("live-mindmap/server/Viewers") {
  static readonly layer: Layer.Layer<Viewers> = Layer.effect(Viewers)(Effect.gen(function* () {
    const retained = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    const updates = yield* PubSub.unbounded<Feed>();
    const connections = yield* FiberSet.make();

    const send = Effect.fnUntraced(function* (frame: ViewerFrame) {
      const data = JSON.stringify(frame);
      yield* Ref.update(retained, (current) => new Map(current).set(frame.type, data));
      yield* PubSub.publish(updates, data);
    });

    const forSession = Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlySet<string>>(new Set());
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        const kinds = yield* Ref.get(sent);
        for (const [kind, frame] of Object.entries(END_FRAMES)) {
          if (kinds.has(kind) && frame !== "keep") yield* send(frame);
        }
      }));
      return Effect.fnUntraced(function* (frame: ViewerFrame) {
        yield* Ref.update(sent, (current) => new Set(current).add(frame.type));
        yield* send(frame);
      }, Effect.uninterruptible);
    });

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

    return Viewers.of({ forSession, connect, drained });
  }));
}
