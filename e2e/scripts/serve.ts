import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { parseArgs } from "node:util";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer, type ViteDevServer } from "vite";
import { AudioMix } from "../../server/src/audioMix.ts";
import { Readings } from "../../server/src/readings.ts";
import { MapCapture } from "../../server/src/capture.ts";
import { Playwright } from "../../server/src/playwright.ts";
import type { DiffInput, Op } from "../../server/src/core/index.ts";
import { ReviewBuild } from "../../server/src/review.ts";
import { realLayers, startup, type ServerOptions } from "../../server/src/server.ts";
import { updaterLayer } from "../../server/test/fixtures/sessionLayers.ts";
import { withFakeClaude } from "../../server/test/fixtures/readyManagedDeps.ts";

const e2eDir = join(import.meta.dirname, "..");
const webDir = join(e2eDir, "../web");
const fakeHelper = join(e2eDir, "../server/test/fixtures/fake-helper.ts");

const { values } = parseArgs({ options: { "web-port": { type: "string" }, events: { type: "string" } } });
const webPort = Number(values["web-port"]);
const eventCount = Number(values.events);
if (!Number.isInteger(webPort) || webPort <= 0 || !Number.isInteger(eventCount) || eventCount <= 0) {
  throw new Error("usage: serve.ts --web-port <n> --events <n>");
}
const runInfoPath = join(e2eDir, ".run", `${webPort}.json`);

const update = (input: DiffInput) =>
  Effect.succeed({
    ops: input.fresh.map((remark): Op => ({ op: "add", ref: `n-${remark.id}`, parent: "root", kind: "要点", text: remark.text, evidence: [remark.id] })),
  });

const layerChildProcessSpawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

const program = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "live-mindmap-e2e-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(runInfoPath, { force: true })));

  const sessionsDir = join(root, "sessions");
  const scriptPath = join(root, "script.json");
  const recordPath = join(root, "record.jsonl");
  const fixture = JSON.parse(readFileSync(join(e2eDir, "fixtures/meeting.json"), "utf8")) as { apps: unknown; events: unknown[]; speakers: { before: number; [key: string]: unknown }[] };
  const playedEvents = fixture.events.slice(0, eventCount).flatMap((event, index) =>
    [...fixture.speakers.filter((speaker) => speaker.before === index).map(({ before: _before, ...speaker }) => speaker), event],
  );
  writeFileSync(scriptPath, JSON.stringify({ apps: fixture.apps, events: playedEvents }));
  writeFileSync(recordPath, "");

  const helper = { command: process.execPath, args: [fakeHelper, scriptPath, recordPath] };
  const options: ServerOptions = { port: 0, sessionsDir, depsDir: join(sessionsDir, "../deps"), prepareUpdater: () => Effect.succeed({ layer: updaterLayer(update) }), helper };
  const exportServices = Layer.mergeAll(MapCapture.layer.pipe(Layer.provide(Playwright.layer)), ReviewBuild.layer, AudioMix.layer(helper).pipe(Layer.provide(layerChildProcessSpawner)), Readings.layer(helper).pipe(Layer.provide(layerChildProcessSpawner))).pipe(
    Layer.provideMerge(NodeFileSystem.layer),
  );
  mkdirSync(sessionsDir, { recursive: true });
  const layers = realLayers(options, exportServices);
  const port = yield* startup(options, { ...layers, managedDeps: withFakeClaude(layers.managedDeps) });

  const serveFile = (urlPath: string, res: ServerResponse) => {
    const path = normalize(join(sessionsDir, decodeURIComponent(urlPath)));
    try {
      if (!path.startsWith(sessionsDir + sep)) throw new Error("outside");
      const body = readFileSync(path);
      res.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  };
  const files = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<ReturnType<typeof createHttpServer>>((resolve) => {
          const http = createHttpServer((req, res) => serveFile(new URL(req.url ?? "/", "http://x").pathname, res));
          http.listen(0, "127.0.0.1", () => resolve(http));
        }),
    ),
    (http) => Effect.promise(() => new Promise<void>((resolve) => http.close(() => resolve()))),
  );
  const filesPort = (files.address() as { port: number }).port;

  mkdirSync(join(e2eDir, ".run"), { recursive: true });
  writeFileSync(runInfoPath, JSON.stringify({ port, sessionsDir, filesPort, events: eventCount }));

  process.env.LIVE_MINDMAP_PORT = String(port);
  yield* Effect.acquireRelease(
    Effect.promise(async () => {
      // /session-files/ は同じ配信を web と同じ origin（ポート）でも返す。replay cache は origin 込みで画面を照合するため、ポートが毎回変わるファイル配信の origin では agent.act の記録が再生できない
      const sessionFiles = { name: "session-files", configureServer: (server: ViteDevServer) => void server.middlewares.use("/session-files", (req, res) => serveFile(new URL(req.url ?? "/", "http://x").pathname, res)) };
      const vite = await createServer({ root: webDir, plugins: [sessionFiles], server: { host: "127.0.0.1", port: webPort, strictPort: true } });
      await vite.listen();
      return vite;
    }),
    (vite) => Effect.promise(() => vite.close()),
  );
  return yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(program));
