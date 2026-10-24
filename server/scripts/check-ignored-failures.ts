import { join } from "node:path";
import { readSources, reportViolations, type SourceFile } from "./sourceFiles.ts";

export type Violation = { path: string; line: number; message: string };

const BARE_IGNORE = /Effect\.ignore\b(?!\s*\(\s*\{[^}]*\bmessage\s*:)/g;

const MESSAGE =
  "Effect.ignore で失敗を黙って捨てない。呼び元に返すか、諦めるなら Effect.ignore({ log: \"Debug\", message: \"<何を諦めたか>\" }) と書く。HTTP の応答の失敗（409 など）を捨てない。後片付けは中断でも走る Effect.ensuring・Effect.onExit・Effect.acquireRelease で書く";

export const findIgnoredFailures = (files: ReadonlyArray<SourceFile>): Violation[] =>
  files.flatMap(({ path, content }) => {
    const code = content
      .split("\n")
      .map((line) => (line.trimStart().startsWith("//") ? "" : line))
      .join("\n");
    return [...code.matchAll(BARE_IGNORE)].map((m) => ({ path, line: code.slice(0, m.index).split("\n").length, message: MESSAGE }));
  });

if (import.meta.main) {
  const root = join(import.meta.dirname, "../..");
  const isTest = (f: SourceFile) => /\.test\.tsx?$/.test(f.path);
  reportViolations(
    findIgnoredFailures(
      [...readSources(root, "server/src", [".ts"]), ...readSources(root, "server/bench", [".ts"]), ...readSources(root, "web/src", [".ts", ".tsx"])].filter((f) => !isTest(f)),
    ),
  );
}
