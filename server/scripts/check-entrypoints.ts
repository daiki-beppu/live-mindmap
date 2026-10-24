import { join } from "node:path";
import { readSources, reportViolations, type SourceFile } from "./sourceFiles.ts";

export type Violation = { path: string; line?: number; message: string };

const BENCH_SCRIPTS = ["bench/sessionStats.ts", "bench/mapShape.ts", "bench/sttAccuracy.ts", "bench/sttLatency.ts", "bench/sttReplay.ts", "bench/speechEnds.ts", "bench/edgeJudge.ts", "bench/siblingJudge.ts", "bench/speakerReplay.ts", "bench/speakerAccuracy.ts", "bench/timelineReplay.ts", "bench/peopleAccuracy.ts"];
const RUN_MAIN_ALLOWED = ["src/server.ts", "src/cli.ts", ...BENCH_SCRIPTS];
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

const checkCallers = (files: ReadonlyArray<SourceFile>, byPath: ReadonlyMap<string, string>, pattern: RegExp, allowed: readonly string[], label: string): Violation[] => {
  const violations: Violation[] = [];
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
  return violations;
};

const checkRunPromise = (files: ReadonlyArray<SourceFile>): Violation[] => {
  const violations: Violation[] = [];
  for (const { path, content } of files) {
    for (const line of matchingLines(content, RUN_PROMISE)) {
      violations.push({ path, line, message: "Effect.runPromise（runPromiseExit を含む）は呼ばない" });
    }
  }
  return violations;
};

const checkServerEntry = (server: string | undefined): Violation[] => {
  if (server === undefined) return [];
  return [
    ...matchingLinesInCode(server, PROCESS_EXIT).map((line) => ({ path: "src/server.ts", line, message: "process.exit を呼ばない" })),
    ...matchingLinesInCode(server, ON_EXIT).map((line) => ({ path: "src/server.ts", line, message: "teardown の onExit を呼ばない" })),
  ];
};

const checkBenchEntries = (byPath: ReadonlyMap<string, string>): Violation[] => {
  const violations: Violation[] = [];
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

export const findEntrypointViolations = (files: ReadonlyArray<SourceFile>): Violation[] => {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  return [
    ...checkCallers(files, byPath, RUN_MAIN, RUN_MAIN_ALLOWED, "NodeRuntime.runMain"),
    ...checkCallers(files, byPath, RUN_SYNC, RUN_SYNC_ALLOWED, "Effect.runSync（runSyncExit を含む）"),
    ...checkRunPromise(files),
    ...checkServerEntry(byPath.get("src/server.ts")),
    ...checkBenchEntries(byPath),
  ];
};

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  reportViolations(findEntrypointViolations([...readSources(root, "src", [".ts"]), ...readSources(root, "bench", [".ts"])]));
}
