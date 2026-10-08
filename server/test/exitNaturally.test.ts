import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cause, Exit } from "effect";
import { exitNaturally } from "../src/exitNaturally.ts";

// 入口（server.ts・cli.ts）が共有する終わり方: 終了コードを process.exitCode に入れるだけで、onExit（既定は process.exit）を呼ばない
describe("exitNaturally", () => {
  let saved: typeof process.exitCode;
  beforeEach(() => {
    saved = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = saved;
  });

  it("成功は 0 を process.exitCode に入れ、process.exit を呼ばない", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      exitNaturally(Exit.succeed(undefined), () => { throw new Error("onExit を呼んではならない"); });
      expect(process.exitCode).toBe(0);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("失敗は 0 以外を process.exitCode に入れ、process.exit を呼ばない", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      exitNaturally(Exit.fail("boom"), () => { throw new Error("onExit を呼んではならない"); });
      expect(process.exitCode).toBe(1);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("中断だけの Exit は既定の規則（130）のまま", () => {
    exitNaturally(Exit.failCause(Cause.interrupt()), () => {});
    expect(process.exitCode).toBe(130);
  });
});
