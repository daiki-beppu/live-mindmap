import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Result } from "effect";
import { resolveNpm } from "../src/npmCommand.ts";

const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-npm-search-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

const candidate = async (file: string, name: string) => {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `#!${process.execPath}\nconsole.log(${JSON.stringify(name)});\n`, { mode: 0o755 });
};

const run = (command: { command: string; args: ReadonlyArray<string> }) => Effect.tryPromise(() => new Promise<string>((resolve, reject) => {
  execFile(command.command, [...command.args], { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
}));

describe("npm の探索", () => {
  it.live.each([0, 1, 2, 3])("候補 %s から始まる共存状態で、後順位より先に実行可能な npm を選ぶ", (first) => Effect.gen(function* () {
    const dir = yield* directory;
    const explicit = join(dir, "explicit/npm");
    const execPath = join(dir, "bin/node");
    const adjacent = join(dir, "lib/node_modules/npm/bin/npm-cli.js");
    const linked = join(dir, "linked/npm.cjs");
    const pathNpm = join(dir, "path/npm");
    yield* Effect.tryPromise(async () => {
      await mkdir(join(dir, "bin"), { recursive: true });
      await symlink(process.execPath, execPath);
      if (first <= 0) await candidate(explicit, "explicit");
      if (first <= 1) await candidate(adjacent, "adjacent");
      if (first <= 2) { await candidate(linked, "linked"); await symlink(linked, join(dir, "bin/npm")); }
      await candidate(pathNpm, "path");
    });
    const npm = yield* resolveNpm({ explicit: first === 0 ? explicit : undefined, execPath, env: { PATH: join(dir, "path"), npm_execpath: pathNpm } }).pipe(Effect.provide(NodeServices.layer));
    expect(yield* run(npm)).toBe(["explicit", "adjacent", "linked", "path"][first]);
  }).pipe(Effect.scoped));

  it.live("npm_execpath しか存在しないときは使わず、探索場所を含む不在エラーを返す", () => Effect.gen(function* () {
    const dir = yield* directory;
    const pnpm = join(dir, "pnpm.cjs");
    yield* Effect.tryPromise(() => candidate(pnpm, "must not run pnpm"));
    const execPath = join(dir, "bin/node");
    const result = yield* Effect.result(resolveNpm({ execPath, env: { PATH: join(dir, "empty"), npm_execpath: pnpm } }).pipe(Effect.provide(NodeServices.layer)));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain("npm が見つかりません（探した場所:");
      expect(String(result.failure)).toContain(dir);
    }
  }).pipe(Effect.scoped));
});
