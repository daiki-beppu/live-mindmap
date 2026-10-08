// bench の sttLatency・sessionStats を effect/cli の Command として走らせたときの契約
// （引数の読み取り・stdout の中身と改行・タグ付きの失敗）。sttReplay は claude.ts の差し替えが要るので sttReplayCommand.it.test.ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, vi } from "vitest";
import { formatRow, parseLog, command as statsCommand, sessionStats } from "../bench/sessionStats.ts";
import { command as latencyCommand, finalRemarks, settleVolatile, summarize, type SttResult } from "../bench/sttLatency.ts";
import { runCommand, taggedFailure, temporaryDirectory } from "./benchRun.ts";

const partial = (arrival: number, start: number, end: number, text: string): SttResult => ({ track: "相手", arrival, isFinal: false, start, end, text });
const final = (arrival: number, start: number, end: number, text: string): SttResult => ({ track: "相手", arrival, isFinal: true, start, end, text });
const results = [partial(5, 0, 5, "あ"), partial(19, 0, 8, "あいう"), final(20, 0, 8, "あいう。"), final(31, 10, 12, "えお。")];
const resultsText = results.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("sttLatency の Command", () => {
  it.effect("結果ファイルだけを渡すと、しきい値 2 秒の集計の表を、今と同じ改行で stdout に出す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "results.jsonl");
    writeFileSync(file, resultsText);
    const { result, stdout, stderr } = yield* runCommand(latencyCommand, [file]);
    expect(result._tag).toBe("Success");
    expect(stdout).toBe(summarize(results, 2));
    expect(stderr).toBe("");
  }).pipe(Effect.scoped));

  it.effect("--quiet の秒数が集計に届く（小数も受ける）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "results.jsonl");
    writeFileSync(file, resultsText);
    const { stdout } = yield* runCommand(latencyCommand, [file, "--quiet", "3.5"]);
    expect(stdout).toBe(summarize(results, 3.5));
    expect(stdout).not.toBe(summarize(results, 2));
  }).pipe(Effect.scoped));

  it.effect("--lines の行の時刻から数えた遅れが表に届く", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "results.jsonl");
    const lines = [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }];
    writeFileSync(file, resultsText);
    writeFileSync(join(dir, "lines.json"), JSON.stringify(lines));
    const { stdout } = yield* runCommand(latencyCommand, [file, "--lines", join(dir, "lines.json")]);
    expect(stdout).toBe(summarize(results, 2, lines));
  }).pipe(Effect.scoped));

  it.effect.each([
    { emit: "final" as const },
    { emit: "discard" as const },
    { emit: "correct" as const },
  ])("--emit $emit は、その規則の発言を JSON 1 行（末尾の改行 1 つ）で出す", ({ emit }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "results.jsonl");
    writeFileSync(file, resultsText);
    const { stdout } = yield* runCommand(latencyCommand, [file, "--emit", emit]);
    const remarks = emit === "final" ? finalRemarks(results) : settleVolatile(results, { quietSeconds: 2, lateFinal: emit }).remarks;
    expect(stdout).toBe(JSON.stringify(remarks) + "\n");
  }).pipe(Effect.scoped));

  it.effect("--emit のときは --lines を読まない（今と同じ。行の時刻のファイルが無くても成功する）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "results.jsonl");
    writeFileSync(file, resultsText);
    const { result } = yield* runCommand(latencyCommand, [file, "--emit", "final", "--lines", join(dir, "no-such.json")]);
    expect(result._tag).toBe("Success");
  }).pipe(Effect.scoped));

  it.effect("結果ファイルが壊れていれば、パスを持つタグ付きの失敗（InvalidInputFile）で止まり、stdout は空", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "broken.jsonl");
    writeFileSync(file, `${JSON.stringify(results[0])}\n{"track":`);
    const { result, stdout } = yield* runCommand(latencyCommand, [file]);
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("InvalidInputFile");
    expect(failure?.path).toBe(file);
    expect(String(failure?.reason)).not.toBe("");
    expect(stdout).toBe("");
  }).pipe(Effect.scoped));

  it.effect("結果ファイルが読めなければ（無い）も InvalidInputFile", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "missing.jsonl");
    const { result } = yield* runCommand(latencyCommand, [file]);
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("InvalidInputFile");
    expect(failure?.path).toBe(file);
  }).pipe(Effect.scoped));

  it.effect("--lines のファイルが壊れていれば、その行の時刻のファイルのパスで InvalidInputFile", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "results.jsonl");
    const lines = join(dir, "lines.json");
    writeFileSync(file, resultsText);
    writeFileSync(lines, JSON.stringify([{ start: "0", end: 2 }]));
    const { result, stdout } = yield* runCommand(latencyCommand, [file, "--lines", lines]);
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("InvalidInputFile");
    expect(failure?.path).toBe(lines);
    expect(stdout).toBe("");
  }).pipe(Effect.scoped));

  it.effect("引数の誤り（--emit が規則外）は、タグ付きの失敗ではなく effect/cli の CliError", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "results.jsonl");
    writeFileSync(file, resultsText);
    const { result, stdout } = yield* runCommand(latencyCommand, [file, "--emit", "bogus"]);
    expect(result._tag).toBe("Failure");
    expect(taggedFailure(result)).toBeUndefined();
    expect(stdout).not.toContain("| 方式"); // 引数の誤りでは、集計の表（handler の出力）は出ない。使い方は effect/cli の Formatter が出す
  }).pipe(Effect.scoped));
});

const remarkLine = (track: "相手" | "自分", start: number, end: number) => JSON.stringify({ type: "remark", remark: { id: "r", track, start, end, text: "本文" } });
const logText = [JSON.stringify({ type: "start", title: "t" }), remarkLine("相手", 0, 4), remarkLine("自分", 2, 6), JSON.stringify({ type: "diff", ops: [{}], dropped: [] })].join("\n") + "\n";

describe("sessionStats の Command", () => {
  const expectedRow = (name: string) =>
    Effect.map(parseLog(logText), (events) => formatRow(name, sessionStats(events), null).join("\n") + "\n");

  it.effect("セッションのフォルダと --no-audio で、1 セッション分の行を今と同じ改行で出す（% の書式を解釈しない）", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const dir = join(root, "run-a");
    mkdirSync(dir);
    writeFileSync(join(dir, "log.jsonl"), logText);
    const { result, stdout } = yield* runCommand(statsCommand, [dir, "--no-audio"]);
    expect(result._tag).toBe("Success");
    expect(stdout).toBe(yield* expectedRow("run-a"));
    expect(stdout).toMatch(/%/);
  }).pipe(Effect.scoped));

  it.effect("並べたフォルダを渡すと、その下のセッションを名前順に 1 セッション 1 ブロックで出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    for (const name of ["b", "c", "a"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "log.jsonl"), logText);
    }
    const { stdout } = yield* runCommand(statsCommand, [root, "--no-audio"]);
    expect(stdout).toBe((yield* expectedRow("a")) + (yield* expectedRow("b")) + (yield* expectedRow("c")));
  }).pipe(Effect.scoped));

  it.effect("複数のパスは渡した順に出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    for (const name of ["b", "a"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "log.jsonl"), logText);
    }
    const { stdout } = yield* runCommand(statsCommand, [join(root, "b"), join(root, "a"), "--no-audio"]);
    expect(stdout).toBe((yield* expectedRow("b")) + (yield* expectedRow("a")));
  }).pipe(Effect.scoped));

  it.effect("位置引数のあとにフラグを置いても、前に置いても同じ（--no-audio を省略すると録音の列が付く）", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const dir = join(root, "run-a");
    mkdirSync(dir);
    writeFileSync(join(dir, "log.jsonl"), logText);
    const after = yield* runCommand(statsCommand, [dir, "--no-audio"]);
    const before = yield* runCommand(statsCommand, ["--no-audio", dir]);
    expect(before.stdout).toBe(after.stdout);
    const withAudio = yield* runCommand(statsCommand, [dir]);
    expect(withAudio.stdout).toContain("録音 0 本");
  }).pipe(Effect.scoped));

  describe("録音の読み取り（PATH 上の ffmpeg）", () => {
    afterEach(() => vi.unstubAllEnvs());

    // ffmpeg の代わりに PATH へ置く実行ファイル。長さと音量は、本物と同じく stderr に出す
    const withFfmpeg = (root: string, script: string | undefined) => {
      const bin = join(root, "bin");
      mkdirSync(bin);
      if (script !== undefined) {
        writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\n${script}\n`);
        chmodSync(join(bin, "ffmpeg"), 0o755);
      }
      vi.stubEnv("PATH", bin);
    };
    const sessionWithRecording = (root: string) => {
      const dir = join(root, "run-a");
      mkdirSync(dir);
      writeFileSync(join(dir, "log.jsonl"), logText);
      writeFileSync(join(dir, "相手.m4a"), "");
      return dir;
    };
    const report = 'echo "  Duration: 00:01:05.50, start: 0.0" >&2; echo "[Parsed_volumedetect_0] mean_volume: -23.5 dB" >&2';

    it.effect("ffmpeg が stderr に出した長さと平均音量を、録音の列と長さに使う", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const dir = sessionWithRecording(root);
      withFfmpeg(root, report);
      const { stdout } = yield* runCommand(statsCommand, [dir]);
      expect(stdout).toContain("録音 1 本・-23.5 dB");
      expect(stdout).toContain("長さ 66s");
    }).pipe(Effect.scoped));

    it.effect("ffmpeg が 0 以外の終了コードで終わっても、出力は読む", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const dir = sessionWithRecording(root);
      withFfmpeg(root, `${report}; exit 1`);
      const { result, stdout } = yield* runCommand(statsCommand, [dir]);
      expect(result._tag).toBe("Success");
      expect(stdout).toContain("録音 1 本・-23.5 dB");
    }).pipe(Effect.scoped));

    it.effect("ffmpeg が見つからなければ、失敗にせず空の出力として扱い「読めない」と出す", () => Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const dir = sessionWithRecording(root);
      withFfmpeg(root, undefined);
      const { result, stdout } = yield* runCommand(statsCommand, [dir]);
      expect(result._tag).toBe("Success");
      expect(stdout).toContain("録音 1 本・読めない");
    }).pipe(Effect.scoped));
  });

  it.effect("パスが無ければ MissingSessionDir（パス入り）で失敗し、先に渡した正しいセッションの行も出さない", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const ok = join(root, "ok");
    mkdirSync(ok);
    writeFileSync(join(ok, "log.jsonl"), logText);
    const missing = join(root, "missing");
    const { result, stdout } = yield* runCommand(statsCommand, [ok, missing, "--no-audio"]);
    const failure = taggedFailure(result);
    expect(failure?._tag).toBe("MissingSessionDir");
    expect(failure?.path).toBe(missing);
    expect(String(failure?.reason)).not.toBe("");
    expect(stdout).toBe("");
  }).pipe(Effect.scoped));

  it.effect("位置引数が無ければ CliError（タグ付きの失敗ではない）", () => Effect.gen(function* () {
    const { result } = yield* runCommand(statsCommand, ["--no-audio"]);
    expect(result._tag).toBe("Failure");
    expect(taggedFailure(result)).toBeUndefined();
  }));
});
