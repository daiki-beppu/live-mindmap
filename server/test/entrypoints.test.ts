import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #237・#236: NodeRuntime.runMain（SIGINT・SIGTERM でルートのファイバーを中断する）と runPromise は
// 入口（server.ts・cli.ts・bench の各スクリプト）でだけ呼ぶ。それ以外のモジュールは Effect のまま返し、
// 古いコードから runPromise で新しいコードを呼ぶ形を取らない。ソースを読んで呼び出しの場所を確かめる
const root = join(import.meta.dirname, "..");
const BENCH_SCRIPTS = ["bench/sessionStats.ts", "bench/sttAccuracy.ts", "bench/sttLatency.ts", "bench/sttReplay.ts"];
const RUN_MAIN_ALLOWED = ["src/server.ts", "src/cli.ts", ...BENCH_SCRIPTS];
// server.ts は startServer（テストと CLI の疎通が使う Promise の入口）と、main で Service を Promise の口に変える所で使う
const RUN_PROMISE_ALLOWED = ["src/server.ts"];

const sources = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));

// コメント行は除いて、呼び出しを持つファイルを集める
const filesCalling = (pattern: RegExp): string[] =>
  [...sources("src"), ...sources("bench")]
    .filter((file) =>
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .some((line) => !line.trimStart().startsWith("//") && pattern.test(line)),
    )
    .sort();

describe("runMain・runPromise は入口にだけある", () => {
  it("NodeRuntime.runMain を呼ぶのは server.ts・cli.ts・bench の各スクリプトだけで、どの入口も呼んでいる", () => {
    expect(filesCalling(/\.runMain\s*\(/)).toEqual([...RUN_MAIN_ALLOWED].sort());
  });

  it("Effect.runPromise（runPromiseExit を含む）を呼ぶのは server.ts だけ", () => {
    expect(filesCalling(/\.runPromise(Exit)?\s*\(/)).toEqual(RUN_PROMISE_ALLOWED);
  });
});
