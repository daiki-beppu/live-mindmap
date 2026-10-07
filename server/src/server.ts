#!/usr/bin/env node
// 常駐サーバー（pnpm dev）。ADR 0003: ヘルパーはこのサーバーの子プロセスで、セッションの開始・終了は CLI から頼まれる。
// 受け口（ルート・本文の検証・Origin の制限・失敗から応答への変換）は http.ts、ブラウザへの配信は viewers.ts。
// ヘルパーの寿命とセッションの状態は sessions.ts（外の世界は helpers.ts、セッションの中身は sessionSinks.ts）が持つ。
// このモジュールが持つのは、それらの Layer を組み立てて待受けにつなぐ、起動・終了の入口。
// ブラウザへの WebSocket は HTTP と同じポートで待ち受ける。同時に扱うセッションは 1 つ。
import { NodeChildProcessSpawner, NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node";
import { Cause, Context, Effect, Exit, Layer, Result, Runtime, Scope } from "effect";
import { HttpServer } from "effect/http";
import type { PromiseMapCapture } from "./capture.ts";
import { defaultPort, defaultSessionsDir } from "./cli.ts";
import type { DiffUpdater } from "./core/index.ts";
import { claudeUpdaterLayer, type UpdaterUnavailable } from "./diffUpdater.ts";
import { resolveHelperPath } from "./helperPath.ts";
import { Helpers, type HelperCommand } from "./helpers.ts";
import type { PromiseReviewPages } from "./review.ts";
import { openListener, portOf, serveSessions } from "./http.ts";
import { Sessions, SessionsDir } from "./sessions.ts";
import { SessionSinks } from "./sessionSinks.ts";
import { Viewers } from "./viewers.ts";

export type ListenOptions = {
  port: number; // 0 なら空きポート
  sessionsDir: string;
  onListening?: (port: number) => void;
};

export type ServerOptions = ListenOptions & {
  updaterLayer: Layer.Layer<DiffUpdater, UpdaterUnavailable>; // セッションごとに updater を 1 つ開く。stop・開始の失敗・サーバーの終了で閉じる
  capture: PromiseMapCapture; // 終了時の map.png の撮影
  writeReview: PromiseReviewPages; // 終了時の map.html の書き出し
  helper: HelperCommand; // 実行ファイルと、サブコマンドの前に付ける引数
};

export type Server = { port: number; close: () => Promise<void> };

// 外の世界（子プロセス・空きポート・ヘルパーへの WebSocket）とセッションの中身の Layer。テストは偽物を渡す
export type ServerLayers = {
  helpers: Layer.Layer<Helpers>;
  sessionSinks: Layer.Layer<SessionSinks>;
};

// 子プロセスの起動に、FileSystem と Path が要る
const layerChildProcessSpawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

const realLayers = (options: ServerOptions): ServerLayers => ({
  helpers: Helpers.layer(options.helper).pipe(Layer.provide(layerChildProcessSpawner)),
  sessionSinks: SessionSinks.layer({ updaterLayer: options.updaterLayer, capture: options.capture, writeReview: options.writeReview }),
});

// サーバーの資源（配信・セッションの状態・待受け）を Scope に結び付けて起動し、待ち受けているポートを返す。
// セッションの Scope はこの Scope の子で、Scope を閉じると、進行中のセッションのヘルパー・updater が後始末される。
// その後に配信を渡し切り（drained）、待受けの停止・接続の Fiber の終了・待受けを閉じる finalizer が続く
const startup = (options: ListenOptions, layers: ServerLayers) =>
  Effect.gen(function* () {
    const { viewers, httpServer } = yield* openListener(options.port);
    const context = yield* Layer.build(
      Sessions.layer.pipe(
        Layer.provide(Layer.mergeAll(layers.helpers, layers.sessionSinks, Layer.succeed(SessionsDir)(options.sessionsDir), Layer.succeed(Viewers)(viewers))),
      ),
    );
    yield* serveSessions.pipe(
      Effect.provideService(Viewers, viewers),
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(Sessions, Context.get(context, Sessions)),
    );
    // 最後に登録するので、セッションの Scope（開始のたびに作る子）の後始末に続いて走る:
    // ヘルパーを止めて最後のフレームを出した後、それを接続中のクライアントへ渡し切る
    yield* Effect.addFinalizer(() => viewers.drained);
    const port = portOf(httpServer.address);
    options.onListening?.(port);
    return port;
  });

// Scope を 1 つ持ち、close() でそれを閉じる入口。Layer を差し替えられる
export async function startServerWithLayers(options: ListenOptions, layers: ServerLayers): Promise<Server> {
  const scope = Effect.runSync(Scope.make());
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= Effect.runPromise(Scope.close(scope, Exit.void)));
  try {
    return { port: await Effect.runPromise(Scope.provide(startup(options, layers), scope)), close };
  } catch (e) {
    await close();
    throw e;
  }
}

// 既存の呼び出し側（CLI の疎通テスト・ライブのテスト）が使う入口。実物の子プロセスで動く
export const startServer = (options: ServerOptions): Promise<Server> => startServerWithLayers(options, realLayers(options));

// SIGINT・SIGTERM で終わったときの終了コードは 0 にする（頼まれた終了であって、失敗ではない）。
// 既定の teardown は中断だけの Exit を 130 にするが、待受けの失敗などの本当の失敗は既定の規則に任せる
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return onExit(0);
  Runtime.defaultTeardown(exit, onExit);
};

if (import.meta.main) {
  const helper = resolveHelperPath(process.env);
  if ("error" in helper) {
    console.error(helper.error);
    process.exit(1);
  }
  const helperPath = helper.path;
  const { MapCapture } = await import("./capture.ts");
  // 終了時の書き出し（sessionFiles.ts の writeSessionExports）はまだ Promise のままなので、入口で Service を Promise の口に変えて渡す
  // （撮影の失敗は reject にして、呼び出し側の「画像だけ諦める」扱いを保つ）
  const capture: PromiseMapCapture = (snapshot, path) =>
    Effect.runPromise(
      Effect.result(
        Effect.flatMap(MapCapture, (service) => service.capture(snapshot, path)).pipe(Effect.provide(MapCapture.layer)),
      ),
    ).then((result) => {
      if (Result.isFailure(result)) throw result.failure;
    });
  // 見返し用の HTML も同じく、入口で Layer を渡して Promise の口にする（失敗は reject にして、HTML だけ諦める扱いを保つ）
  const { ReviewBuild, writeReviewPages } = await import("./review.ts");
  const writeReview: PromiseReviewPages = (dir, logPath, variants) =>
    Effect.runPromise(
      Effect.result(writeReviewPages(dir, logPath, variants).pipe(Effect.provide(ReviewBuild.layer))),
    ).then((result) => {
      if (Result.isFailure(result)) throw result.failure;
      return result.success;
    });
  const options: ServerOptions = {
    port: defaultPort(),
    sessionsDir: defaultSessionsDir(),
    updaterLayer: claudeUpdaterLayer,
    capture,
    writeReview,
    helper: { command: helperPath, args: [] },
    onListening: (port) => console.error(`live-mindmap サーバーを起動しました: http://127.0.0.1:${port}`),
  };
  // runMain は SIGINT・SIGTERM でルートのファイバーを中断する。中断で Scope が閉じ、ヘルパー・配信・
  // 待受けが後片付けされる（process.exit で finalizer を迂回しない）。runMain はこの入口にだけ置く
  NodeRuntime.runMain(Effect.scoped(Effect.gen(function* () {
    yield* startup(options, realLayers(options));
    return yield* Effect.never;
  })), { teardown });
}
