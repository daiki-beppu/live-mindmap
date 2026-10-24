#!/usr/bin/env node
import { NodeChildProcessSpawner, NodeFileSystem, NodeHttpClient, NodePath, NodeRuntime } from "@effect/platform-node";
import { Cause, ConfigProvider, Effect, Exit, type FileSystem, Layer, Logger, Runtime } from "effect";
import { HttpServer, type HttpClient } from "effect/http";
import { AudioMix } from "./audioMix.ts";
import { Readings } from "./readings.ts";
import { MapCapture } from "./capture.ts";
import { Playwright } from "./playwright.ts";
import { depsDirConfig, portConfig, sessionsDirConfig } from "./config.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { InstallDeps } from "./installDeps.ts";
import { planLayer } from "./updatePlan.ts";
import { exitNaturally } from "./exitNaturally.ts";
import { resolveHelperPath } from "./helperPath.ts";
import { Helpers, type HelperCommand } from "./helpers.ts";
import { ReviewBuild } from "./review.ts";
import { layerListener, serveSessions } from "./http.ts";
import { portOf } from "./httpServing.ts";
import { Sessions, SessionsDir } from "./sessions.ts";
import { SessionSinks, type SessionSinksDeps } from "./sessionSinks.ts";
import { Tunnel } from "./tunnel.ts";
import { Viewers } from "./viewers.ts";
import { ViewingShare } from "./viewingShare.ts";
import { makeModelTransferToken, publishModelTransferToken } from "./modelTransferToken.ts";
import { publishServerPid } from "./serverProcess.ts";
import { AppleIntelligence, appleCommand } from "./appleIntelligence.ts";

export type ListenOptions = {
  port: number;
  sessionsDir: string;
  onListening?: (port: number) => void;
};

export type ServerOptions = ListenOptions & {
  depsDir: string;
  prepareUpdater: SessionSinksDeps<HttpClient.HttpClient | FileSystem.FileSystem | AppleIntelligence | ManagedDeps>["prepareUpdater"];
  helper: HelperCommand;
};

export type ServerLayers = {
  managedDeps: Layer.Layer<ManagedDeps>;
  helpers: Layer.Layer<Helpers>;
  sessionSinks: Layer.Layer<SessionSinks>;
  viewing: Layer.Layer<Tunnel | ReviewBuild>;
};

const layerChildProcessSpawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

export type ExportServices = Layer.Layer<MapCapture | ReviewBuild | AudioMix | Readings | FileSystem.FileSystem, never, ManagedDeps>;

export const realLayers = (options: ServerOptions, exportServices: ExportServices): ServerLayers => {
  const managedDeps = ManagedDeps.layer({ root: options.depsDir, cleanupOnStartup: true }).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, layerChildProcessSpawner)));
  const exported = exportServices.pipe(Layer.provide(managedDeps));
  return {
    managedDeps,
    viewing: Layer.merge(Tunnel.layer.pipe(Layer.provide(Layer.mergeAll(managedDeps, layerChildProcessSpawner))), exported),
    helpers: Helpers.layer(options.helper).pipe(Layer.provide(layerChildProcessSpawner)),
    sessionSinks: SessionSinks.layer({ prepareUpdater: options.prepareUpdater }).pipe(Layer.provide(Layer.mergeAll(managedDeps, exported, NodeHttpClient.layerUndici, AppleIntelligence.layer(appleCommand).pipe(Layer.provide(layerChildProcessSpawner))))),
  };
};

export const startup = Effect.fnUntraced(function* (options: ListenOptions, layers: ServerLayers) {
  const token = makeModelTransferToken();
  const context = yield* Layer.build(
    Layer.merge(Sessions.layer, InstallDeps.layer).pipe(
      Layer.provide(Layer.mergeAll(layers.sessionSinks, Layer.succeed(SessionsDir)(options.sessionsDir))),
      Layer.provideMerge(layers.helpers),
      Layer.provideMerge(layerListener(options.port)),
      Layer.provideMerge(layers.managedDeps),
      (base) => ViewingShare.layer.pipe(Layer.provide(layers.viewing), Layer.provideMerge(base)),
    ),
  );
  return yield* Effect.gen(function* () {
    yield* serveSessions(token);
    const viewers = yield* Viewers;
    yield* Effect.addFinalizer(() => viewers.drained);
    const port = yield* portOf((yield* HttpServer.HttpServer).address);
    yield* publishModelTransferToken(options.sessionsDir, port, token).pipe(Effect.provide(NodeFileSystem.layer));
    yield* publishServerPid(options.sessionsDir, port, process.pid).pipe(Effect.provide(NodeFileSystem.layer));
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
    const exportServices = Layer.mergeAll(MapCapture.layer.pipe(Layer.provide(Playwright.layer)), ReviewBuild.layer, AudioMix.layer(helperCommand).pipe(Layer.provide(layerChildProcessSpawner)), Readings.layer(helperCommand).pipe(Layer.provide(layerChildProcessSpawner))).pipe(
      Layer.provideMerge(NodeFileSystem.layer),
    );
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
        prepareUpdater: planLayer,
        helper: helperCommand,
        onListening: (port) => console.error(`live-mindmap サーバーを起動しました: http://127.0.0.1:${port}`),
      };
      yield* startup(options, realLayers(options, exportServices));
      return yield* Effect.never;
    })), { teardown });
  }
}
