import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// check-entrypoints と check-test-layers が共有する、ソースを読んで違反を出す部分。違うのは対象の拡張子だけ。
export type SourceFile = { path: string; content: string };
type ReportedViolation = { path: string; line?: number; message: string };

export const readSources = (root: string, dir: string, extensions: readonly string[]): SourceFile[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => extensions.some((extension) => f.endsWith(extension)))
    .map((f) => {
      const path = join(dir, f);
      return { path, content: readFileSync(join(root, path), "utf8") };
    });

export const reportViolations = (violations: ReadonlyArray<ReportedViolation>): void => {
  for (const v of violations) {
    console.error(`${v.path}${v.line === undefined ? "" : `:${v.line}`}: ${v.message}`);
  }
  if (violations.length > 0) process.exitCode = 1;
};
