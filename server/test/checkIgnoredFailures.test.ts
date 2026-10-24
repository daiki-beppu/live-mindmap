import { describe, expect, it } from "vitest";
import { findIgnoredFailures } from "../scripts/check-ignored-failures.ts";

const linesOf = (content: string) => findIgnoredFailures([{ path: "src/a.ts", content }]).map((v) => v.line);

describe("check-ignored-failures", () => {
  it("Effect.ignore を何を諦めたかを書かずに使うと、その行を指す", () => {
    expect(linesOf("const a = 1;\nx.pipe(Effect.ignore, Effect.as(done));\nconst b = x.pipe(Effect.ignore);\n")).toEqual([2, 3]);
  });

  it("message を渡した Effect.ignore は、複数行に分けても通す", () => {
    expect(linesOf('x.pipe(Effect.ignore({ log: "Debug", message: "送れない" }));\nx.pipe(Effect.ignore({\n  log: "Debug",\n  message: "送れない",\n}));\n')).toEqual([]);
  });

  it("message の無い options は通さない", () => {
    expect(linesOf('x.pipe(Effect.ignore({ log: "Debug" }));\n')).toEqual([1]);
  });

  it("行頭がコメントの行は見ない。ignoreCause など別の名前には当たらない", () => {
    expect(linesOf("// x.pipe(Effect.ignore)\nx.pipe(Effect.ignoreCause);\n")).toEqual([]);
  });
});
