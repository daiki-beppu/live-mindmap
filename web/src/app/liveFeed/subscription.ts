import { Clock, Effect, Option, Predicate, Queue, Result, Schema, SchemaIssue, Stream } from "effect";
import { Subscription } from "foldkit";
import type { ServerRoutes } from "../../../../server/src/serverProtocol.ts";
import { nextCaptionDeadline } from "../../captions.ts";
import type { Model } from "./main.ts";
import { LiveFrame, Message } from "./message.ts";

export const RECONNECT_MS = 1000;

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeType = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));
const decodeFrame = Schema.decodeUnknownEffect(LiveFrame);
// 接続を作り直しても、ページを読み込み直すまでは警告済みの組を保つ。
const warnedTypes = new Set<string | undefined>();

const warnUnreadableFrame = Effect.fnUntraced(function* (type: string | undefined, error: Schema.SchemaError): Effect.fn.Return<undefined> {
  if (warnedTypes.has(type)) return;
  warnedTypes.add(type);
  const paths = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map(({ path }) => {
    const keys = (path ?? []).map((segment) => String(Predicate.isObject(segment) ? segment.key : segment));
    return keys.length === 0 ? "$" : `$.${keys.join(".")}`;
  });
  yield* Effect.logWarning(`読めない画面の更新「${type === undefined ? "不明" : type}」を読み飛ばしました。server と画面の版がずれています。画面を読み込み直してください`, { paths });
  return undefined;
});

const liveFeedUrl = (): string => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${"/ws" satisfies typeof ServerRoutes.feed.path}`;

type SocketEvent = { kind: "connected" } | { kind: "frame"; data: string } | { kind: "disconnected" };

const connection: Stream.Stream<SocketEvent> = Stream.callback<SocketEvent>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const ws = new WebSocket(liveFeedUrl());
      ws.onopen = () => void Queue.offerUnsafe(queue, { kind: "connected" });
      ws.onmessage = (event) => void Queue.offerUnsafe(queue, { kind: "frame", data: String(event.data) });
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

const toMessage = (event: SocketEvent): Effect.Effect<Message | undefined> => {
  if (event.kind === "connected") return Effect.succeed(Message.ConnectedLiveFeed());
  if (event.kind === "disconnected") return Effect.succeed(Message.DisconnectedLiveFeed());
  return Effect.gen(function* () {
    const json = yield* Effect.result(decodeJson(event.data));
    if (Result.isFailure(json)) return yield* warnUnreadableFrame(undefined, json.failure);
    const type = Option.getOrUndefined(decodeType(json.success))?.type;
    return yield* decodeFrame(json.success).pipe(
      Effect.flatMap((frame) => Effect.map(Clock.currentTimeMillis, (receivedAt) => Message.ReceivedLiveFrame({ frame, receivedAt }))),
      Effect.catch((error) => warnUnreadableFrame(type, error)),
    );
  });
};

export const liveFeedStream: Stream.Stream<Message> = Stream.forever(
  Stream.concat(Stream.mapEffect(connection, toMessage).pipe(Stream.filter(Predicate.isNotUndefined)), Stream.drain(Stream.fromEffect(Effect.sleep(RECONNECT_MS)))),
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
