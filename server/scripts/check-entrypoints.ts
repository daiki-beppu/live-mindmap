import { join } from "node:path";
import { readSources, reportViolations, type SourceFile } from "./sourceFiles.ts";

export type Violation = { path: string; line?: number; message: string };

const BENCH_TEARDOWNS = {
  "bench/sessionStats.ts": "exitNaturally",
  "bench/mapShape.ts": "exitNaturally",
  "bench/sttAccuracy.ts": "exitNaturally",
  "bench/sttLatency.ts": "exitNaturally",
  "bench/sttReplay.ts": "exitNaturallyForManagedDeps",
  "bench/speechEnds.ts": "exitNaturally",
  "bench/edgeJudge.ts": "exitNaturally",
  "bench/siblingJudge.ts": "exitNaturally",
  "bench/supplementJudge.ts": "exitNaturally",
  "bench/speakerReplay.ts": "exitNaturally",
  "bench/speakerAccuracy.ts": "exitNaturally",
  "bench/timelineReplay.ts": "exitNaturally",
  "bench/peopleAccuracy.ts": "exitNaturally",
} as const satisfies Record<string, "exitNaturally" | "exitNaturallyForManagedDeps">;
const BENCH_SCRIPTS = Object.keys(BENCH_TEARDOWNS);
const RUN_MAIN_ALLOWED = ["src/server.ts", "src/cli.ts", ...BENCH_SCRIPTS];
const RUN_SYNC_ALLOWED = ["src/core/review.ts"];

const RUN_MAIN = /\.runMain\s*\(/;
const RUN_PROMISE = /\.runPromise(Exit)?\s*\(/;
const RUN_SYNC = /\.runSync(Exit)?\s*\(/;
const PROCESS_EXIT = /process\.exit\s*\(/;
const ON_EXIT = /\bonExit\s*\(/;
const runMainWithTeardown = (name: string) => new RegExp(String.raw`\.runMain\s*\(\s*\{[^}]*\bteardown:\s*${name}\b[^}]*\}\s*\)`);

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
  for (const [path, teardown] of Object.entries(BENCH_TEARDOWNS)) {
    const content = byPath.get(path);
    if (content === undefined) continue;
    for (const line of matchingLinesInCode(content, PROCESS_EXIT)) {
      violations.push({ path, line, message: "process.exit を呼ばない" });
    }
    if (!runMainWithTeardown(teardown).test(codeOf(content))) {
      violations.push({ path, message: `runMain に teardown: ${teardown} を渡す` });
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
