import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { directory, serverStop, unusedPort, writePid } from "./fixtures/serverStop.ts";

// サーバーではない、生きている子プロセス（記録の PID が使い回された状態の再現）。テストの終わりに PID を名指しで止める
const bystander = Effect.acquireRelease(
  Effect.sync(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })),
  (child) => Effect.promise(() => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  })),
);

// 本物の ServerProcess が process.kill(pid, 0) で別プロセスの生存を判定し、シグナルを送らないことを確かめる
describe("cli server stop（別プロセスの PID）", () => {
  // 2026-10-13 に pkill で関係の無いプロセスまで止めた。記録の PID が別のプロセスに使い回されていても、応答の無いポートの記録だけでは送らない
  it.live("応答が無く、記録の PID のプロセスが生きているなら、本物の ServerProcess でもシグナルを送らずに断り、記録を残す", () => Effect.gen(function* () {
    const sessionsDir = join(yield* directory, "sessions");
    const port = yield* unusedPort;
    const child = yield* bystander;
    const pid = child.pid!;
    const path = yield* writePid(sessionsDir, port, pid);
    const result = yield* serverStop(sessionsDir, port);
    expect(result.failed).toBe(true);
    expect(result.message).toContain(`記録の pid ${pid} が live-mindmap のサーバーか確かめてから`);
    // 送っていない: 少し待っても生きている
    yield* Effect.sleep(200);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(existsSync(path)).toBe(true);
  }).pipe(Effect.scoped));
});
