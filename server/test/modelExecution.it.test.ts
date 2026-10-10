import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Layer, Queue, Stream, type Cause } from "effect";
import { beforeEach, vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import type { DiffOutput } from "../src/core/index.ts";
import { claudeUpdaterLayer } from "../src/diffUpdater.ts";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { EXPORT_FILE } from "../src/sessionFiles.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { startedServer } from "./fixtures/startedServer.ts";

type Message = { message: { content: unknown } };
type QueryRecord = { model: string; messages: Message[]; closed: number };
const sdk = vi.hoisted(() => ({ created: [] as QueryRecord[], responses: [] as DiffOutput[], afterMessage: () => {} }));

// Keep selection, the updater, recording and eval real; replace only the external SDK call.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: AsyncIterable<Message>; options: { model: string } }) => {
    const record: QueryRecord = { model: params.options.model, messages: [], closed: 0 };
    sdk.created.push(record);
    const gen = (async function* () {
      for await (const message of params.prompt) {
        record.messages.push(message);
        sdk.afterMessage();
        yield { type: "assistant", message: { model: record.model, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
        yield { type: "result", subtype: "success", structured_output: sdk.responses.shift() ?? { ops: [{ op: "noop", reason: "合成テスト" }] } };
      }
    })();
    return Object.assign(gen, { close: () => { record.closed++; } });
  },
}));
vi.mock("../src/http.ts", async (importOriginal) => {
  const { fakeListener } = await import("./fakeListener.ts");
  return { ...await importOriginal<typeof import("../src/http.ts")>(), openListener: fakeListener().open };
});

beforeEach(() => { sdk.created.length = 0; sdk.responses.length = 0; sdk.afterMessage = () => {}; });
const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-model-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);
const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");

function dependencies(root: string, env: Record<string, string>) {
  const sessions = join(root, "sessions");
  const stdout: string[] = [];
  const layer = Layer.mergeAll(
    NodeServices.layer, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_SESSIONS: sessions, LIVE_MINDMAP_PORT: "0", ...env })),
    Layer.succeed(Console.Console, { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); } }),
  );
  return { sessions, stdout, layer };
}

const writeConfig = (root: string) => writeFileSync(join(root, "config.json"), JSON.stringify({
  default: "careful", models: {
    fast: { route: "claude", model: "claude-haiku-5-5" },
    careful: { route: "claude", model: "claude-opus-5-5" },
  },
}));
const starts = (session: string) => {
  const events = readFileSync(join(session, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({ type: "start" });
  return events.filter((event) => event.type === "start");
};

function fakeHelpers(events: unknown[]) {
  const calls: string[][] = [];
  const layer = Layer.succeed(Helpers, Helpers.of({
    apps: Effect.succeed([]),
    launch: (args) => Effect.gen(function* () {
      calls.push([...args]);
      const queue = yield* Queue.make<string, Cause.Done>();
      for (const event of events) Queue.offerUnsafe(queue, JSON.stringify(event));
      const exited = yield* Deferred.make<HelperExitInfo>();
      const stop = Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, { code: null, signal: "SIGTERM" })));
      yield* Effect.addFinalizer(() => stop);
      return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed([]) };
    }),
  }));
  return { calls, layer };
}

describe("選択したモデルの実行と記録（Issue #663）", () => {
  it.live("start --model は HTTP とライブの記録境界を通って SDK と開始ログへ届く", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    writeConfig(root);
    const sessionsDir = join(root, "sessions");
    const helpers = fakeHelpers([{ type: "remark", track: "相手", start: 0, end: 9, text: "合成の発言です" }]);
    const server = yield* startedServer({ port: 0, sessionsDir }, {
      helpers: helpers.layer,
      managedDeps: forbiddenManagedDeps,
      sessionSinks: SessionSinks.layer({ prepareUpdater: (model) => { if (model.route !== "claude") throw new Error("このfixtureはClaude専用です"); return Effect.succeed(claudeUpdaterLayer(model)); } }).pipe(Layer.provide(fakeExportServices())),
    });
    const deps = dependencies(root, { LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_MODEL: "careful" });
    yield* runCli(["start", "--app", "us.zoom.xos", "--no-audio", "--model", "fast"]).pipe(Effect.provide(deps.layer));
    const session = deps.stdout.join("").trim();
    yield* runCli(["stop"]).pipe(Effect.provide(deps.layer));
    expect(sdk.created.map((query) => query.model)).toEqual(["claude-haiku-5-5"]);
    expect(sdk.created[0]!.messages).toHaveLength(1);
    expect(starts(session)).toEqual([expect.objectContaining({ model: { name: "fast", route: "claude", local: false } })]);
  }));

  it.live("HTTP から未対応モデルを送ってもフォルダ・ログ・ヘルパーを作らず、Claude なら開始する", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const sessionsDir = join(root, "sessions");
    const helpers = fakeHelpers([]);
    const server = yield* startedServer({ port: 0, sessionsDir }, {
      helpers: helpers.layer,
      managedDeps: forbiddenManagedDeps,
      sessionSinks: SessionSinks.layer({ prepareUpdater: (model) => { if (model.route !== "claude") throw new Error("このfixtureはClaude専用です"); return Effect.succeed(claudeUpdaterLayer(model)); } }).pipe(Layer.provide(fakeExportServices())),
    });
    const post = (model: unknown) => Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/start`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "us.zoom.xos", audio: false, model }),
    }));
    for (const model of [
      { name: "subscription", route: "chatgpt", model: "gpt-test", local: false },
      { name: "apple", route: "apple", local: true },
      { name: "compatible", route: "openai-compatible", model: "synthetic-model", url: "http://127.0.0.1:1/v1", local: true },
    ]) {
      const response = yield* post(model);
      expect(response.status).toBe(400);
      expect((yield* Effect.tryPromise(() => response.json()))).toMatchObject({ error: expect.stringMatching(model.local && model.name !== "apple" ? /ローカルモード/ : /まだ/) });
    }
    expect(helpers.calls).toHaveLength(0);
    expect(existsSync(sessionsDir)).toBe(false);
    expect(sdk.created).toEqual([]);
    const allowed = yield* post({ name: "claude", route: "claude", model: "claude-sonnet-5-5", local: false });
    expect(allowed.status).toBe(200);
    expect(helpers.calls).toHaveLength(1);
    expect(readdirSync(sessionsDir)).toHaveLength(1);
  }));

  it.effect("play --model の選択が SDK と新しい開始ログへ届く", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    writeConfig(root);
    const deps = dependencies(root, { LIVE_MINDMAP_MODEL: "careful" });

    yield* runCli(["play", fixture, "--model", "fast"]).pipe(Effect.provide(deps.layer));

    expect(sdk.created.map((query) => query.model)).toEqual(["claude-haiku-5-5"]);
    expect(sdk.created[0]!.messages).toHaveLength(2);
    const session = dirname(deps.stdout.join("").trim().split("\n")[0]!);
    expect(starts(session)).toEqual([expect.objectContaining({ type: "start", model: { name: "fast", route: "claude", local: false } })]);
    expect(sdk.created.map((query) => query.closed)).toEqual([1]);
  }));

  it.effect("設定なし・指定なしの play は従来の Claude を実行し記録する", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const deps = dependencies(root, {});
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
    expect(sdk.created.map((query) => query.model)).toEqual(["claude-sonnet-5-5"]);
    const session = dirname(deps.stdout.join("").trim().split("\n")[0]!);
    expect(starts(session)).toEqual([expect.objectContaining({ model: { name: "claude", route: "claude", local: false } })]);
  }));

  it.effect("invModelFixed: 同じ再生中に設定ファイルを変えても query の開き直し後までモデルは固定", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    writeConfig(root);
    const transcript = join(root, "long.transcript.json");
    writeFileSync(transcript, JSON.stringify({
      schema_version: 1, duration: 640, source_path: "synthetic.m4a",
      transcript: { tracks: ["speaker"], diagnostics: {}, segments: Array.from({ length: 32 }, (_, n) => ({
        track: "speaker", start_seconds: n * 20, end_seconds: n * 20 + 10,
        text: `合成の発言 ${n}`, confidence: 0.9,
      })) },
    }));
    const deps = dependencies(root, { LIVE_MINDMAP_MODEL: "fast" });
    let changed = false;
    sdk.afterMessage = () => {
      if (changed) return;
      writeFileSync(join(root, "config.json"), JSON.stringify({ models: { fast: { route: "claude", model: "claude-opus-5-5" } } }));
      changed = true;
    };
    yield* runCli(["play", transcript]).pipe(Effect.provide(deps.layer));
    expect(changed).toBe(true);
    expect(sdk.created.length).toBeGreaterThan(1);
    expect(sdk.created.map((query) => query.model)).toEqual(sdk.created.map(() => "claude-haiku-5-5"));
    expect(sdk.created.every((query) => query.messages.length > 0 && query.closed === 1)).toBe(true);
  }));

  it.effect.each([1, 2])("eval --model は元の成果物を変えず、選択モデルが追加した %i ノードを新しいランの評価行に出す", (nodeCount) => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    writeConfig(root);
    const deps = dependencies(root, {});
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
    const source = dirname(deps.stdout.join("").trim().split("\n")[0]!);
    const before = Object.fromEntries(readdirSync(source).map((name) => [name, readFileSync(join(source, name), "utf8")]));
    expect(JSON.parse(before[EXPORT_FILE]!).root.children).toEqual([]);
    sdk.created.length = 0;
    deps.stdout.length = 0;
    sdk.responses.push({ ops: Array.from({ length: nodeCount }, (_, n) => ({
      op: "add", ref: `topic${n + 1}`, parent: "root", kind: "議題", text: "採用", evidence: ["r1"],
    })) }, { ops: [{ op: "noop", reason: "合成テスト" }] });

    yield* runCli(["eval", source, "--model", "fast"]).pipe(Effect.provide(deps.layer));

    expect(sdk.created.map((query) => query.model)).toEqual(["claude-haiku-5-5"]);
    expect(sdk.created[0]!.messages).toHaveLength(2);
    expect(sdk.created[0]!.messages[0]!.message.content).toContain("今日は採用の進め方を決めます");
    const after = Object.fromEntries(readdirSync(source).map((name) => [name, readFileSync(join(source, name), "utf8")]));
    expect(after).toEqual(before);
    const newSessions = readdirSync(deps.sessions).map((name) => join(deps.sessions, name)).filter((dir) => dir !== source);
    expect(newSessions).toHaveLength(1);
    expect(starts(newSessions[0]!)).toEqual([expect.objectContaining({ model: { name: "fast", route: "claude", local: false } })]);
    const lines = deps.stdout.join("").trim().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => line.startsWith("|") && line.endsWith("|"))).toBe(true);
    const rows = lines.slice(2).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slice(0, 3)).toEqual([basename(newSessions[0]!), "short", String(nodeCount)]);
  }));

  it.effect("モデルフラグの無い eval は環境変数・default があっても保存済み結果の集計だけを行う", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    writeConfig(root);
    const deps = dependencies(root, { LIVE_MINDMAP_MODEL: "fast" });
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));
    const source = dirname(deps.stdout.join("").trim().split("\n")[0]!);
    sdk.created.length = 0;
    deps.stdout.length = 0;
    yield* runCli(["eval", source]).pipe(Effect.provide(deps.layer));
    expect(deps.stdout.join("")).toMatch(/^\| ラン \| 会議 \|/);
    expect(sdk.created).toEqual([]);
    expect(readdirSync(deps.sessions)).toHaveLength(1);
  }));
});
