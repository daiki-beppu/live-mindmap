import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { evalManagedDeps } from "./fixtures/evalManagedDeps.ts";
// 回帰評価（eval コマンド）。fixture は合成データで、実際の録音サンプルは使わない。
import { readFileSync, writeFileSync } from "node:fs";
import { appendFile, copyFile, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { Cause, ConfigProvider, Console, Effect, Exit, Layer, Predicate, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "@effect/vitest";
import { beforeEach, vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { ReviewBuild } from "../src/review.ts";
import { runCli } from "../src/cli.ts";
import * as cliEntry from "../src/cli.ts";
import { type DiffInput, type DiffResult, type DiffUsage, type Op, type Snapshot, SpeakerNameLogEvent, REVIEW_LOG_ELEMENT_ID, Truth } from "../src/core/index.ts";
import { fakeListener } from "./fakeListener.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

// play の updater と配信を差し替える。評価の対象は保存されたマップなので、配信は偽物でよい
const external = vi.hoisted(() => ({ openClaudeUpdater: vi.fn(), openListener: vi.fn() }));
vi.mock("../src/claude.ts", async (importOriginal) => ({
  ...(await import("./fixtures/claudeModule.ts")).fakeClaudeModule(() => external.openClaudeUpdater()),
  AgentSdk: (await importOriginal<typeof import("../src/claude.ts")>()).AgentSdk,
}));
// 配信の待受け（openListener）だけを偽物にする。serveFeed は本物のまま
vi.mock("../src/http.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/http.ts")>(),
  openListener: external.openListener,
}));

beforeEach(() => {
  external.openClaudeUpdater.mockReset();
  external.openListener.mockReset();
  external.openListener.mockImplementation(fakeListener().open);
});

// 旧 CliDeps の置き換え。保存先は ConfigProvider、標準出力は Console、撮影は MapCapture の Layer
function dependencies(sessionsDir: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(
    NodeServices.layer, unusedApple, evalManagedDeps("ready").layer,
    NodeHttpClient.layerUndici,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(sessionsDir, "home"), LIVE_MINDMAP_CONFIG: join(sessionsDir, "absent.config.json"), LIVE_MINDMAP_JUDGE: "off", LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: "0" })),
    Layer.succeed(Console.Console, consoleService),
    Layer.succeed(MapCapture, MapCapture.of({
      capture: (_snapshot: Snapshot, path: string) => Effect.sync(() => writeFileSync(path, "")),
    })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed("<!doctype html><html><body></body></html>") })),
    fakeAudioMix().layer,
    fakeScreenJpeg().layer,
  );
  return { layer, stdout, stderr };
}

// タグ付きの失敗から、タグと自身のフィールドを取り出す（フィールド名に依存しない観測のため）
const carries = (values: Record<string, unknown>, text: string) =>
  Object.values(values).some((v) => typeof v === "string" && v.includes(text));

const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");
// short.transcript.json の発言: r1 [0.5, 9.8] / r2 [9.8, 19.2] / r3 [19.2, 28.0]。差分更新は発言 1 件ごとに 1 回（r1・r2・r3 の 3 回）。

// 入れ子のあるマップ（深さ 3）。決定は r1 と r3、TODO は r2 を根拠にする。
const scriptA: Op[][] = [
  [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
    { op: "add", ref: "t3", parent: "t2", kind: "案", text: "1 回で足りる", evidence: ["r2"] },
    { op: "add", ref: "t4", parent: "t1", kind: "TODO", text: "求人票を直す", evidence: ["r2"] },
  ],
  [{ op: "add", ref: "t5", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r1", "r3"] }],
];

// 浅いマップ（深さ 2）。議題 2、課題 1。
const scriptB: Op[][] = [
  [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "予算", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "root", kind: "議題", text: "日程", evidence: ["r2"] },
    { op: "add", ref: "t3", parent: "t1", kind: "課題", text: "上限が不明", evidence: ["r2"] },
  ],
  [],
];

// play を 1 回流し、ランのフォルダを返す。ランごとにセッションの置き場を分けて、開始時刻の衝突を避ける。
// script は「発言 r1・r2 が揃った時点の手」と「r3 の手」の 2 手で書く。発言は 1 件ずつ渡るので、r1 の呼び出しは何もせず（ops なし）、
// script[0] を r2 の呼び出し、script[1] を r3 の呼び出しで返す。r1 の手は、r2 の呼び出しの時点で既知の発言（r1・r2）だけを根拠にしている。
// usages を渡すと、n 回目（r1 の呼び出しが 0 回目）の差分更新がその n 番目のトークン数を結果と一緒に返す（渡さない・足りない回は返さない）
const play = (script: Op[][], file = fixture, usages: DiffUsage[] = []) =>
  Effect.gen(function* () {
    const steps: Op[][] = [[], ...script];
    const sessionsDir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-run-")));
    let n = 0;
    external.openClaudeUpdater.mockReturnValue({
      update: (_input: DiffInput) =>
        Effect.sync(() => {
          const usage = usages[n];
          return { ops: steps[n++] ?? [], ...(usage ? { usage } : {}) };
        }),
      close: () => {},
    });
    const { layer, stdout } = dependencies(sessionsDir);
    yield* runCli(["play", file]).pipe(Effect.provide(layer));
    return dirname(stdout.join("").split("\n")[0]!); // play は書き出したファイルのパスを出す（#41）
  });

const evalCli = (args: string[]) =>
  Effect.gen(function* () {
    const sessionsDir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-eval-")));
    const { layer, stdout } = dependencies(sessionsDir);
    yield* runCli(["eval", ...args]).pipe(Effect.provide(layer));
    return stdout.join("");
  });

// eval の失敗を、表示ではなくタグ付きの失敗値として観測する（日本語 1 行は cliEntry.it.test.ts が入口で観測する）
const evalFailure = (args: string[]) =>
  Effect.gen(function* () {
    const sessionsDir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-eval-")));
    const { layer, stdout } = dependencies(sessionsDir);
    const result = yield* Effect.result(runCli(["eval", ...args]).pipe(Effect.provide(layer)));
    if (Result.isSuccess(result)) return yield* Effect.die(new Error(`失敗しなかった: ${stdout.join("")}`));
    const failure: unknown = result.failure;
    if (!Predicate.hasProperty(failure, "_tag")) return yield* Effect.die(new Error("タグ付きの失敗ではない"));
    return { tag: failure._tag, values: Object.fromEntries(Object.entries(failure)) };
  });

// Markdown の表を、見出しをキーにした行の配列にする
function parseTable(text: string): { header: string[]; rows: Record<string, string>[] } {
  const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
  // GFM と同じく `\` とその次の 1 文字を一組として読み、エスケープされていない `|` だけで区切る
  const cells = (l: string) => {
    const inner = l.trim().replace(/^\|/, "").replace(/(?<!\\(?:\\\\)*)\|$/, "");
    const out: string[] = [];
    let cur = "";
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (ch === "\\" && i + 1 < inner.length) {
        const next = inner[++i]!;
        cur += next === "|" || next === "\\" ? next : ch + next;
      } else if (ch === "|") {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const [headerLine, separator, ...body] = lines;
  expect(headerLine, "表の見出し行").toBeDefined();
  expect(cells(separator ?? "").every((c) => /^:?-+:?$/.test(c)), "見出しの次は区切り行").toBe(true);
  const header = cells(headerLine!);
  return {
    header,
    rows: body.map((l) => {
      const row = cells(l);
      expect(row, `どの行もセル数が見出しと同じ: ${l}`).toHaveLength(header.length);
      return Object.fromEntries(row.map((c, i) => [header[i]!, c]));
    }),
  };
}

const writeTruth = (truth: unknown) =>
  Effect.gen(function* () {
    const path = join(yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-truth-"))), "short.truth.json");
    yield* Effect.promise(() => writeFile(path, typeof truth === "string" ? truth : JSON.stringify(truth)));
    return path;
  });

describe("再生で推定した名前", () => {
  for (const command of ["play", "eval"] as const) {
    it.effect(`${command} は保存済みの名前を持ち越さず、新しい推定名をログ・後続入力・md・html に渡す`, () => Effect.gen(function* () {
      const source = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-replay-names-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      );
      const events = [
        { type: "start", title: "名前の再生" },
        { type: "speaker-name", label: "相手 A", name: "保存済みの推定名", source: "推定" },
        { type: "speaker-name", label: "相手 A", name: "保存済みの手入力名", source: "手入力" },
        ...["田中です", "田中太郎です"].map((text, i) => ({ type: "remark", remark: { id: `r${i + 1}`, track: "相手", start: i + 1, end: i + 2, text, speaker: "相手 A" } })),
      ];
      writeFileSync(join(source, "log.jsonl"), events.map((event) => JSON.stringify({ at: "2026-10-01T00:00:00Z", ...event })).join("\n") + "\n");
      const inputs: DiffInput[] = [];
      external.openClaudeUpdater.mockReturnValue({
        update: (input: DiffInput) => Effect.sync((): DiffResult => {
          inputs.push(input);
          return { ops: inputs.length === 1 ? [
            { op: "add", ref: "topic", parent: "root", kind: "議題", text: "運用", evidence: ["r1"] },
            { op: "add", ref: "plan", parent: "topic", kind: "案", text: "週次で確認する", evidence: ["r1"] },
          ] : [], names: input.fresh.filter((remark) => remark.text.endsWith("です")).map((remark) => ({
            label: remark.speaker!, name: remark.text.slice(0, -2), evidence: remark.id, basis: "名乗り",
          })) };
        }),
        close: () => {},
      });
      const sessionsDir = join(source, "runs");
      const deps = dependencies(sessionsDir);
      const listener = fakeListener();
      external.openListener.mockImplementation(listener.open);
      yield* runCli([command, source, "--model", "claude"]).pipe(Effect.provide(deps.layer));
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).not.toHaveProperty("speakerNames");
      expect(inputs[1]!.speakerNames).toEqual(new Map([["相手 A", "田中"]]));
      const runs = yield* Effect.promise(() => readdir(sessionsDir));
      expect(runs).toHaveLength(1);
      const lines = readFileSync(join(sessionsDir, runs[0]!, "log.jsonl"), "utf8").trim().split("\n")
        .map((line): Record<string, unknown> => JSON.parse(line));
      expect(lines.filter((line) => line.type === "speaker-name")).toEqual([
        expect.objectContaining({ label: "相手 A", name: "田中", source: "推定" }),
        expect.objectContaining({ label: "相手 A", name: "田中太郎", source: "推定" }),
      ]);
      if (command === "play") {
        expect(listener.speakerNames).toEqual([
          { type: "speaker-names", names: [] },
          { type: "speaker-names", names: [{ label: "相手 A", name: "田中" }] },
          { type: "speaker-names", names: [{ label: "相手 A", name: "田中太郎" }] },
        ]);
      } else {
        expect(external.openListener).not.toHaveBeenCalled();
        expect(listener.speakerNames).toEqual([]);
      }
      const runDir = join(sessionsDir, runs[0]!);
      const markdown = readFileSync(join(runDir, "map.md"), "utf8");
      const html = readFileSync(join(runDir, "map.html"), "utf8");
      const embedded = html.match(new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([^]*?)</script>`));
      expect(embedded).not.toBeNull();
      const embeddedEvents = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(embedded![1]);
      const embeddedNames = embeddedEvents.filter((event) => Predicate.isObject(event) && event.type === "speaker-name")
        .map((event) => Schema.decodeUnknownSync(SpeakerNameLogEvent)(event));
      expect(embeddedNames).toEqual([
        { type: "speaker-name", label: "相手 A", name: "田中", source: "推定" },
        { type: "speaker-name", label: "相手 A", name: "田中太郎", source: "推定" },
      ]);
      expect(markdown.split("\n").find((line) => line.includes("週次で確認する"))).toBe("  - 週次で確認する — 田中太郎（00:01）");
      deps.stdout.length = 0;
      yield* runCli(["export", "--format", "json"]).pipe(Effect.provide(deps.layer));
      expect(JSON.parse(deps.stdout.join(""))).toHaveProperty("speakerNames", { "相手 A": "田中太郎" });
    }).pipe(Effect.scoped));
  }
});

describe("eval: 開始前の依存確認", () => {
  it.effect("--model claude は必須不足を SDK 読込・差分更新より前に拒否し、3行の stderr と exit 3 を返す", () => Effect.gen(function* () {
    const source = yield* play(scriptA);
    const sessionsDir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-eval-deps-")));
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(sessionsDir, { recursive: true, force: true })));
    const deps = dependencies(sessionsDir);
    const managed = evalManagedDeps("missing");
    external.openClaudeUpdater.mockClear();
    const exit = yield* Effect.exit(runCli(["eval", source, "--model", "claude"]).pipe(
      Effect.provide(Layer.mergeAll(deps.layer, managed.layer)),
    ));
    expect(managed.load).not.toHaveBeenCalled();
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error("不足した SDK で評価が成功しました");
    expect(Cause.findError(exit.cause)).toMatchObject({ _tag: "Success", success: { _tag: "StartupDepsMissing" } });
    yield* cliEntry.reportFailure(exit.cause).pipe(Effect.provide(deps.layer));
    const saved = process.exitCode;
    try {
      cliEntry.teardown(exit, () => { throw new Error("自然終了する必要があります"); });
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = saved;
    }
    expect(deps.stdout.join("")).toBe("");
    expect(deps.stderr.join("")).toBe("開始しません。足りないもの: claude（Claude Agent SDK、約 224MB）\n入れるには: pnpm cli install claude\n利用者に確認してから入れてください\n");
    expect(external.openClaudeUpdater).not.toHaveBeenCalled();
    expect(yield* Effect.promise(() => readdir(sessionsDir))).toEqual([]);
    expect(managed.install).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.effect("--model は Chromium 不足を最初の差分更新より前に警告し、新しいマップを集計する", () => Effect.gen(function* () {
    const source = yield* play(scriptB);
    const sessionsDir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-eval-warning-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const deps = dependencies(sessionsDir);
    const managed = evalManagedDeps("ready", "missing");
    const steps: Op[][] = [[], ...scriptA];
    let step = 0;
    let warningsAtFirstUpdate: string | undefined;
    external.openClaudeUpdater.mockReturnValue({
      update: (_input: DiffInput) => Effect.sync(() => {
        if (step === 0) warningsAtFirstUpdate = deps.stderr.join("");
        return { ops: steps[step++] ?? [] };
      }),
      close: () => {},
    });
    yield* runCli(["eval", source, "--model", "claude"]).pipe(
      Effect.provide(Layer.mergeAll(deps.layer, managed.layer)),
    );
    const warning = "警告: chromium（Chromium、約 211MB） がありません。入れるには: pnpm cli install chromium\n";
    expect(warningsAtFirstUpdate).toBe(warning);
    expect(deps.stderr.join("")).toBe(warning);
    const { rows } = parseTable(deps.stdout.join(""));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ノード: "5", 深さ: "3" });
  }).pipe(Effect.scoped));

  it.effect("--model なしは Claude 未導入でも保存済みのマップを集計し、SDK を確認・読み込みしない", () => Effect.gen(function* () {
    const source = yield* play(scriptA);
    const deps = dependencies(source);
    const managed = evalManagedDeps("missing");
    yield* runCli(["eval", source]).pipe(Effect.provide(Layer.mergeAll(deps.layer, managed.layer)));
    const { rows } = parseTable(deps.stdout.join(""));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ラン: basename(source), ノード: "5", 深さ: "3" });
    expect(deps.stderr).toEqual([]);
    expect(managed.check).not.toHaveBeenCalled();
    expect(managed.load).not.toHaveBeenCalled();
  }));

  it.effect("Claude 以外の準備失敗は SDK を読まず、一般の失敗として exit 1 で終わる", () => Effect.gen(function* () {
    const source = yield* play(scriptA);
    const deps = dependencies(source);
    const managed = evalManagedDeps("missing");
    yield* Effect.promise(() => writeFile(join(source, "absent.config.json"), JSON.stringify({ models: {
      compatible: { route: "openai-compatible", model: "synthetic", url: "http://127.0.0.1:8766/v1" },
    } })));
    const requests: string[] = [];
    const client = HttpClient.make((request) => Effect.sync(() => {
      requests.push(request.url);
      return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }));
    }));
    const exit = yield* Effect.exit(runCli(["eval", source, "--model", "compatible"]).pipe(
      Effect.provide(Layer.mergeAll(deps.layer, managed.layer, Layer.succeed(HttpClient.HttpClient, client))),
    ));
    expect(requests).toEqual(["http://127.0.0.1:8766/v1/chat/completions"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error("HTTP 503 で評価が成功しました");
    expect(Cause.findError(exit.cause)).toMatchObject({ _tag: "Success", success: { _tag: "UpdaterUnavailable", message: expect.stringContaining("HTTP 503") } });
    yield* cliEntry.reportFailure(exit.cause).pipe(Effect.provide(deps.layer));
    const saved = process.exitCode;
    try {
      cliEntry.teardown(exit, () => { throw new Error("自然終了する必要があります"); });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved;
    }
    expect(deps.stderr.join("")).toContain("HTTP 503");
    expect(managed.load).not.toHaveBeenCalled();
    expect(deps.stdout).toEqual([]);
  }));
});

describe("eval: ノード数・深さ・種別ごとの数", () => {
  it.effect("ルートを除くノード数、ルートの子を 1 とする深さ、6 種別ごとの数（0 件は 0）を 1 行に出す", () => Effect.gen(function* () {
    const dir = yield* play(scriptA);
    const { header, rows } = parseTable(yield* evalCli([dir]));

    expect(header.slice(0, 4)).toEqual(["ラン", "会議", "ノード", "深さ"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ラン: basename(dir),
      会議: "short",
      ノード: "5",
      深さ: "3",
      議題: "1",
      論点: "1",
      案: "1",
      決定: "1",
      課題: "0",
      TODO: "1",
      要点: "0",
    });
  }));

  it.effect("種別ごとの数の列に「要点」があり、要点のノードを数える", () => Effect.gen(function* () {
    const scriptPoints: Op[][] = [
      [
        { op: "add", ref: "t1", parent: "root", kind: "議題", text: "ツールの共有", evidence: ["r1"] },
        { op: "add", ref: "t2", parent: "t1", kind: "要点", text: "justの紹介", evidence: ["r2"] },
        { op: "add", ref: "t3", parent: "t1", kind: "要点", text: "辞書は二十語でも効く", evidence: ["r2"] },
      ],
      [{ op: "add", ref: "t4", parent: "n3", kind: "要点", text: "作り方は手作業で十分", evidence: ["r3"] }],
    ];
    const { header, rows } = parseTable(yield* evalCli([yield* play(scriptPoints)]));

    expect(header).toContain("要点");
    expect(rows[0]).toMatchObject({ ノード: "4", 議題: "1", 要点: "3", 決定: "0", TODO: "0" });
  }));

  it.effect("--truth を付けないときは再現率の列を出さない", () => Effect.gen(function* () {
    const { header } = parseTable(yield* evalCli([yield* play(scriptA)]));
    expect(header.some((h) => h.includes("再現率"))).toBe(false);
  }));

  it.effect("結果をフォルダに書き足さない（標準出力だけに書く）", () => Effect.gen(function* () {
    const dir = yield* play(scriptA);
    const before = (yield* Effect.promise(() => readdir(dir))).sort();
    yield* evalCli([dir]);
    expect((yield* Effect.promise(() => readdir(dir))).sort()).toEqual(before);
  }));

  it.effect("ノードが無いランは、ノード数 0・深さ 0 になる", () => Effect.gen(function* () {
    const dir = yield* play([[], []]);
    const { rows } = parseTable(yield* evalCli([dir]));
    expect(rows[0]).toMatchObject({ ノード: "0", 深さ: "0", 議題: "0", 論点: "0", 案: "0", 決定: "0", 課題: "0", TODO: "0" });
  }));

  it.effect("エクスポートの無いフォルダは、フォルダ名を含むタグ付きの失敗で止まる", () => Effect.gen(function* () {
    const empty = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-empty-")));
    const failure = yield* evalFailure([empty]);
    expect(failure.tag).toBe("MissingRunExport");
    expect(carries(failure.values, empty)).toBe(true);
  }));
});

describe("eval: 複数のランを並べる", () => {
  it.effect("渡した順に 1 ラン 1 行で並び、行ごとにランの名前・会議の名前・指標が違う", () => Effect.gen(function* () {
    const other = join(yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-sample-"))), "other.transcript.json");
    yield* Effect.promise(() => copyFile(fixture, other));
    const dirA = yield* play(scriptA);
    const dirB = yield* play(scriptB, other);

    const { rows } = parseTable(yield* evalCli([dirB, dirA]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ラン: basename(dirB), 会議: "other", ノード: "3", 深さ: "2", 議題: "2", 課題: "1", 決定: "0", TODO: "0" });
    expect(rows[1]).toMatchObject({ ラン: basename(dirA), 会議: "short", ノード: "5", 深さ: "3", 議題: "1", 課題: "0", 決定: "1", TODO: "1" });
  }));

  it.effect("ランの名前・会議の名前に `|`・`\\`・改行があっても、1 ラン 1 行でセルがずれない", () => Effect.gen(function* () {
    const odd = join(yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-sample-"))), "会議|A\\B\nC.transcript.json");
    yield* Effect.promise(() => copyFile(fixture, odd));
    const played = yield* play(scriptA, odd);
    const dirOdd = join(dirname(played), "run|x\\");
    yield* Effect.promise(() => rename(played, dirOdd));
    const dirB = yield* play(scriptB);

    const text = yield* evalCli([dirOdd, dirB]);
    expect(text.split("\n").filter((l) => l.trim() !== "")).toHaveLength(4);
    const { rows } = parseTable(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ラン: basename(dirOdd), 会議: "会議|A\\B C", ノード: "5", 深さ: "3" });
    expect(rows[1]).toMatchObject({ ラン: basename(dirB), 会議: "short", ノード: "3", 深さ: "2" });
  }));
});

describe("eval: log.jsonl から数える 3 指標", () => {
  const LOG_HEADERS = ["書き換え/発言", "1 ノードの書き換えの最多", "話し中の兄弟の最多"];
  const USAGE_HEADERS = ["入力トークン", "キャッシュ書き込みトークン", "キャッシュ読み出しトークン", "出力トークン"];
  // r2 の呼び出しで議題と要点を立て、r3 の呼び出しで要点の本文を変える（書き換え 1 回）。発言は 3 件
  const scriptRewrite: Op[][] = [
    [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "ツールの共有", evidence: ["r1"] },
      { op: "add", ref: "t2", parent: "t1", kind: "要点", text: "justの紹介", evidence: ["r2"] },
    ],
    [{ op: "update", node: "n2", text: "justは辞書を育てる", evidence: ["r3"] }],
  ];

  it.effect("3 列と、続くトークン数の 4 列が種別ごとの数の後・再現率の前に、決まった見出しで並び、play で作ったランの値が入る", () => Effect.gen(function* () {
    const truth = yield* writeTruth({ 決定: [], TODO: [] });
    const { header, rows } = parseTable(yield* evalCli(["--truth", truth, yield* play(scriptRewrite)]));

    expect(header.slice(-11)).toEqual([...LOG_HEADERS, ...USAGE_HEADERS, "決定の再現率", "TODO の再現率", "決定の種別違い", "TODO の種別違い"]);
    expect(header.indexOf(LOG_HEADERS[0]!)).toBe(header.indexOf("要点") + 1);
    expect(rows[0]).toMatchObject({ "書き換え/発言": "1/3 (0.33)", "1 ノードの書き換えの最多": "1", "話し中の兄弟の最多": "1" });
  }));

  it.effect("--truth を付けなくても 3 列とトークン数の 4 列は出る", () => Effect.gen(function* () {
    const { header, rows } = parseTable(yield* evalCli([yield* play(scriptRewrite)]));

    expect(header.slice(-7)).toEqual([...LOG_HEADERS, ...USAGE_HEADERS]);
    expect(rows[0]!["書き換え/発言"]).toBe("1/3 (0.33)");
  }));

  it.effect("type が文字列でない行（配列 [\"diff\"]）は restore と同じく読み飛ばし、表の値は変わらない", () => Effect.gen(function* () {
    const dir = yield* play(scriptRewrite);
    yield* Effect.promise(() => appendFile(join(dir, "log.jsonl"), '\n{"type":["diff"]}\n'));
    const { rows } = parseTable(yield* evalCli([dir]));

    expect(rows[0]).toMatchObject({ "書き換え/発言": "1/3 (0.33)", "1 ノードの書き換えの最多": "1", "話し中の兄弟の最多": "1" });
  }));

  it.effect("log.jsonl が無いラン（export.json だけ）は 3 列とも - で、eval は失敗しない", () => Effect.gen(function* () {
    const dir = yield* play(scriptRewrite);
    yield* Effect.promise(() => rm(join(dir, "log.jsonl")));
    const { rows } = parseTable(yield* evalCli([dir]));

    expect(LOG_HEADERS.map((h) => rows[0]![h])).toEqual(["-", "-", "-"]);
  }));
});

describe("eval: 正解との再現率（時刻の重なり）", () => {
  it.effect("案と担当を含む拡張正解でも、同じ保存済みセッションの表は変わらない", () => Effect.gen(function* () {
    const dir = yield* play(scriptA);
    const plain = {
      決定: [{ from: 20, to: 25, keywords: ["2回"] }],
      TODO: [{ from: 10, to: 15, keywords: ["求人票"] }],
    };
    const extended = {
      ...plain,
      TODO: [{ ...plain.TODO[0]!, 担当: "甲" }],
      案: [{ from: 10, to: 15, keywords: ["1回"], 出した人: "乙" }],
    };
    const before = yield* evalCli(["--truth", yield* writeTruth(plain), dir]);
    const after = yield* evalCli(["--truth", yield* writeTruth(extended), dir]);
    expect(parseTable(before).rows[0]).toMatchObject({ 決定の再現率: "1/1 (100%)", "TODO の再現率": "1/1 (100%)" });
    expect(after).toBe(before);
  }));

  // 決定のノード「2 回にする」の根拠は r1 [0.5, 9.8] と r3 [19.2, 28.0]、TODO のノード「求人票を直す」の根拠は r2 [9.8, 19.2]。
  // 1 つのノードは正解 1 件にしか当たらないので、正解は 1 件ずつ評価する。
  const decision = ["2回"];
  const todo = ["求人票"];
  const overlap: [string, "決定" | "TODO", number, number, string[], string][] = [
    ["2 つ目の根拠 r3 の中", "決定", 20, 25, decision, "1/1 (100%)"],
    ["1 つ目の根拠 r1 の中", "決定", 1, 5, decision, "1/1 (100%)"],
    ["r3 の終わりに接する", "決定", 28, 30, decision, "1/1 (100%)"],
    ["r3 の始まりに接する", "決定", 10, 19.2, decision, "1/1 (100%)"],
    ["TODO の根拠とだけ重なる（種別が違う）", "決定", 10, 19, todo, "0/1 (0%)"],
    ["r3 の終わりの外", "決定", 28.1, 40, decision, "0/1 (0%)"],
    ["r2 の中", "TODO", 10, 15, todo, "1/1 (100%)"],
    ["決定の根拠とだけ重なる（種別が違う）", "TODO", 20, 25, decision, "0/1 (0%)"],
  ];

  for (const [name, kind, from, to, keywords, expected] of overlap) {
    it.effect(name, () => Effect.gen(function* () {
      const dir = yield* play(scriptA);
      const truth = { 決定: [], TODO: [], [kind]: [{ text: "x", from, to, keywords }] };
      const { header, rows } = parseTable(yield* evalCli(["--truth", yield* writeTruth(truth), dir]));

      expect(header.slice(-4)).toEqual(["決定の再現率", "TODO の再現率", "決定の種別違い", "TODO の種別違い"]);
      expect(rows[0]![kind === "決定" ? "決定の再現率" : "TODO の再現率"]).toBe(expected);
    }));
  }

  it.effect("正解が 0 件の種別は 0/0 とし、割合は付けない", () => Effect.gen(function* () {
    const dir = yield* play(scriptA);
    const truth = { 決定: [{ text: "x", from: 20, to: 25, keywords: decision }], TODO: [] };
    const { rows } = parseTable(yield* evalCli(["--truth", yield* writeTruth(truth), dir]));
    expect(rows[0]).toMatchObject({ 決定の再現率: "1/1 (100%)", "TODO の再現率": "0/0" });
  }));

  const both = {
    決定: [{ text: "x", from: 20, to: 25, keywords: decision }],
    TODO: [{ text: "y", from: 10, to: 15, keywords: todo }],
  };

  it.effect("AI のノードが無ければ 0 件の再現になる", () => Effect.gen(function* () {
    const dir = yield* play([[], []]);
    const { rows } = parseTable(yield* evalCli(["--truth", yield* writeTruth(both), dir]));
    expect(rows[0]).toMatchObject({ 決定の再現率: "0/1 (0%)", "TODO の再現率": "0/1 (0%)" });
  }));

  it.effect("同じ正解を複数のランに当てて、ランごとの再現率を並べる", () => Effect.gen(function* () {
    const dirA = yield* play(scriptA);
    const dirEmpty = yield* play([[], []]);
    const { rows } = parseTable(yield* evalCli(["--truth", yield* writeTruth(both), dirA, dirEmpty]));
    expect(rows.map((r) => r["決定の再現率"])).toEqual(["1/1 (100%)", "0/1 (0%)"]);
    expect(rows.map((r) => r["TODO の再現率"])).toEqual(["1/1 (100%)", "0/1 (0%)"]);
  }));
});

describe("eval: 種別違い（正解が別の種別のノードとして出た数）", () => {
  // 決定の正解に時刻（r3 [19.2, 28.0]）もキーワードも合うが、種別が要点のノードだけがあるマップ
  const scriptPointOnly: Op[][] = [
    [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] }],
    [{ op: "add", ref: "t2", parent: "n1", kind: "要点", text: "2 回にする", evidence: ["r3"] }],
  ];
  const decisionTruth = { 決定: [{ text: "x", from: 20, to: 25, keywords: ["2回"] }], TODO: [] };
  const run = (truth: unknown, script: Op[][]) => Effect.gen(function* () {
    const { header, rows } = parseTable(yield* evalCli(["--truth", yield* writeTruth(truth), yield* play(script)]));
    return { header, row: rows[0]! };
  });

  it.effect("決定の時刻に要点のノードだけがあるマップでは、決定の種別違いが 1 で、再現率は 0/1", () => Effect.gen(function* () {
    const { row } = yield* run(decisionTruth, scriptPointOnly);
    expect(row["決定の種別違い"]).toBe("1");
    expect(row["決定の再現率"]).toBe("0/1 (0%)");
    expect(row["TODO の種別違い"]).toBe("0");
  }));

  it.effect("決定として出ている正解は、種別違いに数えない", () => Effect.gen(function* () {
    const { row } = yield* run(decisionTruth, scriptA);
    expect(row["決定の種別違い"]).toBe("0");
    expect(row["決定の再現率"]).toBe("1/1 (100%)");
  }));

  it.effect("TODO の正解にも同じように数える（決定のノードとして出た TODO は TODO の種別違い）", () => Effect.gen(function* () {
    // 決定ノード「2 回にする」は r1・r3 が根拠。TODO の正解を r3 の区間に置く
    const { row } = yield* run({ 決定: [], TODO: [{ text: "x", from: 20, to: 25, keywords: ["2回"] }] }, scriptA);
    expect(row["TODO の種別違い"]).toBe("1");
    expect(row["TODO の再現率"]).toBe("0/1 (0%)");
    expect(row["決定の種別違い"]).toBe("0");
  }));

  it.effect("時刻が合っても keywords が合わなければ数えない", () => Effect.gen(function* () {
    const { row } = yield* run({ 決定: [{ text: "x", from: 20, to: 25, keywords: ["存在しない語"] }], TODO: [] }, scriptPointOnly);
    expect(row["決定の種別違い"]).toBe("0");
  }));

  it.effect("keywords が合っても時刻が合わなければ数えない", () => Effect.gen(function* () {
    const { row } = yield* run({ 決定: [{ text: "x", from: 28.1, to: 40, keywords: ["2回"] }], TODO: [] }, scriptPointOnly);
    expect(row["決定の種別違い"]).toBe("0");
  }));

  it.effect("1 つのノードは 1 件の正解にしか数えない（同じ要点ノードに当たる正解が 2 件でも種別違いは 1）", () => Effect.gen(function* () {
    const twice = { 決定: [{ text: "x", from: 20, to: 25, keywords: ["2回"] }, { text: "y", from: 21, to: 26, keywords: ["2回"] }], TODO: [] };
    const { row } = yield* run(twice, scriptPointOnly);
    expect(row["決定の再現率"]).toBe("0/2 (0%)");
    expect(row["決定の種別違い"]).toBe("1");
  }));

  it.effect("正解 1 件に決定のノードと要点のノードの両方が当たるときは、種別違いに数えない", () => Effect.gen(function* () {
    const script: Op[][] = [
      [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] }, { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] }],
      [
        { op: "add", ref: "d1", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] },
        { op: "add", ref: "p1", parent: "n2", kind: "要点", text: "2 回にする", evidence: ["r3"] },
      ],
    ];
    const { row } = yield* run(decisionTruth, script);
    expect(row["決定の再現率"]).toBe("1/1 (100%)");
    expect(row["決定の種別違い"]).toBe("0");
  }));

  it.effect("同じ種別の候補はあるが割り当てで外れた正解も、別の種別のノードに当たれば数える", () => Effect.gen(function* () {
    // 決定ノード 1 つ（r3 を根拠）に当たる正解が 2 件。1 件は決定で再現でき、もう 1 件は要点のノードに当たる
    const script: Op[][] = [
      [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] }, { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] }],
      [
        { op: "add", ref: "d1", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r3"] },
        { op: "add", ref: "p1", parent: "n2", kind: "要点", text: "2 回にする", evidence: ["r3"] },
      ],
    ];
    const twice = { 決定: [{ text: "x", from: 20, to: 25, keywords: ["2回"] }, { text: "y", from: 21, to: 26, keywords: ["2回"] }], TODO: [] };
    const { row } = yield* run(twice, script);
    expect(row["決定の再現率"]).toBe("1/2 (50%)");
    expect(row["決定の種別違い"]).toBe("1");
  }));

  it.effect("決定・TODO の 2 列が再現率の直後に並び、複数のランを並べても列が揃う", () => Effect.gen(function* () {
    const dirA = yield* play(scriptPointOnly);
    const dirB = yield* play(scriptA);
    const { header, rows } = parseTable(yield* evalCli(["--truth", yield* writeTruth(decisionTruth), dirA, dirB]));
    const at = header.indexOf("TODO の再現率");
    expect(header.slice(at + 1, at + 3)).toEqual(["決定の種別違い", "TODO の種別違い"]);
    expect(rows.map((r) => [r["決定の種別違い"], r["TODO の種別違い"]])).toEqual([["1", "0"], ["0", "0"]]);
  }));

  it.effect("--truth を付けないときは、種別違いの列が出ない", () => Effect.gen(function* () {
    const { header } = parseTable(yield* evalCli([yield* play(scriptPointOnly)]));
    expect(header.some((h) => h.includes("種別違い"))).toBe(false);
  }));
});

describe("eval: 正解との再現率（キーワード）", () => {
  // 決定の親は論点に限る。議題と論点を r2 の呼び出しで作り、決定は r3 の呼び出しで足す（r3 は r3 の呼び出しから根拠に使える。論点は scriptA と同じく n2）
  const base: Op[] = [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
  ];
  const decisionNodes = (...nodes: { text: string; evidence?: string[] }[]): Op[][] => [
    base,
    nodes.map(({ text, evidence = ["r1"] }, i): Op => ({ op: "add", ref: `d${i}`, parent: "n2", kind: "決定", text, evidence })),
  ];
  const decisionNode = (text: string, evidence?: string[]) => decisionNodes({ text, evidence });
  // 決定の再現率の列だけを返す
  const decisionRecall = (script: Op[][], items: { from: number; to: number; keywords: unknown }[]) => Effect.gen(function* () {
    const truth = { 決定: items.map((i) => ({ text: "x", ...i })), TODO: [] };
    const { rows } = parseTable(yield* evalCli(["--truth", yield* writeTruth(truth), yield* play(script)]));
    return rows[0]!["決定の再現率"];
  });

  it.effect("時刻が重なっても、キーワードを含まないノードは正解として数えない（含む正解は当たる）", () => Effect.gen(function* () {
    const script = decisionNode("面接は 2 回にする");
    expect(yield* decisionRecall(script, [{ from: 1, to: 5, keywords: ["2回"] }])).toBe("1/1 (100%)");
    expect(yield* decisionRecall(script, [{ from: 1, to: 5, keywords: ["3回"] }])).toBe("0/1 (0%)");
  }));

  it.effect("keywords の要素すべてが本文に含まれて初めて当たる（1 つ欠ければ外れる）", () => Effect.gen(function* () {
    const script = decisionNode("面接は 2 回にする");
    expect(yield* decisionRecall(script, [{ from: 1, to: 5, keywords: ["面接", "2回"] }])).toBe("1/1 (100%)");
    expect(yield* decisionRecall(script, [{ from: 1, to: 5, keywords: ["面接", "3回"] }])).toBe("0/1 (0%)");
  }));

  it.effect("1 つのノードは、区間が重なる 2 件の正解のうち 1 件にしか当たらない", () => Effect.gen(function* () {
    const script = decisionNode("予算の上限を決める", ["r1", "r3"]);
    const items = [
      { from: 1, to: 5, keywords: ["予算"] },
      { from: 20, to: 25, keywords: ["上限"] },
    ];
    expect(yield* decisionRecall(script, items)).toBe("1/2 (50%)");
  }));

  it.effect("当てられる組み合わせが複数あるときは、当たる件数が最大になる割り当てを選ぶ（先頭から貪欲に当てると 1 件になる例）", () => Effect.gen(function* () {
    // N1「予算」「上限」を含む / N2「予算」だけ。T1「予算」は N1・N2 に、T2「上限」は N1 にだけ当たる。
    // T1 を先に N1 へ当てると T2 が余る。T1→N2、T2→N1 なら 2 件。
    const script = decisionNodes({ text: "予算の上限を決める" }, { text: "予算は据え置く" });
    const items = [
      { from: 1, to: 5, keywords: ["予算"] },
      { from: 1, to: 5, keywords: ["上限"] },
    ];
    expect(yield* decisionRecall(script, items)).toBe("2/2 (100%)");
  }));

  it.effect("言い換えの候補（配列の要素）のどれか 1 つで当たる", () => Effect.gen(function* () {
    const keywords = ["切り替え", ["二月末", "2月末"]];
    expect(yield* decisionRecall(decisionNode("切り替えは2月末にする"), [{ from: 1, to: 5, keywords }])).toBe("1/1 (100%)");
    expect(yield* decisionRecall(decisionNode("切り替えは二月末にする"), [{ from: 1, to: 5, keywords }])).toBe("1/1 (100%)");
  }));

  it.effect("どの候補も含まれなければ外れる", () => Effect.gen(function* () {
    const keywords = ["切り替え", ["三月末", "3月末"]];
    expect(yield* decisionRecall(decisionNode("切り替えは2月末にする"), [{ from: 1, to: 5, keywords }])).toBe("0/1 (0%)");
  }));

  it.effect("全角・半角と空白の違いで外れない（本文の側でもキーワードの側でも）", () => Effect.gen(function* () {
    expect(yield* decisionRecall(decisionNode("切り替えは ２ 月末"), [{ from: 1, to: 5, keywords: ["切り替え", "2月末"] }])).toBe("1/1 (100%)");
    expect(yield* decisionRecall(decisionNode("切り替えは2月末"), [{ from: 1, to: 5, keywords: ["切り 替え", "２月末"] }])).toBe("1/1 (100%)");
    expect(yield* decisionRecall(decisionNode("製品はＡ社にする"), [{ from: 1, to: 5, keywords: ["A社"] }])).toBe("1/1 (100%)");
    expect(yield* decisionRecall(decisionNode("製品はA社にする"), [{ from: 1, to: 5, keywords: ["Ａ　社"] }])).toBe("1/1 (100%)");
  }));

  it.effect("漢数字と算用数字は読み替えない", () => Effect.gen(function* () {
    expect(yield* decisionRecall(decisionNode("切り替えは二月末にする"), [{ from: 1, to: 5, keywords: ["2月末"] }])).toBe("0/1 (0%)");
  }));
});

describe("eval: 正解ファイルの検証", () => {
  const item = { text: "x", from: 1, to: 2, keywords: ["x"] };
  const invalid: [string, unknown][] = [
    ["JSON として読めない", "{ not json"],
    ["オブジェクトでない", []],
    ["決定のキーが無い", { TODO: [item] }],
    ["TODO のキーが無い", { 決定: [item] }],
    ["決定が配列でない", { 決定: item, TODO: [] }],
    ["from が数でない", { 決定: [{ ...item, from: "1" }], TODO: [] }],
    ["to が数でない", { 決定: [], TODO: [{ text: "x", from: 1, keywords: ["x"] }] }],
    ["from が to より大きい", { 決定: [{ ...item, from: 5, to: 2 }], TODO: [] }],
    ["keywords が無い", { 決定: [{ text: "x", from: 1, to: 2 }], TODO: [] }],
    ["keywords が空", { 決定: [{ ...item, keywords: [] }], TODO: [] }],
    ["keywords が配列でなく文字列", { 決定: [{ ...item, keywords: "x" }], TODO: [] }],
    ["keywords の要素が数", { 決定: [{ ...item, keywords: [1] }], TODO: [] }],
    ["keywords の配列の中身が数", { 決定: [{ ...item, keywords: [["a", 1]] }], TODO: [] }],
    ["keywords の要素が空の配列", { 決定: [{ ...item, keywords: [[]] }], TODO: [] }],
    ["keywords の要素が空文字", { 決定: [{ ...item, keywords: [""] }], TODO: [] }],
    ["keywords の要素が空白だけ", { 決定: [{ ...item, keywords: [" \u3000"] }], TODO: [] }],
  ];

  for (const [name, bad] of invalid) {
    it.effect(`${name}正解は、ファイルのパスを含む InvalidTruthFile で止まる`, () => Effect.gen(function* () {
      const dir = yield* play(scriptA);
      const path = yield* writeTruth(bad);
      const failure = yield* evalFailure(["--truth", path, dir]);
      expect(failure.tag).toBe("InvalidTruthFile");
      expect(carries(failure.values, path)).toBe(true);
    }));
  }

  it.effect("失敗の理由は、どの種別の何件目かを含む", () => Effect.gen(function* () {
    const dir = yield* play(scriptA);
    const path = yield* writeTruth({ 決定: [], TODO: [item, { text: "y", from: 1, to: 2 }] });
    const failure = yield* evalFailure(["--truth", path, dir]);
    expect(failure.tag).toBe("InvalidTruthFile");
    expect(carries(failure.values, "「TODO」の 2 件目")).toBe(true);
  }));
});

describe("eval: bench の正解ファイル", () => {
  const meetings = join(import.meta.dirname, "../bench/meetings");
  it.each(["deciding", "lecture", "long", "sharing"])("%s.truth.json は、全件に keywords があり Truth の Schema で decode できる", (name) => {
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Truth));
    expect(() => decode(readFileSync(join(meetings, `${name}.truth.json`), "utf8"))).not.toThrow();
  });
});

describe("eval: 差分更新のトークン数の合計", () => {
  const USAGE_HEADERS = ["入力トークン", "キャッシュ書き込みトークン", "キャッシュ読み出しトークン", "出力トークン"];
  const usageCells = (row: Record<string, string>) => USAGE_HEADERS.map((h) => row[h]);
  const first: DiffUsage = { input: 100, cacheWrite: 20, cacheRead: 3000, output: 50, model: "claude-haiku-5-5" };
  const second: DiffUsage = { input: 11, cacheWrite: 0, cacheRead: 4000, output: 7, model: "claude-haiku-5-5" };

  it.effect("diff の行ごとの usage を列ごとに足した合計が出る。金額の列は出ない", () => Effect.gen(function* () {
    const { header, rows } = parseTable(yield* evalCli([yield* play(scriptA, fixture, [first, second])]));

    expect(usageCells(rows[0]!)).toEqual(["111", "20", "7000", "57"]);
    expect(header.some((h) => /円|\$|費用|コスト|金額|cost/i.test(h))).toBe(false);
  }));

  it.effect("usage を返さなかった回の diff の行は足さず、返した回の分だけが合計になる", () => Effect.gen(function* () {
    const { rows } = parseTable(yield* evalCli([yield* play(scriptA, fixture, [first])]));

    expect(usageCells(rows[0]!)).toEqual(["100", "20", "3000", "50"]);
  }));

  it.effect("usage が 1 行も無いランは 4 列とも - になる（0 ではない）", () => Effect.gen(function* () {
    const { rows } = parseTable(yield* evalCli([yield* play(scriptA)]));

    expect(usageCells(rows[0]!)).toEqual(["-", "-", "-", "-"]);
  }));

  it.effect("0 トークンの usage を返したランは - ではなく 0 になる", () => Effect.gen(function* () {
    const zero: DiffUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, model: "m" };
    const { rows } = parseTable(yield* evalCli([yield* play(scriptA, fixture, [zero])]));

    expect(usageCells(rows[0]!)).toEqual(["0", "0", "0", "0"]);
  }));

  it.effect("log.jsonl が無いランは - になる", () => Effect.gen(function* () {
    const dir = yield* play(scriptA, fixture, [first, second]);
    yield* Effect.promise(() => rm(join(dir, "log.jsonl")));
    const { rows } = parseTable(yield* evalCli([dir]));

    expect(usageCells(rows[0]!)).toEqual(["-", "-", "-", "-"]);
  }));

  it.effect("ランごとに合計され、usage のあるランと無いランが同じ表に並ぶ", () => Effect.gen(function* () {
    const withUsage = yield* play(scriptA, fixture, [first, second]);
    const without = yield* play(scriptB);
    const { rows } = parseTable(yield* evalCli([withUsage, without]));

    const byRun = (dir: string) => rows.find((r) => r["ラン"] === basename(dir))!;
    expect(usageCells(byRun(withUsage))).toEqual(["111", "20", "7000", "57"]);
    expect(usageCells(byRun(without))).toEqual(["-", "-", "-", "-"]);
  }));
});

describe("eval --screen-truth: 共有画面の正解の列", () => {
  // scriptA のノード（根拠）: 議題「採用」r1 [0.5, 9.8] / 論点「面接は何回か」r2 / 案「1 回で足りる」r2 / TODO「求人票を直す」r2 [9.8, 19.2] / 決定「2 回にする」r1・r3 [19.2, 28.0]
  const SCREEN_HEADERS = ["指す発言", "うち記憶", "話だけ", "出てはいけない"];
  const point = (keywords: unknown, from = 1, to = 5, extra: Record<string, unknown> = {}) => ({ text: "x", from, to, keywords, ...extra });
  const screenTruth = (parts: { 指す発言?: unknown[]; 話だけ?: unknown[]; 出てはいけない?: unknown[] }) => ({
    指す発言: [],
    話だけ: [],
    出てはいけない: [],
    ...parts,
  });
  const screenRow = (truth: unknown, script: Op[][] = scriptA) => Effect.gen(function* () {
    const { rows } = parseTable(yield* evalCli(["--screen-truth", yield* writeTruth(truth), yield* play(script)]));
    return rows[0]!;
  });
  const columns = (row: Record<string, string>) => SCREEN_HEADERS.map((h) => row[h]);

  describe("表の形", () => {
    it.effect("--screen-truth だけを付けると、今の列の後ろに 4 列が決まった順で足され、再現率の列は出ない", () => Effect.gen(function* () {
      const { header, rows } = parseTable(yield* evalCli(["--screen-truth", yield* writeTruth(screenTruth({ 指す発言: [point(["採用"])] })), yield* play(scriptA)]));
      expect(header.slice(0, 4)).toEqual(["ラン", "会議", "ノード", "深さ"]);
      expect(header.slice(-4)).toEqual(SCREEN_HEADERS);
      expect(header).toHaveLength(4 + 7 + 3 + 4 + 4);
      expect(header.some((h) => h.includes("再現率"))).toBe(false);
      expect(rows[0]).toMatchObject({ ノード: "5", 深さ: "3" });
    }));

    it.effect("--truth と一緒に付けると、再現率の列の後ろに 4 列が続き、6 列それぞれに正しい値が入る", () => Effect.gen(function* () {
      const truth = yield* writeTruth({
        決定: [
          { text: "x", from: 20, to: 25, keywords: ["2回"] },
          { text: "y", from: 28.1, to: 40, keywords: ["2回"] },
        ],
        TODO: [{ text: "z", from: 10, to: 15, keywords: ["求人票"] }],
      });
      const screen = yield* writeTruth(screenTruth({
        指す発言: [point(["採用"], 1, 5, { memory: true }), point(["面接"], 10, 15), point(["存在しない"])],
        話だけ: [point(["求人票"], 10, 15), point(["採用"], 20, 25)],
        出てはいけない: [{ keywords: ["求人票"] }, { keywords: ["存在しない"] }, { keywords: ["2回"] }, { keywords: ["存在しない2"] }],
      }));
      const { header, rows } = parseTable(yield* evalCli(["--truth", truth, "--screen-truth", screen, yield* play(scriptA)]));
      const last8 = header.slice(-8);
      expect(last8).toEqual(["決定の再現率", "TODO の再現率", "決定の種別違い", "TODO の種別違い", ...SCREEN_HEADERS]);
      expect(last8.map((h) => rows[0]![h])).toEqual(["1/2 (50%)", "1/1 (100%)", "0", "0", "2/3", "1/1", "1/2", "2/4"]);
    }));

    it.effect("--screen-truth を付けないときは、4 列のどれも出ない", () => Effect.gen(function* () {
      const dir = yield* play(scriptA);
      for (const args of [[dir], ["--truth", yield* writeTruth({ 決定: [], TODO: [] }), dir]]) {
        const { header } = parseTable(yield* evalCli(args));
        for (const h of SCREEN_HEADERS) expect(header).not.toContain(h);
      }
    }));

    it.effect("セルは「取れた数/項目数」で、割合は付けない。0 件でも 0/0", () => Effect.gen(function* () {
      expect(columns(yield* screenRow(screenTruth({})))).toEqual(["0/0", "0/0", "0/0", "0/0"]);
      expect(columns(yield* screenRow(screenTruth({ 指す発言: [point(["採用"])] })))).toEqual(["1/1", "0/0", "0/0", "0/0"]);
    }));

    it.effect("同じ正解を複数のランに当てて、ランごとに数える", () => Effect.gen(function* () {
      const dirA = yield* play(scriptA);
      const dirEmpty = yield* play([[], []]);
      const truth = screenTruth({ 指す発言: [point(["採用"])], 出てはいけない: [{ keywords: ["求人票"] }] });
      const { rows } = parseTable(yield* evalCli(["--screen-truth", yield* writeTruth(truth), dirA, dirEmpty]));
      expect(rows.map((r) => r["指す発言"])).toEqual(["1/1", "0/1"]);
      expect(rows.map((r) => r["出てはいけない"])).toEqual(["1/1", "0/1"]);
    }));
  });

  describe("指す発言・話だけ（時刻・キーワード・種別・一対一）", () => {
    it.effect("種別では絞らない（議題・TODO・決定のどれのノードにも当たる）", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({
        指す発言: [point(["採用"]), point(["求人票"], 10, 15), point(["2回"], 20, 25)],
      }));
      expect(row["指す発言"]).toBe("3/3");
    }));

    it.effect("根拠の発言の時刻が範囲に重ならなければ取れない", () => Effect.gen(function* () {
      expect((yield* screenRow(screenTruth({ 指す発言: [point(["採用"], 20, 25)] })))["指す発言"]).toBe("0/1");
      expect((yield* screenRow(screenTruth({ 指す発言: [point(["採用"], 9.8, 12)] })))["指す発言"]).toBe("1/1");
    }));

    it.effect("キーワードがすべて入っていなければ取れない（言い換えの配列はどれか 1 つ）", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({
        指す発言: [point(["2回", "存在しない"], 20, 25), point([["存在しない", "2回"]], 20, 25)],
      }));
      expect(row["指す発言"]).toBe("1/2");
    }));

    it.effect("1 つのノードに当たる正解が 2 件あっても、取れるのは 1 件（一対一）", () => Effect.gen(function* () {
      expect((yield* screenRow(screenTruth({ 指す発言: [point(["採用"]), point(["採用"], 2, 3)] })))["指す発言"]).toBe("1/2");
    }));

    it.effect("一対一の割り当ては、取れる数が最大になるように組む（先の正解がノードを譲る）", () => Effect.gen(function* () {
      // 先の正解は「面接は何回か」「1 回で足りる」のどちらにも当たり、後の正解は「面接は何回か」だけに当たる
      const row = yield* screenRow(screenTruth({ 指す発言: [point(["回"], 10, 15), point(["面接"], 10, 15)] }));
      expect(row["指す発言"]).toBe("2/2");
    }));

    it.effect("話だけも同じ照合で数える", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 話だけ: [point(["求人票"], 10, 15), point(["求人票"], 10, 15), point(["採用"], 20, 25)] }));
      expect(row["話だけ"]).toBe("1/3");
      expect(row["指す発言"]).toBe("0/0");
    }));

    it.effect("指す発言と話だけは別々に数える（同じノードに当たっても両方が取れる）", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 指す発言: [point(["採用"])], 話だけ: [point(["採用"])] }));
      expect(columns(row)).toEqual(["1/1", "0/0", "1/1", "0/0"]);
    }));

    it.effect("全角・半角と空白の違いは吸収して照合する", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 指す発言: [point(["２ 回 に する"], 20, 25)] }));
      expect(row["指す発言"]).toBe("1/1");
    }));

    it.effect("ノードが無ければ 0 件になる", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 指す発言: [point(["採用"])], 話だけ: [point(["採用"])] }), [[], []]);
      expect(columns(row)).toEqual(["0/1", "0/0", "0/1", "0/0"]);
    }));
  });

  describe("うち記憶（memory: true の指す発言のうち取れた数）", () => {
    it.effect("memory が true の項目だけが分母になる（false・省略は数えない）。指す発言には全項目が入る", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({
        指す発言: [
          point(["採用"], 1, 5, { memory: true }),
          point(["求人票"], 10, 15, { memory: false }),
          point(["面接"], 10, 15),
        ],
      }));
      expect(row["指す発言"]).toBe("3/3");
      expect(row["うち記憶"]).toBe("1/1");
    }));

    it.effect("memory が true でも取れなければ、うち記憶は取れた数に入らない", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({
        指す発言: [point(["採用"], 20, 25, { memory: true }), point(["採用"], 1, 5)],
      }));
      expect(row["指す発言"]).toBe("1/2");
      expect(row["うち記憶"]).toBe("0/1");
    }));

    it.effect("話だけの memory は数えない", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 話だけ: [point(["採用"], 1, 5, { memory: true })] }));
      expect(row["うち記憶"]).toBe("0/0");
    }));

    it.effect("memory の項目が、他の項目とノードを取り合っても、取れた数は食い違わない", () => Effect.gen(function* () {
      // 後ろの memory 項目は「面接は何回か」にしか当たらず、前の memory でない項目と競合する
      const row = yield* screenRow(screenTruth({
        指す発言: [point(["回"], 10, 15), point(["面接"], 10, 15, { memory: true })],
      }));
      expect(row["指す発言"]).toBe("2/2");
      expect(row["うち記憶"]).toBe("1/1");
    }));
  });

  describe("出てはいけない（時刻を問わず、キーワードを含むノードがあれば漏れ）", () => {
    it.effect("時刻を持たない項目でも、どの時刻のノードに含まれても漏れに数える", () => Effect.gen(function* () {
      // 「求人票」は r2、「2回」は r1・r3 の根拠のノード。項目に時刻は無い
      const row = yield* screenRow(screenTruth({ 出てはいけない: [{ keywords: ["求人票"] }, { keywords: ["2回"] }] }));
      expect(row["出てはいけない"]).toBe("2/2");
    }));

    it.effect("どのノードにも無いキーワードは漏れではない", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 出てはいけない: [{ keywords: ["存在しない"] }, { keywords: ["求人票"] }] }));
      expect(row["出てはいけない"]).toBe("1/2");
    }));

    it.effect("keywords の要素のどれか 1 つでも含まれれば漏れ（指す発言と違い、すべては要らない）", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 出てはいけない: [{ keywords: ["存在しない", "採用"] }] }));
      expect(row["出てはいけない"]).toBe("1/1");
    }));

    it.effect("言い換えの配列のどれか 1 つでも含まれれば漏れ", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 出てはいけない: [{ keywords: [["存在しない", "採用"]] }, { keywords: [["存在しない", "ない"]] }] }));
      expect(row["出てはいけない"]).toBe("1/2");
    }));

    it.effect("全角・半角と空白の違いは吸収して漏れに数える", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 出てはいけない: [{ keywords: ["２ 回 に する"] }] }));
      expect(row["出てはいけない"]).toBe("1/1");
    }));

    it.effect("同じノードを指す項目が複数あれば、項目ごとに漏れに数える（一対一にしない）", () => Effect.gen(function* () {
      const row = yield* screenRow(screenTruth({ 出てはいけない: [{ keywords: ["採用"] }, { keywords: ["採用"] }, { text: "y", slide: "s", keywords: ["採用"] }] }));
      expect(row["出てはいけない"]).toBe("3/3");
    }));

    it.effect("ノードが無ければ漏れは 0", () => Effect.gen(function* () {
      expect((yield* screenRow(screenTruth({ 出てはいけない: [{ keywords: ["採用"] }] }), [[], []]))["出てはいけない"]).toBe("0/1");
    }));
  });

  describe("壊れた正解は、理由つきで読み込みに失敗する", () => {
    const ok = point(["採用"]);
    const invalid: [string, unknown, string][] = [
      ["指す発言が配列でない", screenTruth({ 指す発言: {} as never }), "「指す発言」は配列で書く"],
      ["話だけが配列でない", { ...screenTruth({}), 話だけ: "x" }, "「話だけ」は配列で書く"],
      ["出てはいけないのキーが無い", { 指す発言: [], 話だけ: [] }, "「出てはいけない」は配列で書く"],
      ["出てはいけないのキーワードが空", screenTruth({ 出てはいけない: [{ keywords: [] }] }), "「出てはいけない」の 1 件目: keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）"],
      ["出てはいけないにキーワードが無い", screenTruth({ 出てはいけない: [{ text: "x" }] }), "「出てはいけない」の 1 件目: keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）"],
      ["指す発言のキーワードが空文字", screenTruth({ 指す発言: [ok, point([""])] }), "「指す発言」の 2 件目: keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）"],
      ["話だけの from が to より大きい", screenTruth({ 話だけ: [point(["x"], 5, 2)] }), "「話だけ」の 1 件目: from が to より大きい"],
      ["指す発言に from が無い", screenTruth({ 指す発言: [{ keywords: ["x"] }] }), "「指す発言」の 1 件目: from / to は秒の数値で書く"],
    ];

    for (const [name, bad, reason] of invalid) {
      it.effect(name, () => Effect.gen(function* () {
        const dir = yield* play(scriptA);
        const path = yield* writeTruth(bad);
        const failure = yield* evalFailure(["--screen-truth", path, dir]);
        expect(failure.tag).toBe("InvalidTruthFile");
        expect(carries(failure.values, path)).toBe(true);
        expect(failure.values["reason"]).toBe(reason);
      }));
    }

    it.effect("--truth と一緒でも、壊れた共有画面の正解は InvalidTruthFile で止まる", () => Effect.gen(function* () {
      const dir = yield* play(scriptA);
      const path = yield* writeTruth(screenTruth({ 出てはいけない: [{ keywords: [] }] }));
      const failure = yield* evalFailure(["--truth", yield* writeTruth({ 決定: [], TODO: [] }), "--screen-truth", path, dir]);
      expect(failure.tag).toBe("InvalidTruthFile");
      expect(carries(failure.values, path)).toBe(true);
    }));

    it.effect("読み込めない共有画面の正解（無いファイル）は InvalidTruthFile で止まる", () => Effect.gen(function* () {
      const dir = yield* play(scriptA);
      const path = join(yield* Effect.promise(() => mkdtemp(join(tmpdir(), "live-mindmap-truth-"))), "missing.screen.truth.json");
      const failure = yield* evalFailure(["--screen-truth", path, dir]);
      expect(failure.tag).toBe("InvalidTruthFile");
      expect(carries(failure.values, path)).toBe(true);
    }));
  });
});
