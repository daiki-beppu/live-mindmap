// e2e の対象アプリを 1 つのプロセスで立てる（e2e.config.ts の app.command）。
// - server: 本体の startup / realLayers をそのまま使い、helper を fake-helper に、差分更新を偽の updater に差し替える。
//   ポートは空きポート、セッションのフォルダは一時フォルダ。本体にテスト用の口は足さない。
// - web: Vite の開発サーバー。/ws は LIVE_MINDMAP_PORT（この server のポート）へ proxy される（web/vite.config.ts）。
// - ファイル配信: セッションのフォルダの下を text/plain で返す、読み取り専用の小さな HTTP サーバー。書き出しのファイルを、テストが画面（locator）で判定するための口。
// - run-info（.run/server.json）: テストが CLI を呼ぶための server のポートとセッションのフォルダ、ファイル配信のポート。
// 使い方: node scripts/serve.ts --web-port <n> --events <台本の先頭から流す発言の件数>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { parseArgs } from "node:util";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer } from "vite";
import { AudioMix } from "../../server/src/audioMix.ts";
import { MapCapture } from "../../server/src/capture.ts";
import type { DiffInput, Op } from "../../server/src/core/index.ts";
import { ReviewBuild } from "../../server/src/review.ts";
import { realLayers, startup, type ServerOptions } from "../../server/src/server.ts";
import { updaterLayer } from "../../server/test/fixtures/sessionLayers.ts";

const e2eDir = join(import.meta.dirname, "..");
const webDir = join(e2eDir, "../web");
const fakeHelper = join(e2eDir, "../server/test/fixtures/fake-helper.ts");
const runInfoPath = join(e2eDir, ".run/server.json");

const { values } = parseArgs({ options: { "web-port": { type: "string" }, events: { type: "string" } } });
const webPort = Number(values["web-port"]);
const eventCount = Number(values.events);
if (!Number.isInteger(webPort) || webPort <= 0 || !Number.isInteger(eventCount) || eventCount <= 0) {
  throw new Error("usage: serve.ts --web-port <n> --events <n>");
}

// 新しく来た発言 1 件ごとに、ルート直下へノードを 1 つ足す。文言は発言そのまま
const update = (input: DiffInput) =>
  Effect.succeed({
    ops: input.fresh.map((remark): Op => ({ op: "add", ref: `n-${remark.id}`, parent: "root", kind: "要点", text: remark.text, evidence: [remark.id] })),
  });

const layerChildProcessSpawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

const program = Effect.gen(function* () {
  // 一時フォルダ（セッション・台本・fake-helper の記録）と run-info は、Scope を閉じるときに消す
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "live-mindmap-e2e-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(runInfoPath, { force: true })));

  const sessionsDir = join(root, "sessions");
  const scriptPath = join(root, "script.json");
  const recordPath = join(root, "record.jsonl");
  const fixture = JSON.parse(readFileSync(join(e2eDir, "fixtures/meeting.json"), "utf8")) as { apps: unknown; events: unknown[] };
  writeFileSync(scriptPath, JSON.stringify({ apps: fixture.apps, events: fixture.events.slice(0, eventCount) }));
  writeFileSync(recordPath, "");

  const helper = { command: process.execPath, args: [fakeHelper, scriptPath, recordPath] };
  const options: ServerOptions = { port: 0, sessionsDir, updaterLayer: updaterLayer(update), helper };
  // server.ts の import.meta.main と同じ組み方。AudioMix は fake-helper の mix を呼ぶ
  const exportServices = Layer.mergeAll(MapCapture.layer, ReviewBuild.layer, AudioMix.layer(helper).pipe(Layer.provide(layerChildProcessSpawner))).pipe(
    Layer.provideMerge(NodeFileSystem.layer),
  );
  mkdirSync(sessionsDir, { recursive: true });
  const port = yield* startup(options, realLayers(options, exportServices));

  // sessionsDir の外は読ませない。無いファイルは本文なしの 404 にする（ブラウザの本文に <pre> が出ない）
  const files = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<ReturnType<typeof createHttpServer>>((resolve) => {
          const http = createHttpServer((req, res) => {
            const path = normalize(join(sessionsDir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)));
            try {
              if (!path.startsWith(sessionsDir + sep)) throw new Error("outside");
              const body = readFileSync(path);
              res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(body);
            } catch {
              res.writeHead(404).end();
            }
          });
          http.listen(0, "127.0.0.1", () => resolve(http));
        }),
    ),
    (http) => Effect.promise(() => new Promise<void>((resolve) => http.close(() => resolve()))),
  );
  const filesPort = (files.address() as { port: number }).port;

  mkdirSync(join(e2eDir, ".run"), { recursive: true });
  writeFileSync(runInfoPath, JSON.stringify({ port, sessionsDir, filesPort, events: eventCount }));

  // web/vite.config.ts は LIVE_MINDMAP_PORT を読んで /ws の proxy 先にする
  process.env.LIVE_MINDMAP_PORT = String(port);
  yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const vite = await createServer({ root: webDir, server: { host: "127.0.0.1", port: webPort, strictPort: true } });
      await vite.listen();
      return vite;
    }),
    (vite) => Effect.promise(() => vite.close()),
  );
  return yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(program));
