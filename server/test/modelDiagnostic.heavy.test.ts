import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-model-diagnostic-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

const runProcess = (root: string, argv: string[]) => Effect.tryPromise(() =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "LIVE_MINDMAP_MODEL"));
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...argv], {
      encoding: "utf8", timeout: 10_000,
      env: { ...env, HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_PORT: "0", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) return reject(error);
      resolve({ code: error ? error.code as number : 0, stdout, stderr });
    });
  }),
);

describe("モデル選択のプロセス入口（Issue #663）", () => {
  it.live("未知名は理由と候補・設定パスの 2 行を潰さずに表示する", () => Effect.gen(function* () {
    const root = yield* directory;
    yield* Effect.tryPromise(() => writeFile(join(root, "config.json"), JSON.stringify({ models: { fast: { route: "claude", model: "claude-haiku-5-5" } } })));
    const result = yield* runProcess(root, ["start", "--app", "us.zoom.xos", "--model", "missing"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("missing");
    expect(lines[0]).toContain("設定にありません");
    for (const name of ["claude", "apple", "fast"]) expect(lines[1]).toContain(name);
    expect(lines[1]).toContain(join(root, "config.json"));
    expect(existsSync(join(root, "sessions"))).toBe(false);
  }).pipe(Effect.scoped));
});
