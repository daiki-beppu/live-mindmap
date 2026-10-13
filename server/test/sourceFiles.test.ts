import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportViolations } from "../scripts/sourceFiles.ts";

// check-entrypoints と check-test-layers が共有する違反の出力。出力の形は両スクリプトの利用者（CI のログ）が見る
describe("reportViolations", () => {
  let saved: typeof process.exitCode;
  beforeEach(() => { saved = process.exitCode; process.exitCode = undefined; });
  afterEach(() => { process.exitCode = saved; vi.restoreAllMocks(); });

  it("行番号つきの違反は <パス>:<行>: <説明> の 1 行を stderr に出し、終了コードを 1 にする", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportViolations([{ path: "test/a.test.ts", line: 3, message: "bad" }]);
    expect(error.mock.calls).toEqual([["test/a.test.ts:3: bad"]]);
    expect(process.exitCode).toBe(1);
  });

  it("行番号のない違反は <パス>: <説明> の 1 行にする", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportViolations([{ path: "bench/x.ts", message: "no teardown" }]);
    expect(error.mock.calls).toEqual([["bench/x.ts: no teardown"]]);
    expect(process.exitCode).toBe(1);
  });

  it("複数の違反は渡された順に 1 行ずつ出す", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportViolations([{ path: "a.ts", line: 1, message: "m1" }, { path: "b.ts", message: "m2" }]);
    expect(error.mock.calls).toEqual([["a.ts:1: m1"], ["b.ts: m2"]]);
  });

  it("違反が無ければ何も出さず、終了コードも変えない", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportViolations([]);
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
