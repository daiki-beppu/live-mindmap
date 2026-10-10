#!/usr/bin/env node
// 常駐サーバー（pnpm dev）。ADR 0003: ヘルパーはこのサーバーの子プロセスで、セッションの開始・終了は CLI から頼まれる。
// 受け口（ルート・本文の検証・Origin の制限・失敗から応答への変換）は http.ts、ブラウザへの配信は viewers.ts。
// ヘルパーの寿命とセッションの状態は sessions.ts（外の世界は helpers.ts、セッションの中身は sessionSinks.ts）が持つ。
// このモジュールが持つのは、それらの Layer を組み立てて待受けにつなぐ、起動・終了の入口。
// ブラウザへの WebSocket は HTTP と同じポートで待ち受ける。同時に扱うセッションは 1 つ。
import { NodeChildProcessSpawner, NodeFileSystem, NodeHttpClient, NodePath, NodeRuntime } from "@effect/platform-node";
import { Cause, ConfigProvider, Effect, Exit, type FileSystem, Layer, Logger, Runtime } from "effect";
import { HttpServer, type HttpClient } from "effect/http";
import { AudioMix } from "./audioMix.ts";
import { MapCapture } from "./capture.ts";
import { Playwright } from "./playwright.ts";
import { depsDirConfig, portConfig, sessionsDirConfig } from "./config.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { prepareUpdaterLayer } from "./diffUpdater.ts";
import { exitNaturally } from "./exitNaturally.ts";
import { resolveHelperPath } from "./helperPath.ts";
import { Helpers, type HelperCommand } from "./helpers.ts";
import { ReviewBuild } from "./review.ts";
import { layerListener, portOf, serveSessions } from "./http.ts";
import { Sessions, SessionsDir } from "./sessions.ts";
import { SessionSinks, type SessionSinksDeps } from "./sessionSinks.ts";
import { Viewers } from "./viewers.ts";
import { makeModelTransferToken, publishModelTransferToken } from "./modelTransferToken.ts";

export type ListenOptions = {
  port: number; // 0 なら空きポート
  sessionsDir: string;
  onListening?: (port: number) => void;
};

export type ServerOptions = ListenOptions & {
  depsDir: string;
  prepareUpdater: SessionSinksDeps<HttpClient.HttpClient | FileSystem.FileSystem>["prepareUpdater"];
  helper: HelperCommand; // 実行ファイルと、サブコマンドの前に付ける引数
};

// 外の世界（子プロセス・空きポート・ヘルパーへの WebSocket）とセッションの中身の Layer。テストは偽物を渡す
export type ServerLayers = {
  managedDeps: Layer.Layer<ManagedDeps>;
  helpers: Layer.Layer<Helpers>;
  sessionSinks: Layer.Layer<SessionSinks>;
};

// 子プロセスの起動に、FileSystem と Path が要る
const layerChildProcessSpawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

// 終了時の書き出しが使う Service（撮影・見返し用の HTML のビルド・mix と、その FileSystem）
export type ExportServices = Layer.Layer<MapCapture | ReviewBuild | AudioMix | FileSystem.FileSystem>;

export const realLayers = (options: ServerOptions, exportServices: ExportServices): ServerLayers => ({
  managedDeps: ManagedDeps.layer({ root: options.depsDir }).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, layerChildProcessSpawner))),
  helpers: Helpers.layer(options.helper).pipe(Layer.provide(layerChildProcessSpawner)),
  sessionSinks: SessionSinks.layer({ prepareUpdater: options.prepareUpdater }).pipe(Layer.provide(Layer.merge(exportServices, NodeHttpClient.layerUndici))),
});

// サーバーの資源（配信・セッションの状態・待受け）を Scope に結び付けて起動し、待ち受けているポートを返す。
// 止める順（登録の逆）: 配信を渡し切る（drained）→ 配信の停止・接続の Fiber の終了 → Sessions
// （進行中のセッションのヘルパー・updater の後始末）→ 待受けを閉じる
export const startup = Effect.fnUntraced(function* (options: ListenOptions, layers: ServerLayers) {
  const token = makeModelTransferToken();
  // 待受け・Viewers・Sessions を 1 つの Layer に組む（依存を先に build するので、止めるときは Sessions が待受けより先）
  const context = yield* Layer.build(
    Sessions.layer.pipe(
      Layer.provide(Layer.mergeAll(layers.helpers, layers.sessionSinks, Layer.succeed(SessionsDir)(options.sessionsDir))),
      Layer.provideMerge(layerListener(options.port)),
      Layer.provideMerge(layers.managedDeps),
    ),
  );
  return yield* Effect.gen(function* () {
    yield* serveSessions(token);
    // 配信の停止・Sessions・待受けを閉じるより先に、最後のフレームを接続中のクライアントへ渡し切る
    const viewers = yield* Viewers;
    yield* Effect.addFinalizer(() => viewers.drained);
    const port = yield* portOf((yield* HttpServer.HttpServer).address);
    yield* publishModelTransferToken(options.sessionsDir, port, token).pipe(Effect.provide(NodeFileSystem.layer));
    options.onListening?.(port);
    return port;
  }).pipe(Effect.provide(context));
});

// SIGINT・SIGTERM で終わったときの終了コードは 0 にする（頼まれた終了であって、失敗ではない）。
// 既定の teardown は中断だけの Exit を 130 にするが、待受けの失敗などの本当の失敗は既定の規則に任せる
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    process.exitCode = 0;
    return;
  }
  exitNaturally(exit, onExit);
};

if (import.meta.main) {
  const helper = resolveHelperPath(process.env);
  if ("error" in helper) {
    console.error(helper.error);
    process.exitCode = 1;
  } else {
    const helperPath = helper.path;
    const helperCommand = { command: helperPath, args: [] };
    // 終了時の書き出しの Service は、ここで 1 回だけ組む（書き出しのたびに Layer を作り直さない）
    const exportServices = Layer.mergeAll(MapCapture.layer.pipe(Layer.provide(Playwright.layer)), ReviewBuild.layer, AudioMix.layer(helperCommand).pipe(Layer.provide(layerChildProcessSpawner))).pipe(
      Layer.provideMerge(NodeFileSystem.layer),
    );
    // runMain は SIGINT・SIGTERM でルートのファイバーを中断する。中断で Scope が閉じ、ヘルパー・配信・
    // 待受けが後片付けされる（process.exit で finalizer を迂回しない）。runMain はこの入口にだけ置く
    // 設定（ポートとフォルダ）の解決に失敗したときだけ、理由を標準エラーに出す。Effect の既定のロガーは標準出力に書くので、
    // ここだけ LogToStderr を立てる。待受けの失敗などほかの失敗は、runMain の自動報告（既定のロガー）のまま変えない。
    // 出した失敗には errorReported=false を付け、runMain が同じ失敗を標準出力へもう一度報告しないようにする
    // 既定の ConfigProvider は空文字を未設定として扱い、LIVE_MINDMAP_PORT="" が既定のポートに化けるので、空文字を保つ provider を指定する
    // （空文字は整数でない値として拒否する。キーが無いときだけ既定のポートを使う）
    const settings = Effect.all({ port: portConfig, sessionsDir: sessionsDirConfig, depsDir: depsDirConfig }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      Effect.tapCause((cause) => Effect.logError(cause).pipe(Effect.provideService(Logger.LogToStderr, true))),
      Effect.mapError((error) => Object.assign(error, { [Runtime.errorReported]: false as const })),
    );
    NodeRuntime.runMain(Effect.scoped(Effect.gen(function* () {
      const { port, sessionsDir, depsDir } = yield* settings;
      const options: ServerOptions = {
        port,
        sessionsDir,
        depsDir,
        prepareUpdater: prepareUpdaterLayer,
        helper: helperCommand,
        onListening: (port) => console.error(`live-mindmap サーバーを起動しました: http://127.0.0.1:${port}`),
      };
      yield* startup(options, realLayers(options, exportServices));
      return yield* Effect.never;
    })), { teardown });
  }
}
