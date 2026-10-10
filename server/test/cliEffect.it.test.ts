import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Console, Deferred, Duration, Effect, Fiber, Layer, Predicate, Result } from "effect";
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

// 登録済みの待ち（sleep）の長さ（ミリ秒）。TestClock に委譲しつつ、目覚めるか中断されるまで一覧に残す。
// TestClock を進める前に、依存する待ち（静穏待ち・次の再生待ち）が登録済みであることを状態で確かめるために使う
const trackedClock = (clock: Clock.Clock, pending: number[]): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
  currentTimeMillis: clock.currentTimeMillis,
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
  currentTimeNanos: clock.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) => Effect.suspend(() => {
    const millis = Math.round(Duration.toMillis(duration));
    pending.push(millis);
    return clock.sleep(duration).pipe(Effect.ensuring(Effect.sync(() => {
      const index = pending.indexOf(millis);
      if (index >= 0) pending.splice(index, 1);
    })));
  }),
});

// 登録済みの待ちが expected（順不同）と一致するまで、実時間で確かめ直す。上限に達したらテストを失敗させる
const sleepsRegistered = (pending: readonly number[], expected: readonly number[]) => Effect.gen(function* () {
  const key = (values: readonly number[]) => [...values].sort((x, y) => x - y).join(",");
  for (let i = 0; i < 500; i++) {
    if (key(pending) === key(expected)) return;
    yield* TestClock.withLive(Effect.sleep(10));
  }
  return yield* Effect.die(new Error(`待ちが登録されなかった: 期待 [${expected.join(", ")}]、実際 [${pending.join(", ")}]`));
});

// 受けた依頼（メソッド・パス・本文）を記録し、決めた応答を返す偽の HTTP サーバー。ポートは 0 で待ち受けて実際の番号を返す
interface FakeResponse { readonly status: number; readonly contentType: string; readonly body: string }
const fakeServer = (respond: FakeResponse) => Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly requests: { method: string; url: string; body: string }[]; close: () => Promise<void> }>((resume) => {
    const requests: { method: string; url: string; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(respond.status, { "content-type": respond.contentType });
        res.end(respond.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
      }));
    });
  }),
  (server) => Effect.promise(() => server.close()),
);

function dependencies(sessionsDir: string, port = "12345") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captures: Snapshot[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(
    NodeServices.layer, unusedApple,
    NodeHttpClient.layerUndici,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(sessionsDir, "home"), LIVE_MINDMAP_CONFIG: join(sessionsDir, "absent.config.json"), LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: port })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(MapCapture, MapCapture.of({
      capture: (snapshot: Snapshot, path: string) => Effect.sync(() => {
        captures.push(snapshot);
        writeFileSync(path, "");
      }),
    })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("<!doctype html><html><body></body></html>") })),
    fakeAudioMix().layer,
    fakeScreenJpeg().layer,
  );
  return { layer, stdout, stderr, captures };
}

beforeEach(() => {
  external.openClaudeUpdater.mockReset();
  external.openListener.mockReset();
  external.openClaudeUpdater.mockReturnValue({ update: () => Effect.succeed({ ops: [] }), close: () => {} });
  external.openListener.mockImplementation(fakeListener().open);
});
afterEach(() => vi.restoreAllMocks());

describe("CLI の Effect 境界", () => {
  it.effect("ConfigProvider の保存先と MapCapture の Layer が play の最終出力へ届く", () => Effect.gen(function* () {
    const dir = yield* directory;
    const deps = dependencies(dir);
    const calls: string[][] = [];
    external.openClaudeUpdater.mockReturnValue({
      update: (input: DiffInput) => Effect.sync(() => {
        calls.push(input.fresh.map((remark) => remark.id));
        return { ops: [] };
      }),
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
    const server = yield* fakeServer({ status: 200, contentType: "application/json", body: JSON.stringify({ dir: join(dir, "run") }) });
    const deps = dependencies(dir, String(server.port));
    yield* runCli(["start", "--app", "us.zoom.xos"]).pipe(Effect.provide(deps.layer));

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(`http://127.0.0.1:${server.port}${request!.url}`).toBe(`http://127.0.0.1:${server.port}/session/start`);
    expect(request!.method).toBe("POST");
    expect(JSON.parse(request!.body)).toEqual({ app: "us.zoom.xos", audio: true, screen: true, model: defaultClaude });
    expect(deps.stdout.join("")).toBe(join(dir, "run") + "\n");
  }));

  it.effect("--no-screen を付けると開始の本文は screen: false になり、録音の指定とは独立している", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 200, contentType: "application/json", body: JSON.stringify({ dir: join(dir, "run") }) });
    const deps = dependencies(dir, String(server.port));
    yield* runCli(["start", "--app", "us.zoom.xos", "--no-screen"]).pipe(Effect.provide(deps.layer));
    yield* runCli(["start", "--app", "us.zoom.xos", "--no-screen", "--no-audio"]).pipe(Effect.provide(deps.layer));

    expect(server.requests).toHaveLength(2);
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ app: "us.zoom.xos", audio: true, screen: false, model: defaultClaude });
    expect(JSON.parse(server.requests[1]!.body)).toEqual({ app: "us.zoom.xos", audio: false, screen: false, model: defaultClaude });
  }));

  it.effect("2xx 以外の応答は、本文の error をそのまま ServerFailed の 1 行にする", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "すでに録音中です" }) });
    const deps = dependencies(dir, String(server.port));
    const failure = yield* runCli(["stop"]).pipe(Effect.provide(deps.layer), Effect.flip);

    expect(failure).toMatchObject({ _tag: "ServerFailed", message: "すでに録音中です" });
    expect(server.requests.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /session/stop"]);
  }));

  it.effect("2xx 以外で本文が JSON でなくても、状態コードから ServerFailed の 1 行を作る", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 500, contentType: "text/plain", body: "boom" });
    const deps = dependencies(dir, String(server.port));
    const failure = yield* runCli(["stop"]).pipe(Effect.provide(deps.layer), Effect.flip);

    expect(failure).toMatchObject({ _tag: "ServerFailed", message: "サーバーがエラーを返しました: 500" });
  }));

  it.effect("2xx 以外で error の無い JSON でも、状態コードから ServerFailed の 1 行を作る", () => Effect.gen(function* () {
    const dir = yield* directory;
    const server = yield* fakeServer({ status: 503, contentType: "application/json", body: "{}" });
    const deps = dependencies(dir, String(server.port));
    const failure = yield* runCli(["status"]).pipe(Effect.provide(deps.layer), Effect.flip);

    expect(failure).toMatchObject({ _tag: "ServerFailed", message: "サーバーがエラーを返しました: 503" });
  }));

  for (const [label, body, expected] of [
    ["JSON でない本文", "not json", "{}\n"],
    ["空本文", "", "{}\n"],
    ["JSON の null", "null", "null\n"],
  ] as const) {
    it.effect(`2xx で ${label} のとき、apps は {} 相当（null は null のまま）を出して成功する`, () => Effect.gen(function* () {
      const dir = yield* directory;
      const server = yield* fakeServer({ status: 200, contentType: "text/plain", body });
      const deps = dependencies(dir, String(server.port));
      yield* runCli(["apps"]).pipe(Effect.provide(deps.layer));

      expect(deps.stdout.join("")).toBe(expected);
    }));
  }

  it.effect("2xx で JSON でない本文の start は、{} のときと同じ文面の ServerFailed になる", () => Effect.gen(function* () {
    const dir = yield* directory;
    const notJson = yield* fakeServer({ status: 200, contentType: "text/plain", body: "not json" });
    const empty = yield* fakeServer({ status: 200, contentType: "application/json", body: "{}" });
    const first = yield* runCli(["start", "--app", "us.zoom.xos"]).pipe(Effect.provide(dependencies(dir, String(notJson.port)).layer), Effect.flip);
    const second = yield* runCli(["start", "--app", "us.zoom.xos"]).pipe(Effect.provide(dependencies(dir, String(empty.port)).layer), Effect.flip);

    expect(first).toMatchObject({ _tag: "ServerFailed" });
    expect((first as { message: string }).message.startsWith("サーバーの応答が読めません: ")).toBe(true);
    expect(first).toEqual(second);
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
    external.openClaudeUpdater.mockReturnValue({ update: () => Effect.succeed({ ops: [] }), close });
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
    const update = vi.fn((_input: DiffInput) => Effect.suspend(() => {
      expect(close).not.toHaveBeenCalled();
      return update.mock.calls.length === 1
        ? Effect.fail({ _tag: "FakeUpdateFailed", message: "更新に失敗" })
        : Effect.succeed({ ops: [] as Op[] });
    }));
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
      update: (input: DiffInput) => Effect.sync(() => {
        calls.push(input.fresh.map((remark) => remark.id));
        Deferred.doneUnsafe(reflected, Effect.void);
        return { ops: [] };
      }),
      close: () => {},
    });
    const pending: number[] = [];
    const tracked = yield* TestClock.testClockWith((testClock) => Effect.succeed(trackedClock(testClock, pending)));
    const fiber = yield* runCli(["play", fixture, "--realtime"]).pipe(Effect.provide(deps.layer), Effect.provideService(Clock.Clock, tracked), Effect.forkChild);
    yield* Deferred.await(root);
    yield* sleepsRegistered(pending, [9800]);
    yield* TestClock.adjust(9800);
    yield* sleepsRegistered(pending, [QUIET_MS, 9400]);
    yield* TestClock.adjust(QUIET_MS - 1);
    expect(calls).toEqual([]);
    yield* TestClock.adjust(1);
    yield* Deferred.await(reflected);
    expect(calls).toEqual([["r1"]]);
    yield* sleepsRegistered(pending, [9400]);
    yield* TestClock.adjust(9400 - QUIET_MS);
    yield* sleepsRegistered(pending, [QUIET_MS, 8800]);
    yield* TestClock.adjust(8800);
    yield* Fiber.join(fiber);
    expect(calls).toEqual([["r1"], ["r2"], ["r3"]]);
    expect(deps.captures).toHaveLength(1);
  }));
});
