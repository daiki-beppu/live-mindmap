// bench の sessionStats の Command が、PATH 上の ffmpeg を本物の子プロセスの spawner で起動して録音の長さと音量を読むこと。
// ffmpeg は PATH に置いた偽の実行ファイル。引数の読み取りや行の書式は benchCommand.it.test.ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, vi } from "vitest";
import { command as statsCommand } from "../bench/sessionStats.ts";
import { runCommand, temporaryDirectory } from "./benchRun.ts";
import { logText } from "./fixtures/benchCommand.ts";

describe("sessionStats の Command", () => {
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
});
