import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

export const root = join(import.meta.dirname, "../../..");
export const workflow = readFileSync(join(root, ".github/workflows/check.yml"), "utf8");

export const indentOf = (line: string): number => line.length - line.trimStart().length;

export const jobLines = (job: string): string[] => {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() !== "" && indentOf(l) <= 2);
  return end === -1 ? rest : rest.slice(0, end);
};

export const runScriptOf = (job: string): string => {
  const lines = jobLines(job);
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  expect(at).toBeGreaterThanOrEqual(0);
  const base = indentOf(lines[at]!);
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && indentOf(l) <= base) break;
    body.push(l);
  }
  const strip = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
  return body.map((l) => l.slice(strip)).join("\n");
};
