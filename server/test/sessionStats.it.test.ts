import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { sessionDirs } from "../bench/sessionStats.ts";

describe("セッションの数だけの集計", () => {
  it("並べたフォルダを渡すと、log.jsonl のあるセッションを全部拾う", () => {
    const root = mkdtempSync(join(tmpdir(), "stats-"));
    for (const name of ["b", "a"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "log.jsonl"), "");
    }
    mkdirSync(join(root, "empty"));
    expect(sessionDirs(root)).toEqual([join(root, "a"), join(root, "b")]);
    expect(sessionDirs(join(root, "a"))).toEqual([join(root, "a")]);
  });
});
