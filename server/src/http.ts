// ブラウザと CLI からの受け口（ADR 0009）。ルート・本文の Schema・Origin の制限・
// タグ付きの失敗からステータスへの対応表・失敗から応答への変換を、この 1 か所に置く。
//   GET  /apps            ヘルパーの `list` の結果（会議アプリの一覧）を返す
//   POST /session/start   { app, title?, audio?, screen? } でセッションを開始する
//   POST /session/stop    セッションを終了し、書き出したパスを返す
//   GET  /session/status  取り込みの状態を返す
//   POST /session/resume  止まった状態から起動し直す
//   GET  /・/ws           ブラウザへの配信（同じポートで upgrade する）
// セッションの操作は sessions.ts の Sessions から受け取り、server.ts の実装は読み込まない（循環依存を作らない）。
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Context, Effect, Layer, Option, Schema, Stream, type Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { NetAddress } from "effect/net";
import type { SessionFailure } from "./sessionFailure.ts";
import { Sessions, type SessionStart } from "./sessions.ts";
import { Viewers } from "./viewers.ts";
import { acceptTransferredModel, defaultClaude, TransferredModel } from "./modelSelection.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { checkManagedDeps } from "./managedDepsCheck.ts";
import { DepNames, InstallBody } from "./managedDepsProtocol.ts";
import { matchesModelTransferToken, MODEL_TRANSFER_HEADER } from "./modelTransferToken.ts";

class ModelTransferToken extends Context.Service<ModelTransferToken, string>()("live-mindmap/http/ModelTransferToken") {}

class ForbiddenModelTransfer extends Schema.TaggedError<ForbiddenModelTransfer>()("ForbiddenModelTransfer", {}) {
  override get message(): string {
    return "互換モデルの転送を認可できません\n同じ保存先設定の CLI から start を実行してください";
  }
}

// /session/start の本文。app は空でない文字列、title は文字列か null か無し、audio・screen は真偽値か null か無し（screen の省略と null は true）。
// trim・形式・長さの制限は足さない（空白だけの app も、今まで通り受理する）
const SessionStartBody = Schema.Struct({
  app: Schema.NonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  audio: Schema.optional(Schema.NullOr(Schema.Boolean)),
  screen: Schema.optional(Schema.NullOr(Schema.Boolean)),
  model: Schema.optionalKey(TransferredModel),
});

const toSessionStart = (body: typeof SessionStartBody["Type"], model: SessionStart["model"]): SessionStart => ({
  app: body.app,
  title: body.title ?? undefined,
  audio: body.audio ?? true,
  screen: body.screen ?? true,
  model,
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

// 本文の検証に落ちた。文面は Schema（または本文の読み取り）の既定のもの
class InvalidBody extends Schema.TaggedError<InvalidBody>()("InvalidBody", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

// タグ付きの失敗からステータスへの対応。タグが増えたら、ここに足すまで型エラーになる。
// HttpServerError は、上のルート・本文の変換で拾いきれなかったサーバー側の失敗（応答の書き出し等）
type HandledFailure = SessionFailure | ForbiddenOrigin | ForbiddenModelTransfer | UnsupportedRequest | InvalidBody | HttpServerError.HttpServerError;

const STATUS: { readonly [Tag in HandledFailure["_tag"]]: number } = {
  InvalidBody: 400,
  ForbiddenOrigin: 403,
  ForbiddenModelTransfer: 403,
  UnsupportedRequest: 404,
  SessionBusy: 409,
  SessionTransition: 409,
  NoSession: 409,
  IntakeNotStopped: 409,
  Aborted: 503,
  RestartGaveUp: 503,
  HelperExited: 500,
  UpdaterUnavailable: 503,
  HttpServerError: 500,
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalOrigin(origin: string): boolean {
  return URL.canParse(origin) && LOCAL_HOSTNAMES.has(new URL(origin).hostname);
}

const routeOf = (request: HttpServerRequest.HttpServerRequest): string =>
  `${request.method} ${new URL(request.url, "http://127.0.0.1").pathname}`;

// 127.0.0.1 で待ち受けても、ブラウザ上の任意の Web ページからは接続できてしまう。Origin がローカルのものだけ受理する。
// HTTP と `/`・`/ws` の upgrade の両方に掛ける 1 つのミドルウェア。操作にも upgrade にも進む前に断る
const OriginRestriction = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const { origin } = (yield* HttpServerRequest.HttpServerRequest).headers;
    if (origin !== undefined && !isLocalOrigin(origin)) return yield* new ForbiddenOrigin();
    return yield* httpEffect;
  }), { global: true });

const startSession = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(SessionStartBody).pipe(
    Effect.mapError((failure) => new InvalidBody({ detail: failure.message })),
  );
  const result = acceptTransferredModel(body.model ?? defaultClaude);
  if (!result.ok) return yield* new InvalidBody({ detail: result.lines.join("\n") });
  if (body.model?.route === "openai-compatible" || body.model?.route === "chatgpt") {
    const token = yield* ModelTransferToken;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!matchesModelTransferToken(token, request.headers[MODEL_TRANSFER_HEADER])) return yield* new ForbiddenModelTransfer();
  }
  const sessions = yield* Sessions;
  return HttpServerResponse.jsonUnsafe(yield* sessions.start(toSessionStart(body, result.model)));
});

// ブラウザへの配信。`/ws`（ブラウザ）と `/`（既存のテスト・Vite の proxy の書き換え先）を同じ Viewers で受ける。
// upgrade ではないリクエストは、ルートが無いのと同じ扱いにする
const feed = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const viewers = yield* Viewers;
  const socket = yield* request.upgrade.pipe(
    Effect.mapError(() => new UnsupportedRequest({ route: routeOf(request) })),
  );
  // 切断は配信の終わりで、応答に変える失敗ではない（upgrade 済みなので HTTP の本文は書かれない）
  yield* viewers.connect(socket).pipe(Effect.ignore);
  return HttpServerResponse.empty();
});

const SessionRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", "/apps", Effect.gen(function* () {
    const sessions = yield* Sessions;
    return HttpServerResponse.jsonUnsafe(yield* sessions.apps);
  })),
  HttpRouter.route("POST", "/session/start", startSession),
  HttpRouter.route("POST", "/session/stop", Effect.gen(function* () {
    const sessions = yield* Sessions;
    return HttpServerResponse.jsonUnsafe(yield* sessions.stop);
  })),
  HttpRouter.route("GET", "/session/status", Effect.gen(function* () {
    const sessions = yield* Sessions;
    return HttpServerResponse.jsonUnsafe(yield* sessions.status);
  })),
  HttpRouter.route("POST", "/session/resume", Effect.gen(function* () {
    const sessions = yield* Sessions;
    yield* sessions.resume;
    return HttpServerResponse.jsonUnsafe({});
  })),
]);

const FeedRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", "/ws", feed),
  HttpRouter.route("GET", "/", feed),
]);

const DepRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", "/check", checkManagedDeps.pipe(
    Effect.orDie,
    Effect.map(HttpServerResponse.jsonUnsafe),
  )),
  HttpRouter.route("GET", "/deps/check", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = new URL(request.url, "http://127.0.0.1").searchParams.get("names");
    const names = yield* Schema.decodeUnknownEffect(DepNames)(raw === null ? [] : raw.split(",")).pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const deps = yield* ManagedDeps;
    return HttpServerResponse.jsonUnsafe(yield* deps.check(names).pipe(Effect.orDie));
  })),
  HttpRouter.route("POST", "/deps/install", Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(InstallBody).pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const deps = yield* ManagedDeps;
    const events = deps.install(body.names).pipe(
      Stream.catchCauseIf((cause) => !Cause.hasInterrupts(cause), (cause) =>
        Stream.succeed({ type: "error" as const, message: failureMessage(Cause.squash(cause)) })),
      Stream.map((event) => JSON.stringify(event) + "\n"),
      Stream.encodeText,
    );
    return HttpServerResponse.stream(events, { contentType: "application/x-ndjson" });
  })),
]);

// どのルートにも当たらなかったときの応答。ルートが無い場合の文面を 1 か所で持つ
const UnsupportedRoute = HttpRouter.addAll([
  HttpRouter.route("*", "*", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* new UnsupportedRequest({ route: routeOf(request) });
  })),
]);

const failureMessage = (value: unknown): string => (value instanceof Error ? value.message : String(value));

// 失敗を応答に変える 1 か所。タグ付きの失敗は上の表のステータスと文面、表にない失敗と defect は
// causeResponse のステータス（500）で、文面は伏せずに返す。中断はこの変換に持ち込まず、
// サーバー側の既定の扱いへ渡す
const respond = <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, HandledFailure, R>) =>
  Effect.catchCauseIf(
    handler,
    (cause) => !Cause.hasInterrupts(cause),
    (cause) =>
      Effect.gen(function* () {
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
        if (failure !== undefined) {
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
// close() の所要時間がその接続に縛られる（ISSUE-2）。close ハンドシェイクは同一プロセス内の 1 往復
// （数十 ms 未満）で終わるのが通常なので、ヘルパーの SIGTERM→SIGKILL の猶予
// （helpers.ts の HELPER_STOP_TIMEOUT_MS=5,000ms）と同程度を上限にすれば、正常系を妨げずに
// 応答しない接続を打ち切れる
const WS_CLOSE_TIMEOUT_MS = 3_000;

// @types/ws@8.18 の ServerOptions は closeTimeout を宣言していないが、ws@8.22 のランタイムは
// WebSocketServer のオプションとしてそのまま受け取り、各サーバー側 WebSocket の _closeTimeout へ伝える
// （ws/lib/websocket-server.js の completeUpgrade → new this.options.WebSocket(...) で options ごと渡る）。
// 型定義の遅れを、この 1 フィールドだけの型アサーションで補う（any にはしない）
const websocketOptions = { closeTimeout: WS_CLOSE_TIMEOUT_MS } as NodeHttpServer.Options["websocket"];

// 127.0.0.1 で待ち受ける。port が 0 なら空きポート。
// NodeHttpServer は Node の http.Server を引数に取るので、node:http への参照はここ 1 か所に閉じる。
// disablePreemptiveShutdown: Scope を閉じたら、まず要求の処理を止めて接続中の Fiber を終わらせ、
// その後に待受けを閉じる。既定の猶予つき停止は、接続が残っている間 20 秒待ってから諦めるため、
// 終了が 20 秒遅れる（close() は時間内に戻ることを既存のテストが確かめている）
const layerNodeServer = (port: number) =>
  NodeHttpServer.layer(createServer, { port, host: "127.0.0.1", disablePreemptiveShutdown: true, websocket: websocketOptions });

// 配信（Viewers）と待受け（HttpServer）の Layer。Scope を閉じると待受けが閉じる
export const layerListener = (port: number): Layer.Layer<Viewers | HttpServer.HttpServer, HttpServerError.ServeError> =>
  Layer.mergeAll(Viewers.layer, layerNodeServer(port));

// layerListener を、いまの Scope に結び付けて作る。serveFeed・serveSessions へ渡す Viewers と HttpServer の Context を返す
// （port は HttpServer の address から portOf で読む）
export const openListener = (port: number) => Layer.build(layerListener(port));

// ブラウザへの配信だけを受ける（CLI の再生）。待ち受けているポートは HttpServer の address から読む
export const serveFeed: Effect.Effect<void, never, HttpServer.HttpServer | Viewers | Scope.Scope> = Effect.flatMap(
  HttpRouter.toHttpEffect(Layer.mergeAll(FeedRoutes, UnsupportedRoute, OriginRestriction)),
  (handler) => HttpServer.serveEffect(respond(handler)),
);

// セッションの操作と配信を受ける（常駐サーバー）
export const serveSessions = (token: string): Effect.Effect<void, never, HttpServer.HttpServer | Sessions | ManagedDeps | Viewers | Scope.Scope> => Effect.flatMap(
  HttpRouter.toHttpEffect(Layer.mergeAll(SessionRoutes, DepRoutes, FeedRoutes, UnsupportedRoute, OriginRestriction)),
  (handler) => HttpServer.serveEffect(respond(handler)),
).pipe(Effect.provideService(ModelTransferToken, token));
