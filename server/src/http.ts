import { Cause, Context, Effect, Layer, Schema, Stream, type Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SHARE_OPEN_OUTCOME_HEADER, type RecordedEvent } from "./core/index.ts";
import type { SessionFailure, SpeakerNameRejected } from "./sessionFailure.ts";
import { Sessions, type RecordedStart, type SessionStart } from "./sessions.ts";
import { Viewers } from "./viewers.ts";
import type { CloudflaredMissing } from "./tunnel.ts";
import { ViewingShare, ShareOpenFailed, ShareRefusedLocalMode, ShareScopeEmpty } from "./viewingShare.ts";
import { BASE_STATUS, FEED_PING_INTERVAL_MS, ForbiddenOrigin, UnsupportedRoute, failureMessage, feed, layerNodeServer, respondWith, type BaseFailure, type StatusTable } from "./httpServing.ts";
import type { TransferredModel } from "./modelSelection.ts";
import type { JudgeModel } from "./judgeSelection.ts";
import { acceptPlan, needsTransferToken, type UpdatePlan } from "./updatePlan.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { InstallDeps } from "./installDeps.ts";
import { checkManagedDeps } from "./managedDepsCheck.ts";
import { Helpers } from "./helpers.ts";
import { CheckFor, ModelRoute, CheckDepNames } from "./managedDepsProtocol.ts";
import { ServerRoutes, type SessionRecordedBody, type SessionStartBody } from "./serverProtocol.ts";
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

class InvalidBody extends Schema.TaggedError<InvalidBody>()("InvalidBody", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

type HandledFailure = SessionFailure | SpeakerNameRejected | ShareOpenFailed | ShareRefusedLocalMode | ShareScopeEmpty | CloudflaredMissing | ForbiddenModelTransfer | InvalidBody | BaseFailure;

const STATUS: StatusTable<HandledFailure> = {
  ...BASE_STATUS,
  InvalidBody: 400,
  SpeakerNameRejected: 400,
  ForbiddenModelTransfer: 403,
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
};

const respond = respondWith(STATUS, (failure) =>
  failure._tag === "StartupDepsMissing" ? { _tag: failure._tag, items: failure.items, error: failure.message } : { error: failure.message });

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalOrigin(origin: string): boolean {
  return URL.canParse(origin) && LOCAL_HOSTNAMES.has(new URL(origin).hostname);
}

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
    return yield* respondCheck(yield* checkManagedDeps(entry, route, { screen: screen === "true", check: helpers.check({ screen: screen === "true" }) }));
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
