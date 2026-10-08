import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Fiber, Layer, Predicate, Result } from "effect";
import { CliError } from "effect/cli";
import { HttpServerError } from "effect/http";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { ReviewBuild } from "../src/review.ts";
import { runCli } from "../src/cli.ts";
import { QUIET_MS, type DiffInput, type Op, type Snapshot } from "../src/core/index.ts";
import { fakeListener } from "./fakeListener.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

const external = vi.hoisted(() => ({ openClaudeUpdater: vi.fn(), openListener: vi.fn() }));
vi.mock("../src/claude.ts", async () => (await import("./fixtures/claudeModule.ts")).fakeClaudeModule(() => external.openClaudeUpdater()));
// 配信の待受け（openListener）だけを偽物にする。serveFeed・portOf は本物のまま
vi.mock("../src/http.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/http.ts")>(),
  openListener: external.openListener,
}));

const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");
const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-effect-cli-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

function dependencies(sessionsDir: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captures: Snapshot[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: "12345" })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(MapCapture, MapCapture.of({
      capture: (snapshot: Snapshot, path: string) => Effect.sync(() => {
        captures.push(snapshot);
        writeFileSync(path, "");
      }),
    })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: () => Effect.succeed("<!doctype html><html><body></body></html>") })),
    fakeAudioMix().layer,
    fakeScreenJpeg().layer,
  );
  return { layer, stdout, stderr, captures };
}

beforeEach(() => {
  external.openClaudeUpdater.mockReset();
  external.openListener.mockReset();
  external.openClaudeUpdater.mockReturnValue({ update: async () => ({ ops: [] }), close: () => {} });
  external.openListener.mockImplementation(fakeListener().open);
});
afterEach(() => vi.restoreAllMocks());

describe("CLI の Effect 境界", () => {
  it.effect("ConfigProvider の保存先と MapCapture の Layer が play の最終出力へ届く", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const calls: string[][] = [];
    external.openClaudeUpdater.mockReturnValue({
      update: async (input: DiffInput) => {
        calls.push(input.fresh.map((remark) => remark.id));
        return { ops: [] };
      },
      close: () => {},
    });
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

    expect(calls).toEqual([["r1", "r2"], ["r3"]]);
    expect(external.openListener.mock.calls[0]?.[0]).toBe(12345);
    expect(deps.captures).toHaveLength(1);
    expect(deps.captures[0]?.nodes.map((node) => node.text)).toEqual(["short"]);
    const paths = deps.stdout.join("").trimEnd().split("\n");
    expect(paths).toHaveLength(5);
    const session = join(paths[0]!, "..");
    expect(session.startsWith(dir + "/")).toBe(true);
    expect(paths).toEqual(["map.md", "map.json", "map.drawnix", "map.png", "map.html"].map((name) => join(session, name)));
    expect(deps.stdout.join("")).toBe(paths.map((path) => path + "\n").join(""));
  }));

  it.effect("ConfigProvider のポートへ start を送り、no-audio の省略は録音ありになる", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ dir: join(dir, "run") }));
    yield* runCli(["start", "--app", "us.zoom.xos"]).pipe(Effect.provide(deps.layer));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:12345/session/start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ app: "us.zoom.xos", audio: true, screen: true });
    expect(deps.stdout.join("")).toBe(join(dir, "run") + "\n");
  }));

  it.effect("--no-screen を付けると開始の本文は screen: false になり、録音の指定とは独立している", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ dir: join(dir, "run") }));
    yield* runCli(["start", "--app", "us.zoom.xos", "--no-screen"]).pipe(Effect.provide(deps.layer));
    yield* runCli(["start", "--app", "us.zoom.xos", "--no-screen", "--no-audio"]).pipe(Effect.provide(deps.layer));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ app: "us.zoom.xos", audio: true, screen: false });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ app: "us.zoom.xos", audio: false, screen: false });
  }));

  it.effect("Console と ConfigProvider を提供した export は余分なデータも改行も保持する", () => Effect.gen(function* () {
    const dir = yield* directory;
    const latest = join(dir, "run");
    mkdirSync(latest);
    const exported = { root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [] }, measurement: { seconds: 42 } };
    writeFileSync(join(latest, "export.json"), JSON.stringify(exported));
    const deps = dependencies(dir);
    yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));

    expect(deps.stdout.join("")).toBe(JSON.stringify(exported, null, 2) + "\n");
    expect(deps.stderr).toEqual([]);
  }));

  it.effect.each([
    { name: "JSON 構文", text: "{ not json" },
    { name: "必須キー", text: JSON.stringify({ TODO: [] }) },
    { name: "keywords", text: JSON.stringify({ 決定: [{ from: 1, to: 2, keywords: [] }], TODO: [] }) },
  ])("不正 truth（$name）は defect や CliError ではなくタグ付き失敗として返る", ({ text }) => Effect.gen(function* () {
    const dir = yield* directory;
    const truth = join(dir, "bad.truth.json");
    writeFileSync(truth, text);
    writeFileSync(join(dir, "export.json"), JSON.stringify({ root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [] } }));
    const deps = dependencies(dir);
    const result = yield* Effect.result(runCli(["eval", "--truth", truth, dir]).pipe(Effect.provide(deps.layer)));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(Predicate.hasProperty(result.failure, "_tag")).toBe(true);
    if (!Predicate.hasProperty(result.failure, "_tag")) return;
    expect(typeof result.failure._tag).toBe("string");
    expect(CliError.isCliError(result.failure)).toBe(false);
    expect(deps.stdout).toEqual([]);
    expect(deps.stderr).toEqual([]);
  }));

  it.effect("truth の省略された text を正規化し、keywords と時刻を評価へ渡す", () => Effect.gen(function* () {
    const dir = yield* directory;
    const truth = join(dir, "valid.truth.json");
    writeFileSync(truth, JSON.stringify({ 決定: [], TODO: [{ from: 1, to: 2, keywords: [["求人", "採用"]] }] }));
    writeFileSync(join(dir, "export.json"), JSON.stringify({
      root: { id: "root", kind: "会議", text: "定例", evidence: [], children: [
        { id: "n1", kind: "TODO", text: "採用を進める", evidence: [{ id: "r1", track: "相手", start: 1, end: 2, text: "採用" }], children: [] },
      ] },
    }));
    const deps = dependencies(dir);
    yield* runCli(["eval", "--truth", truth, dir]).pipe(Effect.provide(deps.layer));
    expect(deps.stdout.join("").trimEnd().split("\n").at(-1)).toMatch(/\| 0\/0 \| 1\/1 \(100%\) \|$/);
    expect(deps.stderr).toEqual([]);
  }));

  it.effect("updater の取得後に配信開始が失敗しても、取得した updater を一度だけ解放する", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const close = vi.fn();
    external.openClaudeUpdater.mockReturnValue({ update: async () => ({ ops: [] }), close });
    external.openListener.mockReturnValue(Effect.fail(new HttpServerError.ServeError({ cause: new Error("配信開始に失敗") })));
    const result = yield* Effect.result(runCli(["play", fixture]).pipe(Effect.provide(deps.layer)));

    expect(external.openClaudeUpdater).toHaveBeenCalledTimes(1);
    expect(external.openListener).toHaveBeenCalledTimes(1);
    expect(Result.isFailure(result)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(deps.captures).toEqual([]);
  }));

  it.effect("失敗した更新は記録して公開せず、次の成功と最終撮影まで updater を保持する", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const close = vi.fn(() => { expect(deps.captures).toHaveLength(1); });
    const update = vi.fn(async () => {
      expect(close).not.toHaveBeenCalled();
      if (update.mock.calls.length === 1) throw new Error("更新に失敗");
      return { ops: [] as Op[] };
    });
    external.openClaudeUpdater.mockReturnValue({ update, close });
    const { open, published } = fakeListener();
    external.openListener.mockImplementation(open);
    yield* runCli(["play", fixture]).pipe(Effect.provide(deps.layer));

    expect(update).toHaveBeenCalledTimes(2);
    expect(published.map((snapshot) => snapshot.round)).toEqual([0, 1]);
    expect(deps.captures.map((snapshot) => snapshot.round)).toEqual([1]);
    expect(close).toHaveBeenCalledTimes(1);
    const log = readFileSync(join(deps.stdout.join("").split("\n")[0]!, "..", "log.jsonl"), "utf8");
    expect(log).toContain("更新に失敗");
  }));

  it.effect("realtime は再生間隔と静穏待ちを同じ TestClock で進め、二つの待ちを直列にしない", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const root = yield* Deferred.make<void>();
    const reflected = yield* Deferred.make<void>();
    const calls: string[][] = [];
    external.openListener.mockImplementation(fakeListener((snapshot) => {
      if (snapshot.round === 0) Deferred.doneUnsafe(root, Effect.void);
    }).open);
    external.openClaudeUpdater.mockReturnValue({
      update: async (input: DiffInput) => {
        calls.push(input.fresh.map((remark) => remark.id));
        Deferred.doneUnsafe(reflected, Effect.void);
        return { ops: [] };
      },
      close: () => {},
    });
    const fiber = yield* runCli(["play", fixture, "--realtime"]).pipe(Effect.provide(deps.layer), Effect.forkChild);
    yield* Deferred.await(root);
    yield* TestClock.adjust(9800);
    yield* TestClock.adjust(QUIET_MS - 1);
    expect(calls).toEqual([]);
    yield* TestClock.adjust(1);
    yield* Deferred.await(reflected);
    expect(calls).toEqual([["r1"]]);
    yield* TestClock.adjust(9400 - QUIET_MS);
    yield* TestClock.adjust(8800);
    yield* Fiber.join(fiber);
    expect(calls).toEqual([["r1"], ["r2"], ["r3"]]);
    expect(deps.captures).toHaveLength(1);
  }));
});
