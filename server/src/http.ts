import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { WebSocket } from "ws";
import { Cause, Context, Effect, Layer, Option, Ref, Schema, Stream, type Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { NetAddress } from "effect/net";
import { SHARE_OPEN_OUTCOME_HEADER, type RecordedEvent } from "./core/index.ts";
import type { SessionFailure, SpeakerNameRejected } from "./sessionFailure.ts";
import { Sessions, type RecordedStart, type SessionStart } from "./sessions.ts";
import { Viewers } from "./viewers.ts";
import type { CloudflaredMissing } from "./tunnel.ts";
import { ViewingShare, ShareOpenFailed, ShareRefusedLocalMode, ShareScopeEmpty, type ViewingPort } from "./viewingShare.ts";
import type { TransferredModel } from "./modelSelection.ts";
import type { JudgeModel } from "./judgeSelection.ts";
import { acceptPlan, needsTransferToken, type UpdatePlan } from "./updatePlan.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { InstallDeps } from "./installDeps.ts";
import { checkManagedDeps } from "./managedDepsCheck.ts";
import { Helpers } from "./helpers.ts";
import { CheckFor, ModelRoute, CheckDepNames } from "./managedDepsProtocol.ts";
import { ServerRoutes, type SessionRecordedBody, type SessionStartBody } from "./serverProtocol.ts";
import { ReviewBuild, type ReviewPageFailed } from "./review.ts";
import { matchesModelTransferToken, MODEL_TRANSFER_HEADER } from "./modelTransferToken.ts";

class ModelTransferToken extends Context.Service<ModelTransferToken, string>()("live-mindmap/http/ModelTransferToken") {}

class ForbiddenModelTransfer extends Schema.TaggedError<ForbiddenModelTransfer>()("ForbiddenModelTransfer", {}) {
  override get message(): string {
    return "互換モデルの転送を認可できません\n同じ保存先設定の CLI から start を実行してください";
  }
}

const toSessionStart = (body: typeof SessionStartBody["Type"], plan: UpdatePlan): SessionStart => ({
  app: body.app,
  title: body.title,
  audio: body.audio,
  screen: body.screen,
  vocab: body.vocab,
  plan,
});

class ForbiddenOrigin extends Schema.TaggedError<ForbiddenOrigin>()("ForbiddenOrigin", {}) {
  override get message(): string {
    return "許可されていない Origin です";
  }
}

class UnsupportedRequest extends Schema.TaggedError<UnsupportedRequest>()("UnsupportedRequest", {
  route: Schema.String,
}) {
  override get message(): string {
    return `未対応のリクエスト: ${this.route}`;
  }
}

class InvalidBody extends Schema.TaggedError<InvalidBody>()("InvalidBody", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

type HandledFailure = SessionFailure | SpeakerNameRejected | ShareOpenFailed | ShareRefusedLocalMode | ShareScopeEmpty | CloudflaredMissing | ForbiddenOrigin | ForbiddenModelTransfer | UnsupportedRequest | InvalidBody | HttpServerError.HttpServerError;

const STATUS: { readonly [Tag in HandledFailure["_tag"]]: number } = {
  InvalidBody: 400,
  SpeakerNameRejected: 400,
  ForbiddenOrigin: 403,
  ForbiddenModelTransfer: 403,
  UnsupportedRequest: 404,
  SessionBusy: 409,
  SessionTransition: 409,
  NoSession: 409,
  IntakeNotStopped: 409,
  NotForRecordedSession: 409,
  Aborted: 503,
  RestartGaveUp: 503,
  HelperExited: 500,
  UpdaterUnavailable: 503,
  StartupDepsMissing: 503,
  ManagedDepsFailed: 500,
  ShareOpenFailed: 500,
  ShareRefusedLocalMode: 409,
  ShareScopeEmpty: 400,
  CloudflaredMissing: 503,
  HttpServerError: 500,
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalOrigin(origin: string): boolean {
  return URL.canParse(origin) && LOCAL_HOSTNAMES.has(new URL(origin).hostname);
}

const routeOf = (request: HttpServerRequest.HttpServerRequest): string =>
  `${request.method} ${new URL(request.url, "http://127.0.0.1").pathname}`;

// 127.0.0.1 で待ち受けても、ブラウザ上の任意の Web ページからは接続できてしまう。Origin がローカルのものだけ受理する。
const OriginRestriction = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const { origin } = (yield* HttpServerRequest.HttpServerRequest).headers;
    if (origin !== undefined && !isLocalOrigin(origin)) return yield* new ForbiddenOrigin();
    return yield* httpEffect;
  }), { global: true });

const acceptBodyPlan = Effect.fnUntraced(function* (body: { readonly model?: typeof TransferredModel["Type"]; readonly judge?: JudgeModel }) {
  const result = acceptPlan(body);
  if (!result.ok) return yield* new InvalidBody({ detail: result.lines.join("\n") });
  if (needsTransferToken(result.plan)) {
    const token = yield* ModelTransferToken;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!matchesModelTransferToken(token, request.headers[MODEL_TRANSFER_HEADER])) return yield* new ForbiddenModelTransfer();
  }
  return result.plan;
});

const bodyOf = <A, RD>(schema: Schema.ConstraintDecoder<A, RD>, options?: Parameters<typeof HttpServerRequest.schemaBodyJson>[1]) =>
  HttpServerRequest.schemaBodyJson(schema, options).pipe(Effect.mapError((failure) => new InvalidBody({ detail: failure.message })));

const jsonOf = <A>(schema: Schema.ConstraintCodec<A, unknown, unknown, never>) => {
  const encode = HttpServerResponse.schemaJson(schema);
  return (body: A, options?: Parameters<typeof encode>[1]) => encode(body, options).pipe(Effect.orDie);
};

const acceptedBody = Effect.fnUntraced(function* <A extends { readonly model?: typeof TransferredModel["Type"]; readonly judge?: JudgeModel }, R>(
  decode: Effect.Effect<A, InvalidBody, R>,
) {
  const body = yield* decode;
  return { body, plan: yield* acceptBodyPlan(body) };
});

const startSession = Effect.gen(function* () {
  const { body, plan } = yield* acceptedBody(bodyOf(ServerRoutes.sessionStart.body));
  const sessions = yield* Sessions;
  return yield* jsonOf(ServerRoutes.sessionStart.response)(yield* sessions.start(toSessionStart(body, plan)));
});

const startRecordedSession = Effect.gen(function* () {
  const body = yield* bodyOf(ServerRoutes.sessionRecorded.body);
  if (body.noMap === true && (body.model !== undefined || body.judge !== undefined || body.realtime)) {
    return yield* new InvalidBody({ detail: "noMap と model・judge・realtime は併用できません" });
  }
  const mode = body.noMap === true
    ? { noMap: true as const }
    : { plan: yield* acceptBodyPlan(body) };
  const sessions = yield* Sessions;
  const input: RecordedStart = { file: body.file, ...(body.selfFile === undefined ? {} : { selfFile: body.selfFile }), title: body.title, vocab: body.vocab, realtime: body.realtime, ...mode };
  const { dir, warnings, events } = yield* sessions.startRecorded(input);
  return HttpServerResponse.stream(
    Stream.concat(Stream.succeed<RecordedEvent>({ type: "started", dir, warnings }), events).pipe(
      Stream.map((event) => JSON.stringify(event) + "\n"),
      Stream.encodeText,
    ),
    { contentType: "application/x-ndjson" },
  );
});

const feed = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const viewers = yield* Viewers;
  const socket = yield* request.upgrade.pipe(
    Effect.mapError(() => new UnsupportedRequest({ route: routeOf(request) })),
  );
  yield* viewers.connect(socket).pipe(Effect.ignore({ log: "Debug", message: "閲覧の WebSocket が切れた" }));
  return HttpServerResponse.empty();
});

const SessionRoutes = HttpRouter.addAll([
  HttpRouter.route(ServerRoutes.apps.method, ServerRoutes.apps.path, Effect.gen(function* () {
    const sessions = yield* Sessions;
    return yield* jsonOf(ServerRoutes.apps.response)(yield* sessions.apps);
  })),
  HttpRouter.route(ServerRoutes.sessionStart.method, ServerRoutes.sessionStart.path, startSession),
  HttpRouter.route(ServerRoutes.sessionRecorded.method, ServerRoutes.sessionRecorded.path, startRecordedSession),
  HttpRouter.route(ServerRoutes.sessionStop.method, ServerRoutes.sessionStop.path, Effect.gen(function* () {
    const sessions = yield* Sessions;
    return yield* jsonOf(ServerRoutes.sessionStop.response)(yield* sessions.stop);
  })),
  HttpRouter.route(ServerRoutes.sessionStatus.method, ServerRoutes.sessionStatus.path, Effect.gen(function* () {
    const sessions = yield* Sessions;
    return yield* jsonOf(ServerRoutes.sessionStatus.response)(yield* sessions.status);
  })),
  HttpRouter.route(ServerRoutes.sessionResume.method, ServerRoutes.sessionResume.path, Effect.gen(function* () {
    const sessions = yield* Sessions;
    return yield* jsonOf(ServerRoutes.sessionResume.response)(yield* sessions.resume);
  })),
  HttpRouter.route(ServerRoutes.sessionSelfPause.method, ServerRoutes.sessionSelfPause.path, Effect.gen(function* () {
    const body = yield* bodyOf(ServerRoutes.sessionSelfPause.body, { onExcessProperty: "error" });
    const sessions = yield* Sessions;
    yield* sessions.setSelfPause(body.paused);
    return HttpServerResponse.empty({ status: 204 });
  })),
  HttpRouter.route(ServerRoutes.sessionSpeakerName.method, ServerRoutes.sessionSpeakerName.path, Effect.gen(function* () {
    const body = yield* bodyOf(ServerRoutes.sessionSpeakerName.body, { onExcessProperty: "error" });
    const sessions = yield* Sessions;
    yield* sessions.setSpeakerName(body);
    return HttpServerResponse.empty({ status: 204 });
  })),
  HttpRouter.route(ServerRoutes.shareOpen.method, ServerRoutes.shareOpen.path, Effect.gen(function* () {
    const body = yield* bodyOf(ServerRoutes.shareOpen.body, { onExcessProperty: "error" });
    const share = yield* ViewingShare;
    const { outcome, status } = yield* share.open("anyone" in body ? "anyone" : "mails" in body ? { mails: body.mails } : undefined);
    return yield* jsonOf(ServerRoutes.shareOpen.response)(status, { headers: { [SHARE_OPEN_OUTCOME_HEADER]: outcome } });
  })),
  HttpRouter.route(ServerRoutes.shareClose.method, ServerRoutes.shareClose.path, Effect.gen(function* () {
    const share = yield* ViewingShare;
    yield* share.close;
    return yield* jsonOf(ServerRoutes.shareClose.response)(yield* share.status);
  })),
  HttpRouter.route(ServerRoutes.shareStatus.method, ServerRoutes.shareStatus.path, Effect.gen(function* () {
    const share = yield* ViewingShare;
    return yield* jsonOf(ServerRoutes.shareStatus.response)(yield* share.status);
  })),
]);

const ServerIdentityRoutes = HttpRouter.addAll([
  HttpRouter.route(ServerRoutes.server.method, ServerRoutes.server.path, Effect.suspend(() => jsonOf(ServerRoutes.server.response)({ pid: process.pid }))),
]);

const FeedRoutes = HttpRouter.addAll([
  HttpRouter.route(ServerRoutes.feed.method, ServerRoutes.feed.path, feed),
  HttpRouter.route("GET", "/", feed),
]);

const depResponse = Effect.fnUntraced(function* <E>(source: Stream.Stream<typeof ServerRoutes.depsInstall.response.Type, E>) {
  const sessions = yield* Sessions;
  return HttpServerResponse.stream(Stream.unwrap(Effect.gen(function* () {
    yield* sessions.reserveDeps;
    return source;
  })).pipe(
    Stream.catchCauseIf((cause) => !Cause.hasInterrupts(cause), (cause) =>
      Stream.succeed({ type: "error" as const, message: failureMessage(Cause.squash(cause)) })),
    Stream.map((event) => JSON.stringify(event) + "\n"),
    Stream.encodeText,
  ), { contentType: "application/x-ndjson" });
});

const DepRoutes = HttpRouter.addAll([
  HttpRouter.route(ServerRoutes.check.method, ServerRoutes.check.path, Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = new URL(request.url, "http://127.0.0.1").searchParams;
    const entry = yield* Schema.decodeUnknownEffect(CheckFor)(params.get("for") ?? "start").pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const respondCheck = jsonOf(ServerRoutes.check.response);
    if (entry === "resume") return yield* respondCheck(yield* (yield* Sessions).checkResume);
    const route = yield* Schema.decodeUnknownEffect(ModelRoute)(params.get("route") ?? "claude").pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    if (entry === "play") return yield* respondCheck(yield* checkManagedDeps(entry, route));
    const screen = yield* Schema.decodeUnknownEffect(Schema.Literals(["true", "false"]))(params.get("screen") ?? "true").pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const helpers = yield* Helpers;
    return yield* respondCheck(yield* checkManagedDeps(entry, route, { screen: screen === "true", check: screen === "true" ? helpers.check : helpers.checkNoScreen }));
  })),
  HttpRouter.route(ServerRoutes.depsCheck.method, ServerRoutes.depsCheck.path, Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = new URL(request.url, "http://127.0.0.1").searchParams.get("names");
    const names = yield* Schema.decodeUnknownEffect(CheckDepNames)(raw === null ? [] : raw.split(",")).pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const deps = yield* ManagedDeps;
    return yield* jsonOf(ServerRoutes.depsCheck.response)(yield* deps.check(names).pipe(Effect.orDie));
  })),
  HttpRouter.route(ServerRoutes.depsInstall.method, ServerRoutes.depsInstall.path, Effect.gen(function* () {
    const body = yield* bodyOf(ServerRoutes.depsInstall.body);
    const deps = yield* InstallDeps;
    return yield* depResponse(deps.install(body.names));
  })),
  HttpRouter.route(ServerRoutes.update.method, ServerRoutes.update.path, Effect.gen(function* () {
    const body = yield* bodyOf(ServerRoutes.update.body);
    const deps = yield* ManagedDeps;
    return yield* depResponse(deps.update(body.names));
  })),
]);

const UnsupportedRoute = HttpRouter.addAll([
  HttpRouter.route("*", "*", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* new UnsupportedRequest({ route: routeOf(request) });
  })),
]);

const failureMessage = (value: unknown): string => (value instanceof Error ? value.message : String(value));

const respond = <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, HandledFailure, R>) =>
  Effect.catchCauseIf(
    handler,
    (cause) => !Cause.hasInterrupts(cause),
    (cause) =>
      Effect.gen(function* () {
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
        if (failure !== undefined) {
          if (failure._tag === "StartupDepsMissing") {
            return HttpServerResponse.jsonUnsafe({ _tag: failure._tag, items: failure.items, error: failure.message }, { status: STATUS[failure._tag] });
          }
          return HttpServerResponse.jsonUnsafe({ error: failure.message }, { status: STATUS[failure._tag] });
        }
        const [response] = yield* HttpServerError.causeResponse(cause);
        return HttpServerResponse.jsonUnsafe({ error: failureMessage(Cause.squash(cause)) }, { status: response.status });
      }),
  );

export const portOf = (address: NetAddress.SocketAddress): Effect.Effect<number> =>
  address._tag === "UnixPathAddress" ? Effect.die(new Error("TCP のポートで待ち受けていない")) : Effect.succeed(address.port);

// close フレームを送った接続が応答しない場合、ws の既定（CLOSE_TIMEOUT）は 30,000ms 待ってから
// raw socket を切断する。これは終了処理にとって実質無期限で、応答しない接続が 1 本でもあると
// close() の所要時間がその接続に縛られる（ISSUE-2）。
export const WS_CLOSE_TIMEOUT_MS = Context.Reference("live-mindmap/WsCloseTimeoutMs", { defaultValue: (): number => 3_000 });

// /ws の配信への ping の間隔の既定（ms）。tunnel の無通信の切断より十分短い
export const FEED_PING_INTERVAL_MS = 30_000;

// effect の Socket は制御フレームを送る手段を持たず、生の ws に手が届くのは WebSocketServer の WebSocket オプションだけなので、
// ws の WebSocket を継承して ping を差し込む。
const pingingWebSocket = (intervalMs: number) =>
  class PingingWebSocket extends WebSocket {
    readonly #pinger = (() => {
      const timer = setInterval(() => {
        if (this.readyState === WebSocket.OPEN) this.ping();
      }, intervalMs);
      timer.unref();
      this.once("close", () => clearInterval(timer));
      return timer;
    })();
  };

// @types/ws@8.18 の ServerOptions は closeTimeout を宣言していないが、ws@8.22 のランタイムは
// WebSocketServer のオプションとしてそのまま受け取り、各サーバー側 WebSocket の _closeTimeout へ伝える
// （ws/lib/websocket-server.js の completeUpgrade → new this.options.WebSocket(...) で options ごと渡る）。
const websocketOptions = (pingIntervalMs: number, closeTimeoutMs: number) =>
  ({ closeTimeout: closeTimeoutMs, WebSocket: pingingWebSocket(pingIntervalMs) }) as NodeHttpServer.Options["websocket"];

// disablePreemptiveShutdown: Scope を閉じたら、まず要求の処理を止めて接続中の Fiber を終わらせ、
// その後に待受けを閉じる。既定の猶予つき停止は、接続が残っている間 20 秒待ってから諦めるため、
// 終了が 20 秒遅れる
const layerNodeServer = (port: number, pingIntervalMs: number) =>
  Layer.unwrap(
    Effect.map(WS_CLOSE_TIMEOUT_MS, (closeTimeoutMs) =>
      NodeHttpServer.layer(createServer, { port, host: "127.0.0.1", disablePreemptiveShutdown: true, websocket: websocketOptions(pingIntervalMs, closeTimeoutMs) })),
  );

export const layerListener = (port: number, pingIntervalMs: number = FEED_PING_INTERVAL_MS): Layer.Layer<Viewers | HttpServer.HttpServer, HttpServerError.ServeError> =>
  Layer.mergeAll(Viewers.layer, layerNodeServer(port, pingIntervalMs));

export const openListener = (port: number, pingIntervalMs: number = FEED_PING_INTERVAL_MS) => Layer.build(layerListener(port, pingIntervalMs));

export const serveFeed: Effect.Effect<void, never, HttpServer.HttpServer | Viewers | Scope.Scope> = Effect.flatMap(
  HttpRouter.toHttpEffect(Layer.mergeAll(FeedRoutes, UnsupportedRoute, OriginRestriction)),
  (handler) => HttpServer.serveEffect(respond(handler)),
);

export const serveSessions = (token: string): Effect.Effect<void, never, HttpServer.HttpServer | Sessions | ViewingShare | Helpers | ManagedDeps | InstallDeps | Viewers | Scope.Scope> => Effect.flatMap(
  HttpRouter.toHttpEffect(Layer.mergeAll(SessionRoutes, ServerIdentityRoutes, DepRoutes, FeedRoutes, UnsupportedRoute, OriginRestriction)),
  (handler) => HttpServer.serveEffect(respond(handler)),
).pipe(Effect.provideService(ModelTransferToken, token));

export const openViewingPort = (pingIntervalMs: number = FEED_PING_INTERVAL_MS): Effect.Effect<ViewingPort, HttpServerError.ServeError | ReviewPageFailed, Viewers | ReviewBuild | Scope.Scope> =>
  Effect.gen(function* () {
    const { build } = yield* ReviewBuild;
    const page = yield* build;
    const allowed = yield* Ref.make<string | undefined>(undefined);
    const OriginCheck = HttpRouter.middleware((httpEffect) =>
      Effect.gen(function* () {
        const { origin } = (yield* HttpServerRequest.HttpServerRequest).headers;
        if (origin !== undefined && origin !== (yield* Ref.get(allowed))) return yield* new ForbiddenOrigin();
        return yield* httpEffect;
      }), { global: true });
    const routes = HttpRouter.addAll([
      HttpRouter.route("GET", "/ws", Effect.gen(function* () {
        const { origin } = (yield* HttpServerRequest.HttpServerRequest).headers;
        if (origin === undefined || origin !== (yield* Ref.get(allowed))) return yield* new ForbiddenOrigin();
        return yield* feed;
      })),
      HttpRouter.route("GET", "/", Effect.succeed(HttpServerResponse.text(page, { contentType: "text/html; charset=utf-8" }))),
    ]);
    const context = yield* Layer.build(layerNodeServer(0, pingIntervalMs));
    const handler = yield* HttpRouter.toHttpEffect(Layer.mergeAll(routes, UnsupportedRoute, OriginCheck));
    yield* HttpServer.serveEffect(respond(handler)).pipe(Effect.provide(context));
    const port = yield* portOf(Context.get(context, HttpServer.HttpServer).address);
    return { port, allow: (hostname: string) => Ref.set(allowed, `https://${hostname}`) };
  });
