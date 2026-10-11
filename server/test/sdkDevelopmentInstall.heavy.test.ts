import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { temporaryDeps } from "./fixtures/managedDeps.ts";

describe("開発依存の SDK 導入", () => {
  it.live("クリーンな pnpm install は SDK 型を使え、プラットフォーム別バイナリを導入しない", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const source = join(import.meta.dirname, "../..");
    yield* Effect.tryPromise(async () => {
      for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) await copyFile(join(source, file), join(root, file));
      for (const project of ["server", "web", "helper", "e2e"]) {
        await mkdir(join(root, project));
        await copyFile(join(source, project, "package.json"), join(root, project, "package.json"));
      }
      await writeFile(join(root, "server/type-probe.ts"), 'import type { Query } from "@anthropic-ai/claude-agent-sdk";\nexport type ManagedQuery = Query;\n');
    });
    const run = (args: string[]) => Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
      execFile("pnpm", args, { cwd: root, timeout: 150_000, env: { ...process.env, NO_COLOR: "1" } },
        (error, stdout, stderr) => error ? reject(new Error(stdout + stderr, { cause: error })) : resolve());
    }));
    yield* run(["install", "--frozen-lockfile", "--ignore-scripts"]);
    // コピー先には typecheck 対象の本番ソースがないので、同じコンパイラで型の利用だけを確かめる。
    yield* run(["--filter", "@live-mindmap/server", "exec", "tsc", "--noEmit", "--skipLibCheck", "--module", "nodenext", "--target", "es2024", "type-probe.ts"]);
    const packages = yield* Effect.tryPromise(() => readdir(join(root, "node_modules/.pnpm")));
    expect(packages.filter((name) => name.startsWith("@anthropic-ai+claude-agent-sdk-"))).toEqual([]);
  }).pipe(Effect.scoped), 180_000);
});
