import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WebSocket } from "ws";

const main = join(import.meta.dirname, "../src/server.ts");
// main を実物の子プロセスとして起動するので、1 件ごとに Node の起動と TypeScript の変換が入る。
// vitest は test ファイルを並列に走らせる（CI の server (rest) は他の 18 ファイルと同時）ため、
// 既定の 20 秒では混み合ったときに足りない。capture.test.ts が実物の Vite・Chromium に 90 秒を取るのと同じ理由
const TIMEOUT = 60_000;
const processResource = Effect.fnUntraced(function* (port: number) {
  const sessionsDir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-main-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
  const child = yield* Effect.acquireRelease(
    Effect.sync(() => spawn(process.execPath, [main], {
      env: { ...process.env, LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_SESSIONS: sessionsDir },
      stdio: ["ignore", "ignore", "pipe"],
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
  const listening = new Promise<number>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/live-mindmap サーバーを起動しました: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once("close", () => reject(new Error(`待受け前に終了: ${stderr}`)));
    child.once("error", reject);
  });
  // 起動失敗のケースでは exited を観測する。listening の拒否を未処理にしない。
  const started = listening.then((value) => ({ port: value }), (error: unknown) => ({ error }));
  return { child, exited, started };
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
      const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${started.port}/session/status`));
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "none" });
    }), TIMEOUT);
});
