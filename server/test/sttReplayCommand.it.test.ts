// bench/sttReplay.ts の Command。Claude への接続（claude.ts）だけを偽物にし、再生・集計・出力・失敗は本物で通す
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { beforeEach, vi } from "vitest";
import { reportFailure } from "../bench/entry.ts";
import * as benchEntry from "../bench/entry.ts";
import { command } from "../bench/sttReplay.ts";
import { command as peopleAccuracy } from "../bench/peopleAccuracy.ts";
import { LogEvent, type DiffInput } from "../src/core/index.ts";
import { SpeakerNameLogEvent } from "../src/core/speakerNames.ts";
import { evalManagedDeps } from "./fixtures/evalManagedDeps.ts";
import { consoleCapture, runCommand as runBenchCommand, taggedFailure, temporaryDirectory } from "./benchRun.ts";

const external = vi.hoisted(() => ({ openClaudeUpdater: vi.fn() }));
vi.mock("../src/claude.ts", async (importOriginal) => ({
  ...(await import("./fixtures/claudeModule.ts")).fakeClaudeModule(() => external.openClaudeUpdater()),
  AgentSdk: (await importOriginal<typeof import("../src/claude.ts")>()).AgentSdk,
}));

const calls: string[][] = [];
const close = vi.fn();
let counter = 0;
let managed: ReturnType<typeof evalManagedDeps>;

beforeEach(() => {
  managed = evalManagedDeps("ready");
  calls.length = 0;
  counter = 0;
  close.mockReset();
  external.openClaudeUpdater.mockReset();
  external.openClaudeUpdater.mockImplementation(() => ({
    update: (input: DiffInput) => Effect.sync(() => {
      calls.push(input.fresh.map((u) => u.id));
      counter += 1;
      return { ops: [{ op: "add", ref: `t${counter}`, parent: "root", kind: "TODO", text: "採用", evidence: input.fresh.map((u) => u.id) }] };
    }),
    close,
  }));
});

const items = [{ id: "r1", track: "相手", start: 0, end: 1, text: "採用", at: 0 }];

const writeInputs = (dir: string) => {
  const file = join(dir, "items.json");
  writeFileSync(file, JSON.stringify(items));
  return file;
};

const runCommand = (args: string[]) =>
  runBenchCommand(command, args).pipe(Effect.provide(managed.layer));

describe("sttReplay の Command", () => {
  it.effect("推定名を本番の規則で受け入れて記録し、後続の差分入力と採点へ渡す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "named.json");
    const inputs: DiffInput[] = [];
    external.openClaudeUpdater.mockImplementation(() => ({
      update: (input: DiffInput) => Effect.sync(() => {
        inputs.push(input);
        const name = inputs.length === 1 ? "乙" : inputs.length === 2 ? "丙" : "甲";
        return {
          ops: [], processedRemarks: 1,
          names: [{
            label: "相手 A", name, evidence: input.fresh[0]!.id,
            basis: inputs.length === 2 ? "呼びかけへの応答" : "名乗り",
          }],
        };
      }),
      close,
    }));
    writeFileSync(file, JSON.stringify(Array.from({ length: 4 }, (_, i) => ({
      id: `r${i + 1}`, track: "相手", start: i, end: i + 1, text: "名乗り", speaker: "相手 A", at: 0,
    }))));
    const { result, stdout } = yield* runCommand([file]);
    expect(result._tag).toBe("Success");
    expect(inputs.map((input) => input.speakerNames?.get("相手 A"))).toEqual([undefined, "乙", "乙", "甲"]);
    const sessionDir = stdout.trimEnd().split("\n").at(-1)!.slice("セッション: ".length);
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Union([
      LogEvent, Schema.Struct({ ...SpeakerNameLogEvent.fields, at: Schema.String }),
    ])));
    const names = readFileSync(join(sessionDir, "log.jsonl"), "utf8").trim().split("\n")
      .map((line) => decode(line)).filter((event) => event.type === "speaker-name");
    expect(names.map(({ label, name, source }) => ({ label, name, source }))).toEqual([
      { label: "相手 A", name: "乙", source: "推定" },
      { label: "相手 A", name: "甲", source: "推定" },
    ]);
    expect(names.every((event) => Number.isFinite(Date.parse(event.at)))).toBe(true);
    const timeline = join(dir, "timeline.tsv");
    const truth = join(dir, "truth.json");
    writeFileSync(timeline, "甲\t0\t4\t名乗り\n");
    writeFileSync(truth, JSON.stringify({ 決定: [], TODO: [] }));
    const scored = yield* runBenchCommand(peopleAccuracy, ["--self", "司会", timeline, truth, sessionDir]);
    expect(scored.result._tag).toBe("Success");
    const cells = scored.stdout.trimEnd().split("\n").map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
    const column = (name: string) => cells[2]![cells[0]!.indexOf(name)]!;
    expect(column("名前 付いたラベル")).toBe("1");
    expect(column("誤った名前")).toBe("0");
    expect(column("名前 正しい")).toBe("100.0%");
    expect(column("名前まで")).toMatch(/^\d+\.\d$/);
    expect(close).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped));

  it.effect("入力の話者を本番セッションのremarkログへ保存する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "speakers.json");
    const spoken = [
      { id: "r1", track: "相手", start: 0, end: 1, text: "提案", speaker: "相手 B" },
      { id: "r2", track: "自分", start: 1, end: 2, text: "確認" },
      { id: "r3", track: "相手", start: 2, end: 3, text: "話者なし" },
    ];
    writeFileSync(file, JSON.stringify(spoken.map((r) => ({ ...r, at: 0, source: "final" }))));
    const { result, stdout } = yield* runCommand([file]);
    expect(result._tag).toBe("Success");
    const sessionDir = stdout.trimEnd().split("\n").at(-1)!.slice("セッション: ".length);
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(LogEvent));
    const remarks = readFileSync(join(sessionDir, "log.jsonl"), "utf8").trim().split("\n")
      .map((line) => decode(line)).flatMap((event) => event.type === "remark" ? [event.remark] : []);
    expect(remarks).toEqual(spoken);
  }).pipe(Effect.scoped));

  it.effect("発言だけを渡すと、遅れの 1 行とセッションのパスの 1 行を stdout に出し、再生した発言が差分更新に渡る", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const { result, stdout, stderr } = yield* runCommand([writeInputs(dir)]);
    expect(result._tag).toBe("Success");
    const lines = stdout.split("\n");
    expect(lines).toHaveLength(3); // 末尾の改行で最後が空
    expect(lines[0]).toMatch(/^話し終わり → ノード p50 -?\d+\.\d 秒 \/ p90 -?\d+\.\d 秒（1 件）$/);
    expect(lines[1]).toMatch(/^セッション: .+/);
    expect(lines[2]).toBe("");
    expect(stderr).toBe("");
    expect(calls.flat()).toEqual(["r1"]);
    expect(managed.load).toHaveBeenCalledExactlyOnceWith("claude");
    // 出したパスは実在するセッションのフォルダで、再生のログが書かれている
    const sessionDir = lines[1]!.slice("セッション: ".length);
    expect(existsSync(join(sessionDir, "log.jsonl"))).toBe(true);
  }).pipe(Effect.scoped));

  it.effect("--title がセッションの開始ログの題名になる（既定は bench）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = writeInputs(dir);
    const startTitle = (stdout: string) => {
      const sessionDir = stdout.trimEnd().split("\n").at(-1)!.slice("セッション: ".length);
      const start = readFileSync(join(sessionDir, "log.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { type?: string; title?: string }).find((e) => e.type === "start");
      return start?.title;
    };
    expect(startTitle((yield* runCommand([file])).stdout)).toBe("bench");
    expect(startTitle((yield* runCommand([file, "--title", "定例"])).stdout)).toBe("定例");
  }).pipe(Effect.scoped));

  it.effect("--truth の再現率を、遅れの行とセッションの行の間に出す（--lines も読む）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = writeInputs(dir);
    const truth = join(dir, "truth.json");
    const lines = join(dir, "lines.json");
    writeFileSync(truth, JSON.stringify({ 決定: [], TODO: [{ from: 0, to: 9, keywords: ["採用"] }] }));
    writeFileSync(lines, JSON.stringify([{ start: 0, end: 1 }, { start: 100, end: 101 }]));
    const { result, stdout } = yield* runCommand([file, "--truth", truth, "--lines", lines]);
    expect(result._tag).toBe("Success");
    const out = stdout.split("\n");
    expect(out[0]).toMatch(/（1 件）$/); // 覆う発言のない行（100〜101 秒）は数えない
    expect(out[1]).toBe("再現率 決定 0/0 TODO 1/1");
    expect(out[2]).toMatch(/^セッション: /);
  }).pipe(Effect.scoped));

  it.effect("差分更新は再生が終わったら閉じる（成功しても失敗しても 1 回だけ）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    yield* runCommand([writeInputs(dir)]);
    expect(close).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped));

  it.effect.each([
    { name: "JSON 構文", content: "{ not json" },
    { name: "必須キー", content: JSON.stringify({ TODO: [] }) },
    { name: "keywords", content: JSON.stringify({ 決定: [{ from: 1, to: 2, keywords: [] }], TODO: [] }) },
  ])("壊れた正解ファイル（$name）は、再生の前に InvalidTruthFile（CliError ではない）で失敗し、何も出さず差分更新も呼ばない", ({ content }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const truth = join(dir, "bad.truth.json");
    writeFileSync(truth, content);
    const { result, stdout } = yield* runCommand([writeInputs(dir), "--truth", truth]);
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("InvalidTruthFile");
    expect(failure?.path).toBe(truth);
    expect(String(failure?.reason)).not.toBe("");
    expect(stdout).toBe("");
    expect(calls).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1); // 開いた差分更新は失敗でも閉じる
  }).pipe(Effect.scoped));

  it.effect("セッションのフォルダを一時領域に作れないときは、文字列ではなく ReplaySessionFailed（パス入り）で失敗し、何も出さず差分更新も呼ばない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = writeInputs(dir);
    vi.stubEnv("TMPDIR", join(dir, "no-such-tmp"));
    const { result, stdout } = yield* runCommand([file]).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("ReplaySessionFailed");
    expect(String(failure?.path)).not.toBe("");
    expect(String(failure?.reason)).not.toBe("");
    expect(stdout).toBe("");
    expect(calls).toEqual([]);
    // 入口は stderr に「<パス>: 再生のセッションを作れないか、そのログを読めません（<理由>）」の 1 行を出す
    const reported = consoleCapture();
    yield* reportFailure(Cause.fail(failure)).pipe(Effect.provide(reported.layer));
    expect(reported.stdout).toEqual([]);
    expect(reported.stderr).toHaveLength(1);
    expect(reported.stderr[0]!.startsWith(`${failure?.path}: 再生のセッションを作れないか、そのログを読めません（`)).toBe(true);
    expect(reported.stderr[0]!).toContain(String(failure?.reason));
    expect(reported.stderr[0]!.endsWith("）\n")).toBe(true);
  }).pipe(Effect.scoped));

  it.effect("正解ファイルが無いとき、入口は「<パス>: 正解ファイルが不正です（<理由>）」の 1 行を stderr に出し、exit 1 で終わる", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const truth = join(dir, "missing.truth.json");
    const { result } = yield* runCommand([writeInputs(dir), "--truth", truth]);
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("InvalidTruthFile");
    const reported = consoleCapture();
    yield* reportFailure(Cause.fail(failure)).pipe(Effect.provide(reported.layer));
    const saved = process.exitCode;
    try {
      benchEntry.exitNaturallyForManagedDeps(Exit.fail(failure), () => { throw new Error("自然終了する必要があります"); });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved;
    }
    expect(reported.stdout).toEqual([]);
    expect(reported.stderr).toHaveLength(1);
    expect(reported.stderr[0]!.startsWith(`${truth}: 正解ファイルが不正です（`)).toBe(true);
    expect(reported.stderr[0]!.endsWith("）\n")).toBe(true);
  }).pipe(Effect.scoped));

  it.effect.each([
    { name: "JSON 構文", content: "{ not json" },
    { name: "形が違う（id が無い）", content: JSON.stringify([{ track: "相手", start: 0, end: 1, text: "x", at: 0 }]) },
    { name: "形が違う（at が無い）", content: JSON.stringify([{ id: "r1", track: "相手", start: 0, end: 1, text: "x" }]) },
  ])("壊れた発言ファイル（$name）は InvalidInputFile で、パスを持つ", ({ content }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "items.json");
    writeFileSync(file, content);
    const { result, stdout } = yield* runCommand([file]);
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("InvalidInputFile");
    expect(failure?.path).toBe(file);
    expect(stdout).toBe("");
    expect(calls).toEqual([]);
  }).pipe(Effect.scoped));

  it.effect("壊れた --lines は、その行の時刻のファイルのパスで InvalidInputFile", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const lines = join(dir, "lines.json");
    writeFileSync(lines, JSON.stringify([{ start: "0", end: 1 }]));
    const { result, stdout } = yield* runCommand([writeInputs(dir), "--lines", lines]);
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("InvalidInputFile");
    expect(failure?.path).toBe(lines);
    expect(stdout).toBe("");
  }).pipe(Effect.scoped));

  it.effect("発言ファイルの at・source は読み込みで落とさず、source つきの発言も再生できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "items.json");
    writeFileSync(file, JSON.stringify([{ ...items[0], source: "stable" }]));
    const { result } = yield* runCommand([file]);
    expect(result._tag).toBe("Success");
  }).pipe(Effect.scoped));

  // プロセスの入口（bench/sttReplay.ts の実行）が使う Command の、--help と位置引数の欠落。処理本体（SDK の確認）は走らない
  it.effect("--help は使い方を stdout に出して成功する（stderr は空。管理 SDK は確認しない）", () => Effect.gen(function* () {
    const { result, stdout, stderr } = yield* runCommand(["--help"]);
    expect(result._tag).toBe("Success");
    expect(stderr).toBe("");
    expect(stdout).toMatch(/Usage|USAGE/);
    expect(managed.check).not.toHaveBeenCalled();
    expect(managed.load).not.toHaveBeenCalled();
  }));

  it.effect("位置引数が無ければ、help を stdout に、ERROR を stderr に一度だけ出して CliError で失敗する（stack trace は出さない）", () => Effect.gen(function* () {
    const { result, stdout, stderr } = yield* runCommand([]);
    expect(result._tag).toBe("Failure");
    expect(taggedFailure(result)).toBeUndefined();
    expect(stdout).toMatch(/Usage|USAGE/);
    expect(stderr.split("\n").filter((l) => /^ERROR\b/.test(l))).toHaveLength(1);
    expect(stderr).not.toMatch(/\n\s+at /);
    expect(managed.load).not.toHaveBeenCalled();
  }));
});
