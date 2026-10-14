import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

// 素の Node プロセスで確かめる（vitest の中では CJS の default が名前つき export として補われ、不具合が隠れる）。
describe("管理ディレクトリの Chromium の読み込み（Issue #968）", () => {
  it.live("ManagedDeps.load(\"chromium\") の chromium で launch → close まで通る", () => Effect.gen(function* () {
    const stdout = yield* Effect.tryPromise(() => new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [join(import.meta.dirname, "fixtures/managedChromiumLaunch.ts")], {
        encoding: "utf8", timeout: 90_000, env: { ...process.env, NO_COLOR: "1" },
      }, (error, out, err) => error ? reject(new Error(out + err, { cause: error })) : resolve(out));
    }));
    const result = JSON.parse(stdout) as { version: unknown };
    expect(result.version).toBeTypeOf("string");
    expect(result.version).not.toBe("");
  }), 120_000);
});
