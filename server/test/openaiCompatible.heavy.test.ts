import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

// サーバーと同じプロセスで動くケース（start の HTTP 拒否・モデルの保持）は openaiCompatible.it.test.ts の runCli が持つ。
// ここに残すのは、サーバーを使わずにプロセスの stderr・exit code だけで確かめられる 1 件
const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-compatible-process-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);
const runProcess = (root: string, port: number, argv: string[]) => Effect.tryPromise(() =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["LIVE_MINDMAP_MODEL", "SYNTHETIC_PROCESS_KEY"].includes(name)));
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...argv], {
      encoding: "utf8", timeout: 10_000,
      env: { ...env, HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_JUDGE: "off", LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_PORT: String(port), NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) return reject(error);
      resolve({ code: error ? error.code as number : 0, stdout, stderr });
    });
  }),
);

describe("互換モデルと拒否表示の CLI プロセス入口", () => {
  it.live("play のキー未設定は理由・次の操作を stderr の2行に表示し exit 1", () => Effect.gen(function* () {
    const root = yield* directory;
    writeFileSync(join(root, "config.json"), JSON.stringify({ models: { compatible: { route: "openai-compatible", model: "synthetic-model", url: "http://127.0.0.1:1/v1", apiKeyEnv: "SYNTHETIC_PROCESS_KEY" } } }));
    const result = yield* runProcess(root, 0, ["play", join(import.meta.dirname, "fixtures/short.transcript.json"), "--model", "compatible"]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "compatible の API キーがありません: 環境変数 SYNTHETIC_PROCESS_KEY が空です\n環境変数を設定してから開始してください\n" });
  }));
});
