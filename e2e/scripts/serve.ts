import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer, Schema } from "effect";
import { Command, Flag } from "effect/cli";
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
const positiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

const update = (input: DiffInput, discussion: boolean) => {
  if (discussion) {
    const evidence = [input.fresh[0]!.id];
    const ops: Op[] = input.map.order.length > 1 ? [] : [
      { op: "add", ref: "point", parent: "root", kind: "論点", text: "導入の進め方", evidence },
      ...["段階導入", "一括導入", "試験導入"].map((text, i): Op => ({ op: "add", ref: `plan-${i}`, parent: "point", kind: "案", text, evidence })),
    ];
    return Effect.succeed({ ops });
  }
  if (input.criteria?.length) {
    const evidence = [input.fresh[0]!.id];
    const plan = input.map.nodes.n3;
    const ops: Op[] = plan === undefined ? [
      { op: "add", ref: "topic", parent: "root", kind: "議題", text: "導入方針", evidence },
      { op: "add", ref: "point", parent: "topic", kind: "論点", text: "導入の進め方", evidence },
      { op: "add", ref: "plan", parent: "point", kind: "案", text: "段階的に導入する", evidence },
    ] : [{ op: "update", node: plan.id, evidence, criteria: plan.evidence.length < 3 ? input.criteria.slice(plan.evidence.length - 1, plan.evidence.length) : [] }];
    return Effect.as(Effect.sleep("6 seconds"), { ops, processedRemarks: 1 });
  }
  return Effect.succeed({
    ops: input.fresh.map((remark): Op => ({ op: "add", ref: `n-${remark.id}`, parent: "root", kind: "要点", text: remark.text, evidence: [remark.id] })),
  });
};

const layerChildProcessSpawner = NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

const program = Command.make("serve", {
  webPort: Flag.String("web-port").pipe(Flag.map(Number), Flag.withSchema(positiveInt)),
  eventCount: Flag.String("events").pipe(Flag.map(Number), Flag.withSchema(positiveInt)),
}, ({ webPort, eventCount }) => Effect.gen(function* () {
  const discussion = (yield* Config.String("LIVE_MINDMAP_VERIFY_DISCUSSION").pipe(Config.withDefault(""))) === "1";
  const realHelper = (yield* Config.String("LIVE_MINDMAP_VERIFY_REAL_HELPER").pipe(Config.withDefault(""))) === "1";
  const runInfoPath = join(e2eDir, ".run", `${webPort}.json`);
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "live-mindmap-e2e-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(runInfoPath, { force: true })));

  const sessionsDir = join(root, "sessions");
  const scriptPath = join(root, "script.json");
  const recordPath = join(root, "record.jsonl");
  const fixture = yield* Effect.sync(() => JSON.parse(readFileSync(join(e2eDir, discussion ? "fixtures/discussion.json" : "fixtures/meeting.json"), "utf8")) as { apps: unknown; events: unknown[]; speakers: { before: number; [key: string]: unknown }[]; schedule?: unknown });
  const playedEvents = fixture.events.slice(0, eventCount).flatMap((event, index) =>
    [...fixture.speakers.filter((speaker) => speaker.before === index).map(({ before: _before, ...speaker }) => speaker), event],
  );
  yield* Effect.sync(() => {
    writeFileSync(scriptPath, JSON.stringify({ apps: fixture.apps, events: playedEvents, ...(discussion ? { schedule: fixture.schedule } : {}) }));
    writeFileSync(recordPath, "");
  });

  const helper = realHelper
    ? { command: join(e2eDir, "../helper/.build/debug/live-mindmap-helper"), args: [] }
    : { command: process.execPath, args: [fakeHelper, scriptPath, recordPath] };
  const options: ServerOptions = { port: 0, sessionsDir, depsDir: join(sessionsDir, "../deps"), prepareUpdater: () => Effect.succeed({ layer: updaterLayer((input) => update(input, discussion)) }), helper };
  const exportServices = Layer.mergeAll(MapCapture.layer.pipe(Layer.provide(Playwright.layer)), ReviewBuild.layer, AudioMix.layer(helper).pipe(Layer.provide(layerChildProcessSpawner)), Readings.layer(helper).pipe(Layer.provide(layerChildProcessSpawner))).pipe(
    Layer.provideMerge(NodeFileSystem.layer),
  );
  yield* Effect.sync(() => mkdirSync(sessionsDir, { recursive: true }));
  const layers = realLayers(options, exportServices);
  const port = yield* startup(options, { ...layers, managedDeps: withFakeClaude(layers.managedDeps) });

  const serveFile = (urlPath: string, res: ServerResponse) => Effect.try(() => {
    const path = normalize(join(sessionsDir, decodeURIComponent(urlPath)));
    if (!path.startsWith(sessionsDir + sep)) throw new Error("outside");
    return { path, body: readFileSync(path) };
  }).pipe(Effect.matchEffect({
    onFailure: () => Effect.sync(() => { res.writeHead(404).end(); }),
    onSuccess: ({ path, body }) => Effect.sync(() => {
      res.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" }).end(body);
    }),
  }));
  const files = yield* Effect.acquireRelease(
    Effect.sync(() => createHttpServer((req, res) => Effect.runSync(serveFile(new URL(req.url ?? "/", "http://x").pathname, res)))),
    (http) => Effect.callback<void>((resume) => {
      http.close((error) => resume(error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING") ? Effect.die(error) : Effect.void));
    }),
  );
  yield* Effect.callback<void, Error>((resume) => {
    const failed = (error: Error) => resume(Effect.fail(error));
    files.once("error", failed);
    files.listen(0, "127.0.0.1", () => resume(Effect.void));
    return Effect.sync(() => { files.off("error", failed); });
  });
  const address = yield* Effect.sync(() => files.address());
  if (address === null || typeof address === "string") return yield* Effect.die("file server has no TCP address");
  const filesPort = address.port;

  yield* Effect.sync(() => {
    mkdirSync(join(e2eDir, ".run"), { recursive: true });
    writeFileSync(runInfoPath, JSON.stringify({ port, sessionsDir, filesPort, events: eventCount }));
  });

  yield* Effect.sync(() => { process.env.LIVE_MINDMAP_PORT = String(port); });
  const vite = yield* Effect.acquireRelease(
    Effect.promise(() => {
      // /session-files/ は同じ配信を web と同じ origin（ポート）でも返す。replay cache は origin 込みで画面を照合するため、ポートが毎回変わるファイル配信の origin では agent.act の記録が再生できない
      const sessionFiles = { name: "session-files", configureServer: (server: ViteDevServer) => void server.middlewares.use("/session-files", (req, res) => Effect.runSync(serveFile(new URL(req.url ?? "/", "http://x").pathname, res))) };
      return createServer({ root: webDir, plugins: [sessionFiles], server: { host: "127.0.0.1", port: webPort, strictPort: true } });
    }),
    (vite) => Effect.promise(() => vite.close()),
  );
  yield* Effect.promise(() => vite.listen());
  return yield* Effect.never;
}).pipe(Effect.scoped));

program.pipe(Command.run({ version: "0.0.0" }), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
