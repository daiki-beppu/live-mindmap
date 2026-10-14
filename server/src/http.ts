// ブラウザと CLI からの受け口（ADR 0009）。ルート・本文の Schema・Origin の制限・
// タグ付きの失敗からステータスへの対応表・失敗から応答への変換を、この 1 か所に置く。
//   GET  /apps            ヘルパーの `list` の結果（会議アプリの一覧）を返す
//   POST /session/start   { app, title?, audio?, screen? } でセッションを開始する
//   POST /session/recorded { file, title?, vocab?, model? } で、音声 1 本から録画からのセッションを始める。応答は NDJSON の stream
//                         （started → progress... → finished。読み終えるか stop されると finished で終わる）。ライブの最中は 409
//   POST /session/stop    セッションを終了し、書き出したパスを返す
//   GET  /session/status  取り込みの状態を返す
//   POST /session/resume  止まった状態から起動し直す
//   POST /session/self-pause  { paused: boolean } で自分の休止（true）・再開（false）を求める。成功は 204、本文が違えば 400、セッションが無ければ 409
//   POST /share/open      { anyone: true } か { mails: [メール・ドメイン...] } で閲覧の共有を開く（すでに開いていれば今の状態を返す）
//                         ローカルモードのセッションは 409、cloudflared が無いときは 503（入れ方を示す）、範囲が空（{}）は 400 で、どれも開かない
//   POST /share/close     閲覧の共有を閉じる（開いていなくても成功する）
//   GET  /share/status    閲覧の共有の状態（無し・共有中・切れた）を返す
//   GET  /・/ws           ブラウザへの配信（同じポートで upgrade する）
// 閲覧の口（openViewingPort）は、操作の口とは別の 127.0.0.1 の待受けで、GET /（ログを埋め込まない single-file の画面）と
// /ws の配信だけを受ける。Origin は allow で決めたホスト名の https:// だけを通し、/session/* などの操作は受けない。
// /ws の配信には、server から WebSocket の制御フレームの ping を一定の間隔で送る（Issue #833）。tunnel が無通信の接続を切ることへの備えで、
// アプリの JSON フレームは増やさない。間隔の既定は 30 秒で、テストは短い間隔を渡して縮める。
// セッションの操作は sessions.ts の Sessions から受け取り、server.ts の実装は読み込まない（循環依存を作らない）。
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { WebSocket } from "ws";
import { Cause, Context, Effect, Layer, Option, Ref, Schema, Stream, type Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { NetAddress } from "effect/net";
import { SHARE_OPEN_OUTCOME_HEADER, ShareMail, type RecordedEvent } from "./core/index.ts";
import type { SessionFailure } from "./sessionFailure.ts";
import { Sessions, type RecordedStart, type SessionStart } from "./sessions.ts";
import { Viewers } from "./viewers.ts";
import type { CloudflaredMissing } from "./tunnel.ts";
import { ViewingShare, ShareOpenFailed, ShareRefusedLocalMode, ShareScopeEmpty, type ViewingPort } from "./viewingShare.ts";
import { TransferredJudge } from "./judgeSelection.ts";
import { acceptTransferredModel, defaultClaude, TransferredModel } from "./modelSelection.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { InstallDeps } from "./installDeps.ts";
import { checkManagedDeps } from "./managedDepsCheck.ts";
import { Helpers } from "./helpers.ts";
import { CheckFor, ModelRoute, CheckDepNames, InstallBody, UpdateBody, type InstallEvent } from "./managedDepsProtocol.ts";
import { ReviewBuild, type ReviewPageFailed } from "./review.ts";
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
  vocab: Schema.optionalKey(Schema.Array(Schema.String)), // 利用者が足した語（cli start --vocab）。1 語ずつ
  model: Schema.optionalKey(TransferredModel),
  judge: Schema.optionalKey(TransferredJudge), // 開始時に決めた判定のモデル（cli start）。鍵は送らず、環境変数の名前だけを送る
});

// /session/recorded の本文。file は録画の音声の絶対パス（CLI が解決して渡す）。title・vocab・model は /session/start と同じ意味
const SessionRecordedBody = Schema.Struct({
  file: Schema.NonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  vocab: Schema.optionalKey(Schema.Array(Schema.String)),
  model: Schema.optionalKey(TransferredModel),
});

const toSessionStart = (body: typeof SessionStartBody["Type"], model: SessionStart["model"]): SessionStart => ({
  ...(body.judge ? { judge: body.judge } : {}),
  app: body.app,
  title: body.title ?? undefined,
  audio: body.audio ?? true,
  screen: body.screen ?? true,
  vocab: body.vocab ?? [],
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
type HandledFailure = SessionFailure | ShareOpenFailed | ShareRefusedLocalMode | ShareScopeEmpty | CloudflaredMissing | ForbiddenOrigin | ForbiddenModelTransfer | UnsupportedRequest | InvalidBody | HttpServerError.HttpServerError;

const STATUS: { readonly [Tag in HandledFailure["_tag"]]: number } = {
  InvalidBody: 400,
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
// HTTP と `/`・`/ws` の upgrade の両方に掛ける 1 つのミドルウェア。操作にも upgrade にも進む前に断る
const OriginRestriction = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const { origin } = (yield* HttpServerRequest.HttpServerRequest).headers;
    if (origin !== undefined && !isLocalOrigin(origin)) return yield* new ForbiddenOrigin();
    return yield* httpEffect;
  }), { global: true });

// 本文のモデルを検証して実行できる形にする。互換モデルは、転送用トークンが合うときだけ受ける（/session/start と /session/recorded が共有する）
const acceptBodyModel = Effect.fnUntraced(function* (model: typeof TransferredModel["Type"] | undefined, withJudge = false) {
  const result = acceptTransferredModel(model ?? defaultClaude);
  if (!result.ok) return yield* new InvalidBody({ detail: result.lines.join("\n") });
  // 判定は環境変数の鍵を、本文で指定できる url へ送る。互換モデルと同じ危険があるので、転送用トークンを求める
  if (model?.route === "openai-compatible" || model?.route === "chatgpt" || withJudge) {
    const token = yield* ModelTransferToken;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!matchesModelTransferToken(token, request.headers[MODEL_TRANSFER_HEADER])) return yield* new ForbiddenModelTransfer();
  }
  return result.model;
});

// セッションを始める本文を読み、そのモデルを検証する。本文が違えば 400
const acceptedBody = Effect.fnUntraced(function* <A extends { readonly model?: typeof TransferredModel["Type"]; readonly judge?: unknown }, R>(
  decode: Effect.Effect<A, { readonly message: string }, R>,
) {
  const body = yield* decode.pipe(Effect.mapError((failure) => new InvalidBody({ detail: failure.message })));
  return { body, model: yield* acceptBodyModel(body.model, body.judge !== undefined) };
});

const startSession = Effect.gen(function* () {
  const { body, model } = yield* acceptedBody(HttpServerRequest.schemaBodyJson(SessionStartBody));
  const sessions = yield* Sessions;
  return HttpServerResponse.jsonUnsafe(yield* sessions.start(toSessionStart(body, model)));
});

// 録画からのセッション。始められたら NDJSON の stream で経過を流す。始められなかったら（ライブの最中など）通常の失敗の応答
const startRecordedSession = Effect.gen(function* () {
  const { body, model } = yield* acceptedBody(HttpServerRequest.schemaBodyJson(SessionRecordedBody));
  const sessions = yield* Sessions;
  const input: RecordedStart = { file: body.file, title: body.title ?? undefined, vocab: body.vocab ?? [], model };
  const { dir, warnings, events } = yield* sessions.startRecorded(input);
  return HttpServerResponse.stream(
    Stream.concat(Stream.succeed<RecordedEvent>({ type: "started", dir, warnings }), events).pipe(
      Stream.map((event) => JSON.stringify(event) + "\n"),
      Stream.encodeText,
    ),
    { contentType: "application/x-ndjson" },
  );
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

// /share/open の本文。範囲は { anyone: true } か { mails: [1 件以上] }、範囲なしの {}（範囲が空の拒否はサーバーが判定順の最後で決める）。
// 両方を持つ本文は、どの形にも当たらず 400
const ShareOpenBody = Schema.Union([
  Schema.Struct({ anyone: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.Struct({ mails: Schema.Array(ShareMail).check(Schema.isMinLength(1)) }),
]);

// /session/self-pause の本文。状態を指定する形（トグルではない）なので、同じ指示を重ねても結果が変わらない
const SelfPauseBody = Schema.Struct({ paused: Schema.Boolean });

const SessionRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", "/apps", Effect.gen(function* () {
    const sessions = yield* Sessions;
    return HttpServerResponse.jsonUnsafe(yield* sessions.apps);
  })),
  HttpRouter.route("POST", "/session/start", startSession),
  HttpRouter.route("POST", "/session/recorded", startRecordedSession),
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
    return HttpServerResponse.jsonUnsafe(yield* sessions.resume);
  })),
  HttpRouter.route("POST", "/session/self-pause", Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(SelfPauseBody, { onExcessProperty: "error" }).pipe(
      Effect.mapError((failure) => new InvalidBody({ detail: failure.message })),
    );
    const sessions = yield* Sessions;
    yield* sessions.setSelfPause(body.paused);
    return HttpServerResponse.empty({ status: 204 });
  })),
  HttpRouter.route("POST", "/share/open", Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(ShareOpenBody, { onExcessProperty: "error" }).pipe(
      Effect.mapError((failure) => new InvalidBody({ detail: failure.message })),
    );
    const share = yield* ViewingShare;
    const { outcome, status } = yield* share.open("anyone" in body ? "anyone" : "mails" in body ? { mails: body.mails } : undefined);
    return HttpServerResponse.jsonUnsafe(status, { headers: { [SHARE_OPEN_OUTCOME_HEADER]: outcome } });
  })),
  HttpRouter.route("POST", "/share/close", Effect.gen(function* () {
    const share = yield* ViewingShare;
    yield* share.close;
    return HttpServerResponse.jsonUnsafe(yield* share.status);
  })),
  HttpRouter.route("GET", "/share/status", Effect.gen(function* () {
    const share = yield* ViewingShare;
    return HttpServerResponse.jsonUnsafe(yield* share.status);
  })),
]);

// 待ち受けているサーバー自身の PID。cli server stop は、記録の PID ではなくこれにだけシグナルを送る（serverProcess.ts）
const ServerRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", "/server", Effect.sync(() => HttpServerResponse.jsonUnsafe({ pid: process.pid }))),
]);

const FeedRoutes = HttpRouter.addAll([
  HttpRouter.route("GET", "/ws", feed),
  HttpRouter.route("GET", "/", feed),
]);

const depResponse = Effect.fnUntraced(function* <E>(source: Stream.Stream<typeof InstallEvent.Type, E>) {
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
  HttpRouter.route("GET", "/check", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = new URL(request.url, "http://127.0.0.1").searchParams;
    const entry = yield* Schema.decodeUnknownEffect(CheckFor)(params.get("for") ?? "start").pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    if (entry === "resume") return HttpServerResponse.jsonUnsafe(yield* (yield* Sessions).checkResume);
    const route = yield* Schema.decodeUnknownEffect(ModelRoute)(params.get("route") ?? "claude").pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    if (entry === "play") return HttpServerResponse.jsonUnsafe(yield* checkManagedDeps(entry, route));
    const screen = yield* Schema.decodeUnknownEffect(Schema.Literals(["true", "false"]))(params.get("screen") ?? "true").pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const helpers = yield* Helpers;
    return HttpServerResponse.jsonUnsafe(yield* checkManagedDeps(entry, route, { screen: screen === "true", check: screen === "true" ? helpers.check : helpers.checkNoScreen }));
  })),
  HttpRouter.route("GET", "/deps/check", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = new URL(request.url, "http://127.0.0.1").searchParams.get("names");
    const names = yield* Schema.decodeUnknownEffect(CheckDepNames)(raw === null ? [] : raw.split(",")).pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const deps = yield* ManagedDeps;
    return HttpServerResponse.jsonUnsafe(yield* deps.check(names).pipe(Effect.orDie));
  })),
  HttpRouter.route("POST", "/deps/install", Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(InstallBody).pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const deps = yield* InstallDeps;
    return yield* depResponse(deps.install(body.names));
  })),
  HttpRouter.route("POST", "/update", Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(UpdateBody).pipe(
      Effect.mapError((error) => new InvalidBody({ detail: error.message })),
    );
    const deps = yield* ManagedDeps;
    return yield* depResponse(deps.update(body.names));
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
// close() の所要時間がその接続に縛られる（ISSUE-2）。close ハンドシェイクは同一プロセス内の 1 往復
// （数十 ms 未満）で終わるのが通常なので、ヘルパーの SIGTERM→SIGKILL の猶予
// （helpers.ts の HELPER_STOP_TIMEOUT_MS=5,000ms）と同程度を上限にすれば、正常系を妨げずに
// 応答しない接続を打ち切れる
const WS_CLOSE_TIMEOUT_MS = 3_000;

// /ws の配信への ping の間隔の既定（ms）。tunnel の無通信の切断より十分短い
export const FEED_PING_INTERVAL_MS = 30_000;

// 接続ごとに、一定の間隔で制御フレームの ping を送るサーバー側 WebSocket のクラス。
// effect の Socket は制御フレームを送る手段を持たず、生の ws に手が届くのは WebSocketServer の WebSocket オプションだけなので、
// ws の WebSocket を継承してここで差し込む。タイマーは接続の寿命に結び、close で止める（unref で、タイマーだけがプロセスを生かさない）
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
// 型定義の遅れを、この 1 フィールドだけの型アサーションで補う（any にはしない）
const websocketOptions = (pingIntervalMs: number) =>
  ({ closeTimeout: WS_CLOSE_TIMEOUT_MS, WebSocket: pingingWebSocket(pingIntervalMs) }) as NodeHttpServer.Options["websocket"];

// 127.0.0.1 で待ち受ける。port が 0 なら空きポート。
// NodeHttpServer は Node の http.Server を引数に取るので、node:http への参照はここ 1 か所に閉じる。
// disablePreemptiveShutdown: Scope を閉じたら、まず要求の処理を止めて接続中の Fiber を終わらせ、
// その後に待受けを閉じる。既定の猶予つき停止は、接続が残っている間 20 秒待ってから諦めるため、
// 終了が 20 秒遅れる（close() は時間内に戻ることを既存のテストが確かめている）
const layerNodeServer = (port: number, pingIntervalMs: number) =>
  NodeHttpServer.layer(createServer, { port, host: "127.0.0.1", disablePreemptiveShutdown: true, websocket: websocketOptions(pingIntervalMs) });

// 配信（Viewers）と待受け（HttpServer）の Layer。Scope を閉じると待受けが閉じる
export const layerListener = (port: number, pingIntervalMs: number = FEED_PING_INTERVAL_MS): Layer.Layer<Viewers | HttpServer.HttpServer, HttpServerError.ServeError> =>
  Layer.mergeAll(Viewers.layer, layerNodeServer(port, pingIntervalMs));

// layerListener を、いまの Scope に結び付けて作る。serveFeed・serveSessions へ渡す Viewers と HttpServer の Context を返す
// （port は HttpServer の address から portOf で読む）
export const openListener = (port: number, pingIntervalMs: number = FEED_PING_INTERVAL_MS) => Layer.build(layerListener(port, pingIntervalMs));

// ブラウザへの配信だけを受ける（CLI の再生）。待ち受けているポートは HttpServer の address から読む
export const serveFeed: Effect.Effect<void, never, HttpServer.HttpServer | Viewers | Scope.Scope> = Effect.flatMap(
  HttpRouter.toHttpEffect(Layer.mergeAll(FeedRoutes, UnsupportedRoute, OriginRestriction)),
  (handler) => HttpServer.serveEffect(respond(handler)),
);

// セッションの操作と配信を受ける（常駐サーバー）
export const serveSessions = (token: string): Effect.Effect<void, never, HttpServer.HttpServer | Sessions | ViewingShare | Helpers | ManagedDeps | InstallDeps | Viewers | Scope.Scope> => Effect.flatMap(
  HttpRouter.toHttpEffect(Layer.mergeAll(SessionRoutes, ServerRoutes, DepRoutes, FeedRoutes, UnsupportedRoute, OriginRestriction)),
  (handler) => HttpServer.serveEffect(respond(handler)),
).pipe(Effect.provideService(ModelTransferToken, token));

// 閲覧の口。操作の口とは別の 127.0.0.1 の待受け（port 0 で空きポート）で、GET /（ログを埋め込まない single-file の画面）と
// /ws の配信だけを受ける。配信は呼び出し側の Viewers を使う（保持値と PubSub を複製しない）。待受けは呼び出し側の Scope で閉じる。
// Origin は allow で決めた `https://<hostname>` との完全一致だけを通す。決まる前は、Origin のある要求と /ws をすべて断る。
// Origin の無い GET / は通し、/ws は Origin が無くても断る。
// 画面のビルドは開くときに 1 回だけ行う（Vite の開発用サーバーは使わない）
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
