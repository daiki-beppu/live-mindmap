import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WebSocket } from "ws";
import { DEFAULT_HELPER_PATH } from "../src/helperPath.ts";
import { serverPidPath } from "../src/serverProcess.ts";

const main = join(import.meta.dirname, "../src/server.ts");
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
  const started = listening.then((value) => ({ port: value }), (error: unknown) => ({ error }));
  return { child, exited, started, output, sessionsDir };
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

  it.live("cli server stop で止まり、終了コード 0 で終わり、PID の記録を消す", () =>
    Effect.gen(function* () {
      const p = yield* processResource(0);
      const started = yield* Effect.tryPromise(() => p.started);
      if ("error" in started) throw started.error;
      const record = serverPidPath(p.sessionsDir, started.port);
      expect(existsSync(record)).toBe(true);
      const stopped = yield* Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "server", "stop"], {
          timeout: TIMEOUT,
          env: { ...process.env, LIVE_MINDMAP_PORT: String(started.port), LIVE_MINDMAP_SESSIONS: p.sessionsDir, NO_COLOR: "1" },
        }, (error, stdout, stderr) => {
          if (error && (error.killed || typeof error.code !== "number")) return reject(error);
          resolve({ code: error ? error.code as number : 0, stdout, stderr });
        });
      }));
      expect(stopped).toEqual({ code: 0, stdout: `サーバーを止めました（ポート ${started.port}、pid ${p.child.pid}）\n`, stderr: "" });
      const exit = yield* Effect.tryPromise(() => p.exited);
      expect(exit).toEqual({ code: 0, signal: null });
      expect(existsSync(record)).toBe(false);
    }), TIMEOUT);

  it.live("待受けに失敗したプロセスは終了し、先に起動していたサーバーは応答を続ける", () =>
    Effect.gen(function* () {
      const first = yield* processResource(0);
      const started = yield* Effect.tryPromise(() => first.started);
      if ("error" in started) throw started.error;
      const second = yield* processResource(started.port);
      const exit = yield* Effect.tryPromise(() => second.exited);
      expect(exit.signal).toBeNull();
      expect(exit.code).not.toBe(0);
      expect(second.output.stdout.trim()).not.toBe("");
      expect(second.output.stderr.trim()).toBe("");
      const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${started.port}/session/status`));
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "none" });
    }), TIMEOUT);

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

  it.live('LIVE_MINDMAP_PORT が整数でない（""）と、待ち受けずに 0 以外で終わり、理由を標準エラーに出す', () =>
    Effect.gen(function* () {
      const p = yield* processResource("");
      const exit = yield* Effect.tryPromise(() => p.exited);
      const started = yield* Effect.tryPromise(() => p.started);
      expect(exit.signal).toBeNull();
      expect(exit.code).not.toBe(0);
      expect("error" in started).toBe(true);
      const message = "error" in started ? String((started.error as { message?: unknown }).message ?? started.error) : "";
      expect(message.replace("待受け前に終了:", "").trim()).not.toBe("");
    }), TIMEOUT);
});
