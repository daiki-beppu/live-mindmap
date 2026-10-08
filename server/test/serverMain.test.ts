import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WebSocket } from "ws";
import { DEFAULT_HELPER_PATH } from "../src/helperPath.ts";

const main = join(import.meta.dirname, "../src/server.ts");
// main を実物の子プロセスとして起動するので、1 件ごとに Node の起動と TypeScript の変換が入る。
// vitest は test ファイルを並列に走らせる（CI の server (rest) は他の 18 ファイルと同時）ため、
// 既定の 20 秒では混み合ったときに足りない。capture.test.ts が実物の Vite・Chromium に 90 秒を取るのと同じ理由
const TIMEOUT = 60_000;
const processResource = Effect.fnUntraced(function* (
  port: number | string,
  options: { readonly env?: Readonly<Record<string, string>>; readonly execArgv?: readonly string[] } = {},
) {
  const sessionsDir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-main-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
  const child = yield* Effect.acquireRelease(
    Effect.sync(() => spawn(process.execPath, [...(options.execArgv ?? []), main], {
      // セッションを始めないのでヘルパーは起動しない。既定の release の実行ファイルの有無で落ちないよう、使われない値を渡す
      env: { ...process.env, LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_HELPER: "/nonexistent/live-mindmap-helper", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    })),
    (p) => Effect.promise(() => new Promise<void>((resolve) => {
      if (p.exitCode !== null || p.signalCode !== null) return resolve();
      p.once("close", () => resolve());
      p.kill("SIGKILL");
    })),
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  // 出力先を観測するため、標準出力と標準エラーを最後まで溜める（exited は close で解決するので、解決後は全部読み終わっている）
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    output.stdout += chunk.toString();
  });
  const listening = new Promise<number>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      output.stderr += chunk.toString();
      stderr += chunk.toString();
      const match = stderr.match(/live-mindmap サーバーを起動しました: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once("close", () => reject(new Error(`待受け前に終了: ${stderr}`)));
    child.once("error", reject);
  });
  // 起動失敗のケースでは exited を観測する。listening の拒否を未処理にしない。
  const started = listening.then((value) => ({ port: value }), (error: unknown) => ({ error }));
  return { child, exited, started, output };
});

describe("server main の終了（要件6・7）", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it.live(`${signal}で同じプロセスの接続とlistenerを解放して終了する`, () =>
      Effect.gen(function* () {
        const p = yield* processResource(0);
        const started = yield* Effect.tryPromise(() => p.started);
        if ("error" in started) throw started.error;
        const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${started.port}/session/status`));
        expect(response.status).toBe(200);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "none" });
        const ws = yield* Effect.acquireRelease(
          Effect.sync(() => new WebSocket(`ws://127.0.0.1:${started.port}/ws`)),
          (s) => Effect.sync(() => s.terminate()),
        );
        const closed = new Promise<void>((resolve) => ws.once("close", resolve));
        yield* Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        }));
        yield* Effect.sync(() => p.child.kill(signal));
        const exit = yield* Effect.tryPromise(() => p.exited);
        yield* Effect.tryPromise(() => closed);
        expect(exit.signal).toBeNull();
        expect(exit.code).toBe(0);
        yield* Effect.tryPromise(() => expect(fetch(`http://127.0.0.1:${started.port}/session/status`)).rejects.toThrow());
      }), TIMEOUT);
  }

  it.live("待受けに失敗したプロセスは終了し、先に起動していたサーバーは応答を続ける", () =>
    Effect.gen(function* () {
      const first = yield* processResource(0);
      const started = yield* Effect.tryPromise(() => first.started);
      if ("error" in started) throw started.error;
      const second = yield* processResource(started.port);
      const exit = yield* Effect.tryPromise(() => second.exited);
      expect(exit.signal).toBeNull();
      expect(exit.code).not.toBe(0);
      // 待受けの失敗の理由は、Effect の既定のロガー（標準出力）に出る。標準エラーへ切り替えない（文言は固定しない）
      expect(second.output.stdout.trim()).not.toBe("");
      expect(second.output.stderr.trim()).toBe("");
      const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${started.port}/session/status`));
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "none" });
    }), TIMEOUT);

  // ヘルパーが見つからないときの終了。helper のビルドの有無に左右されないよう、preload で既定の場所の existsSync だけを false にする
  it.live("ヘルパーが見つからないと、理由を標準エラーに出し、待ち受けずに終了コード 1 で自分で終わる", () =>
    Effect.gen(function* () {
      const preloadDir = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-preload-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      );
      const preload = join(preloadDir, "hideDefaultHelper.mjs");
      yield* Effect.tryPromise(() => writeFile(preload, [
        `import fs from "node:fs";`,
        `import { syncBuiltinESMExports } from "node:module";`,
        `const hidden = ${JSON.stringify(DEFAULT_HELPER_PATH)};`,
        `const original = fs.existsSync;`,
        `fs.existsSync = (path, ...rest) => (path === hidden ? false : original(path, ...rest));`,
        `syncBuiltinESMExports();`,
        ``,
      ].join("\n")));
      const p = yield* processResource(0, {
        env: { LIVE_MINDMAP_HELPER: "" },
        execArgv: ["--import", pathToFileURL(preload).href],
      });
      const exit = yield* Effect.tryPromise(() => p.exited);
      const started = yield* Effect.tryPromise(() => p.started);
      expect(started).toHaveProperty("error");
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(1);
      expect(p.output.stderr).toContain(DEFAULT_HELPER_PATH);
      expect(p.output.stderr).not.toContain("live-mindmap サーバーを起動しました");
    }), TIMEOUT);

  // 空文字は「未設定」ではなく整数でない値として拒否する（未設定なら既定のポートを使う）
  for (const value of ["abc", ""]) {
    it.live(`LIVE_MINDMAP_PORT が整数でない（${JSON.stringify(value)}）と、待ち受けずに 0 以外で終わり、理由を標準エラーに出す`, () =>
      Effect.gen(function* () {
        const p = yield* processResource(value);
        const exit = yield* Effect.tryPromise(() => p.exited);
        const started = yield* Effect.tryPromise(() => p.started);
        expect(exit.signal).toBeNull();
        expect(exit.code).not.toBe(0);
        // 起動の 1 行が出ていない（error 側）。error の文言は「待受け前に終了: <標準エラー>」なので、理由が空でないことを見る
        expect("error" in started).toBe(true);
        const message = "error" in started ? String((started.error as { message?: unknown }).message ?? started.error) : "";
        expect(message.replace("待受け前に終了:", "").trim()).not.toBe("");
      }), TIMEOUT);
  }
});
