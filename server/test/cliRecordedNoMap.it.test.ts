import { StartupChecks } from "../src/startupChecks.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Fiber, Layer, Result, Schema } from "effect";
import { HttpClient } from "effect/http";
import { vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { DiffUpdater, JsonExport, LogEvent, type Snapshot } from "../src/core/index.ts";
import { ManagedDeps } from "../src/managedDeps.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { LOG_FILE } from "../src/sessionFiles.ts";
import { vocabularyPoolPath } from "../src/vocabularyPool.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { fakeClaudeModule } from "./fixtures/claudeModule.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { fakeReadings } from "./fixtures/readings.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { fakeHelpers, remarkEvents, type Script } from "./fixtures/recordedHelper.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { startedServer } from "./fixtures/startedServer.ts";

vi.mock("../src/claude.ts", () => fakeClaudeModule(() => ({
  update: (input) => Effect.succeed({ ops: input.fresh.map((remark) => ({ op: "add" as const, ref: remark.id, parent: "root", kind: "議題" as const, text: remark.text, evidence: [remark.id] })) }),
  close: () => {},
})));

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-no-map-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);
const waitFor = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion, { timeout: 5_000 }));
const log = (dir: string) => readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n")
  .map((line): unknown => JSON.parse(line)).filter(Schema.is(LogEvent));
const remarks = (dir: string) => log(dir).filter((line) => line.type === "remark").map((line) => line.remark);
const vocabulary = (dir: string) => log(dir).filter((line) => line.type === "vocab").flatMap((line) => line.words);
const folders = (sessionsDir: string) => readdirSync(sessionsDir).filter((name) => existsSync(join(sessionsDir, name, LOG_FILE))).map((name) => join(sessionsDir, name));
const onlyFolder = (sessionsDir: string) => {
  const dirs = folders(sessionsDir);
  expect(dirs).toHaveLength(1);
  return dirs[0]!;
};

const resource = Effect.fnUntraced(function* (script: Script, options: { missingModels?: boolean } = {}) {
  const root = yield* temporaryDirectory;
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir);
  const file = join(root, "meeting.m4a");
  const selfFile = join(root, "me.m4a");
  writeFileSync(file, "audio");
  writeFileSync(selfFile, "self audio");
  const helpers = fakeHelpers(script);
  const readings = fakeReadings({ 港南店: "kounanten", OJT: "oojiitii", Notion: "nooshon" });
  const update = vi.fn(() => Effect.succeed({ ops: [] }));
  const katakana = vi.fn(() => Effect.succeed([{ surface: "Notion", katakana: "ノーション" }]));
  const updater = Layer.succeed(DiffUpdater, DiffUpdater.of({ update, katakana }));
  const prepareUpdater = vi.fn(() => Effect.succeed({ layer: updater }));
  const capture = vi.fn((_snapshot: Snapshot, path: string) => Effect.sync(() => writeFileSync(path, "")));
  const build = vi.fn(() => Effect.succeed("<!doctype html><html><body></body></html>"));
  const exports = fakeExportServices({ readings, capture, build: Effect.suspend(build) });
  const managed = options.missingModels === true
    ? Layer.effect(ManagedDeps, Effect.map(ManagedDeps, (deps) => ManagedDeps.of({ ...deps,
        check: (names) => deps.check(names).pipe(Effect.map((items) => items.map((item) => ({ ...item, state: "missing" as const })))),
      }))).pipe(Layer.provide(readyManagedDeps))
    : readyManagedDeps;
  const server = yield* startedServer({ port: 0, sessionsDir }, {
    helpers: helpers.layer, managedDeps: managed,
    sessionSinks: SessionSinks.layer.pipe(Layer.provide(exports)), startupChecks: StartupChecks.layer({ prepareUpdater }).pipe(Layer.provide(exports)),
  });
  const requests: { url: string; body: unknown }[] = [];
  const client = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, (http) =>
    HttpClient.tapRequest(http, (request) => Effect.sync(() => {
      requests.push({ url: request.url, body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined });
    })))).pipe(Layer.provide(NodeHttpClient.layerUndici));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const consoleService: Console.Console = { ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const dependencies = (env: Record<string, string>) => Layer.mergeAll(
    NodeServices.layer, unusedApple, readyManagedDeps, client, exports, fakeScreenJpeg().layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "absent.json"), LIVE_MINDMAP_JUDGE: "off", LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_SESSIONS: sessionsDir, ...env })),
    Layer.succeed(Console.Console, consoleService),
  );
  const cli = (argv: string[], env: Record<string, string> = {}) => runCli(argv).pipe(Effect.provide(dependencies(env)), Effect.timeout("10 seconds"));
  return { root, sessionsDir, file, selfFile, helpers, readings, server, cli, stdout, stderr, requests, prepareUpdater, update, katakana, capture, build };
});

const THREE: Script = { duration: 20, remarks: [
  { start: 0, end: 2, text: "最初の発言です" },
  { start: 3, end: 5, text: "次の発言です" },
  { start: 6, end: 8, text: "最後の発言です" },
] };

describe("cli recorded --no-map", () => {
  it.live("モデルの準備と呼び出しなしで全発言を保存し、フォルダだけを出力する", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", r.file, "--no-map"]);
    const dir = onlyFolder(r.sessionsDir);
    expect(remarks(dir).map((remark) => remark.text)).toEqual(THREE.remarks.map((remark) => remark.text));
    expect(r.requests.filter((request) => request.url.endsWith("/session/recorded")).map((request) => request.body)).toEqual([{ file: r.file, noMap: true }]);
    expect(r.prepareUpdater).not.toHaveBeenCalled();
    expect(r.update).not.toHaveBeenCalled();
    expect(r.katakana).not.toHaveBeenCalled();
    expect(r.stdout.join("").trim().split("\n")).toEqual([dir]);
    expect(readdirSync(dir).filter((name) => /^map[.-]/.test(name))).toEqual([]);
    expect(r.capture).not.toHaveBeenCalled();
    expect(r.build).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live("モデル依存が未導入でも、モデルと判定の設定を解決せず開始できる", () => Effect.gen(function* () {
    const r = yield* resource(THREE, { missingModels: true });
    yield* r.cli(["recorded", r.file, "--no-map"], { LIVE_MINDMAP_MODEL: "undefined-model", LIVE_MINDMAP_JUDGE: "undefined-judge" });
    expect(remarks(onlyFolder(r.sessionsDir)).map((remark) => remark.text)).toEqual(THREE.remarks.map((remark) => remark.text));
    expect(r.prepareUpdater).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live("HTTPのnoMap指定で全発言を保存し、終了時にもモデルを呼ばない", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${r.server.port}/session/recorded`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: r.file, noMap: true }),
    }));
    yield* Effect.promise(() => response.text());
    expect(response.status).toBe(200);
    expect(remarks(onlyFolder(r.sessionsDir)).map((remark) => remark.text)).toEqual(THREE.remarks.map((remark) => remark.text));
    expect(r.prepareUpdater).not.toHaveBeenCalled();
    expect(r.update).not.toHaveBeenCalled();
    expect(r.katakana).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live("日本語・略語・保存済みの英単語を補正し、新しい英単語は記録して除外を通知する", () => Effect.gen(function* () {
    const r = yield* resource({ remarks: [], hold: true });
    writeFileSync(vocabularyPoolPath(r.sessionsDir), JSON.stringify({ sessions: 2, words: [{ surface: "Zendesk", romaji: "zendesuku", source: "spoken", lastSpoken: 2 }] }));
    const vocab = join(r.root, "vocab.txt");
    writeFileSync(vocab, "港南店\nOJT\nNotion\n");
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file, "--no-map", "--vocab", vocab]));
    yield* Effect.raceFirst(
      waitFor(() => expect(vocabulary(onlyFolder(r.sessionsDir)).filter((word) => word.source === "user")).toHaveLength(3)),
      Effect.andThen(Fiber.join(running), Effect.never),
    );
    let location = 0;
    const tokens: ReadonlyArray<readonly [string, string]> = [["江南", "kounan"], ["店", "ten"], ["オージェーティー", "oojiitii"], ["全", "zen"], ["デスク", "desuku"], ["ノーション", "nooshon"]];
    const words = tokens.map(([surface, romaji]) => {
      const word = { surface, romaji, location, length: surface.length };
      location += word.length;
      return word;
    });
    const text = words.map((word) => word.surface).join("");
    r.helpers.feed({ type: "speaker-off", start: 0, reason: "モデルなし" });
    for (const event of [{ type: "partial", track: "相手", start: 0, end: 2, text, words }, { type: "remark", track: "相手", start: 0, end: 2, text, words }]) r.helpers.feed(event);
    yield* r.helpers.end;
    yield* Fiber.join(running);
    const dir = onlyFolder(r.sessionsDir);
    expect(remarks(dir).map((remark) => remark.text)).toEqual(["港南店OJTZendeskノーション"]);
    expect(vocabulary(dir)).toEqual(expect.arrayContaining([
      { surface: "Zendesk", romaji: "zendesuku", source: "carried" },
      { surface: "港南店", romaji: "kounanten", source: "user" },
      { surface: "OJT", romaji: "oojiitii", source: "user" },
      { surface: "Notion", romaji: null, source: "user" },
    ]));
    expect(r.readings.calls).toEqual([["港南店", "OJT"]]);
    expect(r.katakana).not.toHaveBeenCalled();
    expect(r.stderr.join("").split(/[\r\n]+/).some((line) => line.includes("Notion") && /補正/.test(line) && /対象外|除外|できな|できず|使えな|使わ|使いません|しません|外し/.test(line))).toBe(true);
  }).pipe(Effect.scoped));

  it.live("画面から追加した新しい英単語も読みなしで残し、CLIに補正からの除外を知らせる", () => Effect.gen(function* () {
    const r = yield* resource({ remarks: [], hold: true });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file, "--no-map"]));
    yield* Effect.raceFirst(
      waitFor(() => expect(r.helpers.calls).toHaveLength(1)),
      Effect.andThen(Fiber.join(running), Effect.never),
    );
    r.helpers.feed({ type: "screen", start: 0, image: Buffer.from("jpeg").toString("base64"), lines: ["Notion"] });
    yield* waitFor(() => expect(vocabulary(onlyFolder(r.sessionsDir))).toContainEqual({ surface: "Notion", romaji: null, source: "screen" }));
    for (const event of remarkEvents(THREE.remarks[0]!)) r.helpers.feed(event);
    yield* r.helpers.end;
    yield* Fiber.join(running);
    expect(remarks(onlyFolder(r.sessionsDir)).map((remark) => remark.text)).toEqual([THREE.remarks[0]!.text]);
    expect(r.readings.calls).toEqual([]);
    expect(r.katakana).not.toHaveBeenCalled();
    expect(r.stderr.join("").split(/[\r\n]+/).some((line) => line.includes("Notion") && /補正/.test(line) && /対象外|除外|できな|できず|使えな|使わ|使いません|しません|外し/.test(line))).toBe(true);
  }).pipe(Effect.scoped));

  it.live("recordedのhelpにno-mapの入口を表示する", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", "--help"]);
    expect(r.stdout.join("")).toContain("--no-map");
    expect(r.requests).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("自分用の録音を渡し、時刻順の発言と相手の話者ラベルを保存する", () => Effect.gen(function* () {
    const r = yield* resource({ remarks: [], events: [
      { type: "speaker", track: "相手", start: 0, end: 2, slot: 0, final: true },
      { type: "speaker-settled", track: "相手", to: 2.5 },
      ...remarkEvents({ start: 3, end: 4, text: "自分の発言" }, "自分"),
      ...remarkEvents({ start: 0, end: 2, text: "相手の発言" }),
    ] });
    yield* r.cli(["recorded", r.file, "--no-map", "--self", r.selfFile]);
    expect(r.helpers.calls[0]).toMatchObject({ kind: "transcribe-file", selfFile: r.selfFile });
    expect(remarks(onlyFolder(r.sessionsDir)).map(({ track, text, speaker }) => ({ track, text, speaker }))).toEqual([
      { track: "相手", text: "相手の発言", speaker: "相手 A" },
      { track: "自分", text: "自分の発言", speaker: "自分" },
    ]);
  }).pipe(Effect.scoped));

  it.live.each([
    { flag: "--model", args: ["--model", "claude"] },
    { flag: "--judge", args: ["--judge", "off"] },
    { flag: "--local", args: ["--local"] },
    { flag: "--realtime", args: ["--realtime"] },
  ])("併用できない $flag を開始前に拒否する", ({ args }) => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const result = yield* Effect.result(r.cli(["recorded", r.file, "--no-map", ...args]));
    expect(Result.isFailure(result)).toBe(true);
    expect(r.requests).toEqual([]);
    expect(r.helpers.calls).toEqual([]);
    expect(r.prepareUpdater).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live.each([
    { model: defaultClaude },
    { judge: { name: "jev", route: "system-one", apiKeyEnv: "TYPESAFE_AI_API_KEY", timeoutMs: 1000 } },
    { realtime: true },
    { title: null },
  ])("HTTPへの直接の本文 %j（併用指定・null の title）も開始前に400で拒否する", (extra) => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${r.server.port}/session/recorded`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: r.file, noMap: true, ...extra }),
    }));
    yield* Effect.promise(async () => { await response.body?.cancel(); });
    expect(response.status).toBe(400);
    expect(r.helpers.calls).toEqual([]);
    expect(r.prepareUpdater).not.toHaveBeenCalled();
    expect(folders(r.sessionsDir)).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("Ctrl-Cで保存済みの発言を残し、マップを作らず予約を解放する", () => Effect.gen(function* () {
    const r = yield* resource({ ...THREE, hold: true, events: [
      { type: "speaker-off", start: 0, reason: "モデルなし" },
      ...THREE.remarks.flatMap((remark) => remarkEvents(remark)),
    ] });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file, "--no-map"]));
    yield* Effect.raceFirst(
      waitFor(() => expect(remarks(onlyFolder(r.sessionsDir))).toHaveLength(3)),
      Effect.andThen(Fiber.join(running), Effect.never),
    );
    const dir = onlyFolder(r.sessionsDir);
    yield* Fiber.interrupt(running);
    expect(remarks(dir).map((remark) => remark.text)).toEqual(THREE.remarks.map((remark) => remark.text));
    expect(r.requests.filter((request) => request.url.endsWith("/session/stop"))).toHaveLength(1);
    expect(readdirSync(dir).filter((name) => /^map[.-]/.test(name))).toEqual([]);
    expect(r.update).not.toHaveBeenCalled();
    yield* r.cli(["status"]);
    expect(r.stdout.join("")).toContain("セッションなし");
  }).pipe(Effect.scoped));

  it.live.each([false, true])("生成したフォルダをplayへ渡すと発言に基づくマップを書き出せ、指定済みの判断軸も保持する（軸あり: %s）", (withCriteria) => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const criteria = ["採用のしやすさ", "運用負荷"];
    const file = join(r.root, "criteria.txt");
    writeFileSync(file, criteria.join("\n"));
    yield* r.cli(["recorded", r.file, "--no-map", ...(withCriteria ? ["--criteria", file] : [])]);
    const original = onlyFolder(r.sessionsDir);
    expect(r.prepareUpdater).not.toHaveBeenCalled();
    expect(r.update).not.toHaveBeenCalled();
    expect(log(original).find((event) => event.type === "start")?.criteria).toEqual(withCriteria ? criteria : undefined);
    const outputStart = r.stdout.length;
    yield* r.cli(["play", original, "--judge", "off"], { LIVE_MINDMAP_SESSIONS: join(r.root, "replayed"), LIVE_MINDMAP_PORT: "0" });
    const replayed = dirname(r.stdout.slice(outputStart).join("").trim().split("\n")[0]!);
    const map = Schema.decodeUnknownSync(JsonExport)(JSON.parse(readFileSync(join(replayed, "map.json"), "utf8")));
    expect(map.criteria).toEqual(withCriteria ? criteria : undefined);
    expect(map.root.children.map((node) => node.text)).toEqual(THREE.remarks.map((remark) => remark.text));
    expect(map.root.children.flatMap((node) => node.evidence).map((remark) => remark.text)).toEqual(THREE.remarks.map((remark) => remark.text));
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(replayed, name))).toBe(true);
  }).pipe(Effect.scoped));
});
