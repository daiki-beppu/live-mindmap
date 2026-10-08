import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #237・#236: NodeRuntime.runMain（SIGINT・SIGTERM でルートのファイバーを中断する）と runPromise は
// 入口（server.ts・cli.ts・bench の各スクリプト）でだけ呼ぶ。それ以外のモジュールは Effect のまま返し、
// 古いコードから runPromise で新しいコードを呼ぶ形を取らない。runPromise は src・bench のどこにも無い
// （Issue #436: server.ts の終了時の書き出しと startServer* の Promise の口を消した）。
// runSync は web の同期の入口から呼ぶ境界（core/review.ts の reviewSnapshot）だけに残す。ソースを読んで呼び出しの場所を確かめる
const root = join(import.meta.dirname, "..");
const BENCH_SCRIPTS = ["bench/sessionStats.ts", "bench/sttAccuracy.ts", "bench/sttLatency.ts", "bench/sttReplay.ts"];
const RUN_MAIN_ALLOWED = ["src/server.ts", "src/cli.ts", ...BENCH_SCRIPTS];
const RUN_PROMISE_ALLOWED: string[] = [];
// reviewSnapshot（web/src/reviewTimeline.ts から同期で呼ぶ。R = never・非同期なしなので必ず同期で終わる）
const RUN_SYNC_ALLOWED = ["src/core/review.ts"];

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

describe("runMain・runPromise・runSync は入口にだけある", () => {
  it("NodeRuntime.runMain を呼ぶのは server.ts・cli.ts・bench の各スクリプトだけで、どの入口も呼んでいる", () => {
    expect(filesCalling(/\.runMain\s*\(/)).toEqual([...RUN_MAIN_ALLOWED].sort());
  });

  it("Effect.runPromise（runPromiseExit を含む）は src・bench のどこにも無い", () => {
    expect(filesCalling(/\.runPromise(Exit)?\s*\(/)).toEqual(RUN_PROMISE_ALLOWED);
  });

  it("Effect.runSync（runSyncExit を含む）を呼ぶのは core/review.ts の reviewSnapshot だけ", () => {
    expect(filesCalling(/\.runSync(Exit)?\s*\(/)).toEqual(RUN_SYNC_ALLOWED);
  });
});

// Issue #449: サーバーの入口は process.exit を直接呼ばない（teardown の既定の onExit 経由も含む）。
// 終了コードは process.exitCode に入れ、イベントループが空になって自然に終わる（SIGINT・SIGTERM の 0 は serverMain.test.ts が実プロセスで確かめる）
describe("server.ts の入口は process.exit を呼ばない", () => {
  const code = readFileSync(join(root, "src/server.ts"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  it("process.exit を呼ばない", () => {
    expect(code).not.toMatch(/process\.exit\s*\(/);
  });

  it("teardown の onExit（既定は process.exit を呼ぶ）を呼ばない", () => {
    expect(code).not.toMatch(/\bonExit\s*\(/);
  });
});

// Issue #561: bench の各入口も cli・server と同じく、失敗で process.exit を呼ばず exitNaturally で自然に終わる。
// 終了コードは process.exitCode に入れる（既定の teardown は失敗で process.exit(1) を呼ぶ）
describe.each(BENCH_SCRIPTS)("%s の入口は process.exit を呼ばず exitNaturally で終わる", (file) => {
  const code = readFileSync(join(root, file), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  it("process.exit を呼ばない", () => {
    expect(code).not.toMatch(/process\.exit\s*\(/);
  });

  it("runMain に teardown: exitNaturally を渡している", () => {
    expect(code).toMatch(/\.runMain\s*\(\s*\{[^}]*\bteardown:\s*exitNaturally\b[^}]*\}\s*\)/);
  });
});
