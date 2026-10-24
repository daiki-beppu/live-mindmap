import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { WebSocket } from "ws";
import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { NetAddress } from "effect/net";
import { Viewers } from "./viewers.ts";

export class ForbiddenOrigin extends Schema.TaggedError<ForbiddenOrigin>()("ForbiddenOrigin", {}) {
  override get message(): string {
    return "許可されていない Origin です";
  }
}

export class UnsupportedRequest extends Schema.TaggedError<UnsupportedRequest>()("UnsupportedRequest", {
  route: Schema.String,
}) {
  override get message(): string {
    return `未対応のリクエスト: ${this.route}`;
  }
}

export type StatusTable<F extends { readonly _tag: string }> = { readonly [Tag in F["_tag"]]: number };

export type BaseFailure = ForbiddenOrigin | UnsupportedRequest | HttpServerError.HttpServerError;

export const BASE_STATUS: StatusTable<BaseFailure> = {
  ForbiddenOrigin: 403,
  UnsupportedRequest: 404,
  HttpServerError: 500,
};

const routeOf = (request: HttpServerRequest.HttpServerRequest): string =>
  `${request.method} ${new URL(request.url, "http://127.0.0.1").pathname}`;

export const feed = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const viewers = yield* Viewers;
  const socket = yield* request.upgrade.pipe(
    Effect.mapError(() => new UnsupportedRequest({ route: routeOf(request) })),
  );
  yield* viewers.connect(socket).pipe(Effect.ignore({ log: "Debug", message: "閲覧の WebSocket が切れた" }));
  return HttpServerResponse.empty();
});

export const UnsupportedRoute = HttpRouter.addAll([
  HttpRouter.route("*", "*", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* new UnsupportedRequest({ route: routeOf(request) });
  })),
]);

export const failureMessage = (value: unknown): string => (value instanceof Error ? value.message : String(value));

export const respondWith = <F extends { readonly _tag: string; readonly message: string }>(
  status: StatusTable<F>,
  body: (failure: F) => object = (failure) => ({ error: failure.message }),
) => <R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, F, R>) =>
  Effect.catchCauseIf(
    handler,
    (cause) => !Cause.hasInterrupts(cause),
    (cause) =>
      Effect.gen(function* () {
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
        if (failure !== undefined) {
          const tag: F["_tag"] = failure._tag;
          return HttpServerResponse.jsonUnsafe(body(failure), { status: status[tag] });
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
export const layerNodeServer = (port: number, pingIntervalMs: number) =>
  Layer.unwrap(
    Effect.map(WS_CLOSE_TIMEOUT_MS, (closeTimeoutMs) =>
      NodeHttpServer.layer(createServer, { port, host: "127.0.0.1", disablePreemptiveShutdown: true, websocket: websocketOptions(pingIntervalMs, closeTimeoutMs) })),
  );
