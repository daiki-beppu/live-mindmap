import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSources } from "../scripts/sourceFiles.ts";

describe("readSources", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sourceFiles-"));
    mkdirSync(join(root, "d", "sub"), { recursive: true });
    writeFileSync(join(root, "d", "a.ts"), "A");
    writeFileSync(join(root, "d", "b.tsx"), "B");
    writeFileSync(join(root, "d", "c.md"), "C");
    writeFileSync(join(root, "d", "sub", "e.ts"), "E");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const paths = (files: ReadonlyArray<{ path: string }>) => files.map((f) => f.path).sort();

  it(".ts だけを指定すると、サブフォルダまで含めて .ts だけを root からの相対パスと中身つきで返す", () => {
    const files = readSources(root, "d", [".ts"]);
    expect(paths(files)).toEqual([join("d", "a.ts"), join("d", "sub", "e.ts")]);
    expect(files.find((f) => f.path === join("d", "a.ts"))?.content).toBe("A");
  });

  it(".ts と .tsx を指定すると両方を返し、ほかの拡張子は返さない", () => {
    expect(paths(readSources(root, "d", [".ts", ".tsx"]))).toEqual([join("d", "a.ts"), join("d", "b.tsx"), join("d", "sub", "e.ts")]);
  });
});
