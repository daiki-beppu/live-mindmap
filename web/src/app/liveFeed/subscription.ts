import { Clock, Effect, Option, Queue, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { nextCaptionDeadline } from "../../captions.ts";
import type { Model } from "./main.ts";
import { LiveFrame, Message } from "./message.ts";

export const RECONNECT_MS = 1000;

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(LiveFrame));

const liveFeedUrl = (): string => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

type SocketEvent = { kind: "connected" } | { kind: "frame"; frame: LiveFrame } | { kind: "disconnected" };

const connection: Stream.Stream<SocketEvent> = Stream.callback<SocketEvent>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const ws = new WebSocket(liveFeedUrl());
      ws.onopen = () => void Queue.offerUnsafe(queue, { kind: "connected" });
      ws.onmessage = (event) => {
        const frame = decodeFrame(String(event.data));
        if (Option.isSome(frame)) Queue.offerUnsafe(queue, { kind: "frame", frame: frame.value });
      };
      ws.onclose = () => {
        Queue.offerUnsafe(queue, { kind: "disconnected" });
        Queue.endUnsafe(queue);
      };
      return ws;
    }),
    (ws) =>
      Effect.sync(() => {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }),
  ),
);

const toMessage = (event: SocketEvent): Effect.Effect<Message> => {
  if (event.kind === "connected") return Effect.succeed(Message.ConnectedLiveFeed());
  if (event.kind === "disconnected") return Effect.succeed(Message.DisconnectedLiveFeed());
  return Effect.map(Clock.currentTimeMillis, (receivedAt) => Message.ReceivedLiveFrame({ frame: event.frame, receivedAt }));
};

export const liveFeedStream: Stream.Stream<Message> = Stream.forever(
  Stream.concat(Stream.mapEffect(connection, toMessage), Stream.drain(Stream.fromEffect(Effect.sleep(RECONNECT_MS)))),
);

export const captionDeadlineStream = (deadline: number | null): Stream.Stream<Message> =>
  deadline === null
    ? Stream.empty
    : Stream.fromEffect(
        Effect.gen(function* () {
          yield* Effect.sleep(Math.max(0, deadline - (yield* Clock.currentTimeMillis)));
          return Message.ReachedCaptionDeadline({ at: yield* Clock.currentTimeMillis });
        }),
      );

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  liveFeed: Subscription.persistentEntry(liveFeedStream),
  captionDeadline: entry(
    { deadline: Schema.NullOr(Schema.Finite) },
    {
      modelToDependencies: (model) => ({ deadline: nextCaptionDeadline(model.captions) ?? null }),
      dependenciesToStream: ({ deadline }) => captionDeadlineStream(deadline),
    },
  ),
}));
