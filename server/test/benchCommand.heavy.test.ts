// bench の sessionStats・speechEnds の Command が、PATH 上の ffmpeg を本物の子プロセスの spawner で起動して録音を読むこと。
// ffmpeg は PATH に置いた偽の実行ファイル。引数の読み取りや行の書式は benchCommand.it.test.ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, vi } from "vitest";
import { command as statsCommand } from "../bench/sessionStats.ts";
import { command as speechEndsCommand } from "../bench/speechEnds.ts";
import { runCommand, taggedFailure, temporaryDirectory } from "./benchRun.ts";
import { logText } from "./fixtures/benchCommand.ts";

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

// 偽の ffmpeg が受け取った引数（1 行 1 引数）を root/args に残す前置き
const recordArgs = (root: string) => `printf '%s\\n' "$@" > '${join(root, "args")}'`;
const recordedArgs = (root: string) => readFileSync(join(root, "args"), "utf8").trim().split("\n");

describe("speechEnds の Command", () => {
  afterEach(() => vi.unstubAllEnvs());

  const silences = 'echo "  Duration: 00:00:10.00, start: 0.0" >&2; echo "[silencedetect] silence_start: 2.0" >&2; echo "[silencedetect] silence_end: 3.0" >&2';
  const recording = (root: string) => {
    const audio = join(root, "audio.m4a");
    writeFileSync(audio, "");
    return audio;
  };

  it.effect("ffmpeg が stderr に出した無音区間から、話し終わりの行を標準出力に出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const audio = recording(root);
    withFfmpeg(root, `${recordArgs(root)}; ${silences}`);
    const { result, stdout } = yield* runCommand(speechEndsCommand, [audio, "--noise", "-40", "--min-silence", "1.5"]);
    expect(result._tag).toBe("Success");
    expect(stdout).toBe('[{"start":0,"end":2},{"start":3,"end":10}]\n');
    expect(recordedArgs(root)).toEqual(["-nostats", "-i", audio, "-af", "silencedetect=noise=-40dB:d=1.5", "-f", "null", "-"]);
  }).pipe(Effect.scoped));

  it.effect("ffmpeg が 0 以外の終了コードで終わったら、出力があっても録音を指す失敗にする", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const audio = recording(root);
    withFfmpeg(root, `${silences}; exit 1`);
    const { result, stdout } = yield* runCommand(speechEndsCommand, [audio]);
    expect(taggedFailure(result)).toMatchObject({ _tag: "InvalidInputFile", path: audio });
    expect(stdout).toBe("");
  }).pipe(Effect.scoped));

  it.effect("ffmpeg が見つからなければ、ffmpeg を指す失敗にする", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const audio = recording(root);
    withFfmpeg(root, undefined);
    const { result } = yield* runCommand(speechEndsCommand, [audio]);
    expect(taggedFailure(result)).toMatchObject({ _tag: "InvalidInputFile", path: "ffmpeg" });
  }).pipe(Effect.scoped));
});

describe("sessionStats の Command", () => {
  describe("録音の読み取り（PATH 上の ffmpeg）", () => {
    afterEach(() => vi.unstubAllEnvs());

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
      withFfmpeg(root, `${recordArgs(root)}; ${report}`);
      const { stdout } = yield* runCommand(statsCommand, [dir]);
      expect(recordedArgs(root)).toEqual(["-nostats", "-i", join(dir, "相手.m4a"), "-af", "volumedetect", "-f", "null", "-"]);
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
});
