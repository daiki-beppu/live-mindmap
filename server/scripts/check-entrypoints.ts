import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #237・#236: NodeRuntime.runMain（SIGINT・SIGTERM でルートのファイバーを中断する）と runPromise は
// 入口（server.ts・cli.ts・bench の各スクリプト）でだけ呼ぶ。それ以外のモジュールは Effect のまま返し、
// 古いコードから runPromise で新しいコードを呼ぶ形を取らない。runPromise は src・bench のどこにも無い
// （Issue #436: server.ts の終了時の書き出しと startServer* の Promise の口を消した）。
// runSync は web の同期の入口から呼ぶ境界（core/review.ts の reviewSnapshot）だけに残す。ソースを読んで呼び出しの場所を確かめる
export type SourceFile = { path: string; content: string };
export type Violation = { path: string; line?: number; message: string };

const BENCH_SCRIPTS = ["bench/sessionStats.ts", "bench/sttAccuracy.ts", "bench/sttLatency.ts", "bench/sttReplay.ts"];
const RUN_MAIN_ALLOWED = ["src/server.ts", "src/cli.ts", ...BENCH_SCRIPTS];
const RUN_PROMISE_ALLOWED: string[] = [];
// reviewSnapshot（web/src/reviewTimeline.ts から同期で呼ぶ。R = never・非同期なしなので必ず同期で終わる）
const RUN_SYNC_ALLOWED = ["src/core/review.ts"];

const RUN_MAIN = /\.runMain\s*\(/;
const RUN_PROMISE = /\.runPromise(Exit)?\s*\(/;
const RUN_SYNC = /\.runSync(Exit)?\s*\(/;
const PROCESS_EXIT = /process\.exit\s*\(/;
const ON_EXIT = /\bonExit\s*\(/;
const RUN_MAIN_EXIT_NATURALLY = /\.runMain\s*\(\s*\{[^}]*\bteardown:\s*exitNaturally\b[^}]*\}\s*\)/;

const matchingLines = (content: string, pattern: RegExp): number[] =>
  content
    .split("\n")
    .flatMap((text, index) => (!text.trimStart().startsWith("//") && pattern.test(text) ? [index + 1] : []));

// コメント行を除いた本文全体に当てる（`process.exit\n(1)` のような改行をまたぐ呼び出しも拾う）。行番号は元の行番号で返す
const matchingLinesInCode = (content: string, pattern: RegExp): number[] => {
  const kept = content
    .split("\n")
    .flatMap((text, index) => (text.trimStart().startsWith("//") ? [] : [{ text, line: index + 1 }]));
  const code = kept.map((k) => k.text).join("\n");
  const starts = kept.map((_, i) => kept.slice(0, i).reduce((n, k) => n + k.text.length + 1, 0));
  const global = new RegExp(pattern.source, "g");
  return [...code.matchAll(global)].map((m) => {
    const idx = starts.findLastIndex((start) => start <= m.index);
    return kept[idx]?.line ?? 1;
  });
};

const codeOf = (content: string): string =>
  content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

export const findEntrypointViolations = (files: ReadonlyArray<SourceFile>): Violation[] => {
  const violations: Violation[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  // Issue #237・#236: 呼び出しの場所の集合が許可リストとちょうど一致する
  const checkCallers = (pattern: RegExp, allowed: readonly string[], label: string) => {
    for (const { path, content } of files) {
      if (allowed.includes(path)) continue;
      for (const line of matchingLines(content, pattern)) {
        violations.push({ path, line, message: `${label} を呼べるのは ${allowed.join("・") || "どこにも無い"} だけ` });
      }
    }
    for (const path of allowed) {
      if (matchingLines(byPath.get(path) ?? "", pattern).length === 0) {
        violations.push({ path, message: `${label} を呼んでいない` });
      }
    }
  };
  checkCallers(RUN_MAIN, RUN_MAIN_ALLOWED, "NodeRuntime.runMain");
  checkCallers(RUN_SYNC, RUN_SYNC_ALLOWED, "Effect.runSync（runSyncExit を含む）");
  for (const { path, content } of files) {
    if (RUN_PROMISE_ALLOWED.includes(path)) continue;
    for (const line of matchingLines(content, RUN_PROMISE)) {
      violations.push({ path, line, message: "Effect.runPromise（runPromiseExit を含む）は呼ばない" });
    }
  }

  // Issue #449: サーバーの入口は process.exit も、既定で process.exit を呼ぶ teardown の onExit も呼ばない
  const server = byPath.get("src/server.ts");
  if (server !== undefined) {
    for (const line of matchingLinesInCode(server, PROCESS_EXIT)) {
      violations.push({ path: "src/server.ts", line, message: "process.exit を呼ばない" });
    }
    for (const line of matchingLinesInCode(server, ON_EXIT)) {
      violations.push({ path: "src/server.ts", line, message: "teardown の onExit を呼ばない" });
    }
  }

  // Issue #561: bench の各入口も process.exit を呼ばず、exitNaturally で自然に終わる
  for (const path of BENCH_SCRIPTS) {
    const content = byPath.get(path);
    if (content === undefined) continue;
    for (const line of matchingLinesInCode(content, PROCESS_EXIT)) {
      violations.push({ path, line, message: "process.exit を呼ばない" });
    }
    if (!RUN_MAIN_EXIT_NATURALLY.test(codeOf(content))) {
      violations.push({ path, message: "runMain に teardown: exitNaturally を渡す" });
    }
  }

  return violations;
};

const sources = (root: string, dir: string): SourceFile[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => {
      const path = join(dir, f);
      return { path, content: readFileSync(join(root, path), "utf8") };
    });

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const violations = findEntrypointViolations([...sources(root, "src"), ...sources(root, "bench")]);
  for (const v of violations) {
    console.error(`${v.path}${v.line === undefined ? "" : `:${v.line}`}: ${v.message}`);
  }
  if (violations.length > 0) process.exitCode = 1;
}
