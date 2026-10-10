import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  writeFileSync: vi.fn(), linkSync: vi.fn(), unlinkSync: vi.fn(), readFileSync: vi.fn(),
  spawn: vi.fn(), on: vi.fn(),
}));
vi.mock("node:fs", () => doubles);
vi.mock("node:child_process", () => ({ spawn: doubles.spawn }));
vi.mock("node:crypto", () => ({ randomUUID: () => "execution-id" }));

describe("導入ランナー", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("process", { ...process, argv: ["node", "runner", "/deps/install.lock.guard/owner", "npm", "ci"], pid: 123, ppid: 456, platform: "darwin" });
    doubles.readFileSync.mockReturnValue("456");
    doubles.spawn.mockReturnValue({ on: doubles.on });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("実行記録と所有者の確認が済んでから引数を保持して起動する", async () => {
    await import("../src/managedDepsRunner.ts");
    expect(doubles.writeFileSync).toHaveBeenCalledWith("/deps/install.lock.guard-execution-id.execution", "-123", { flag: "wx", mode: 0o600 });
    expect(doubles.linkSync).toHaveBeenCalledWith("/deps/install.lock.guard-execution-id.execution", "/deps/install.lock.guard/execution-execution-id");
    expect(doubles.linkSync.mock.invocationCallOrder[0]).toBeLessThan(doubles.readFileSync.mock.invocationCallOrder[0]!);
    expect(doubles.readFileSync.mock.invocationCallOrder[0]).toBeLessThan(doubles.spawn.mock.invocationCallOrder[0]!);
    expect(doubles.spawn).toHaveBeenCalledWith("npm", ["ci"], { stdio: ["ignore", "inherit", "inherit"], detached: false });
    const exit = doubles.on.mock.calls.find(([event]) => event === "exit")?.[1];
    expect(exit).toBeTypeOf("function");
    exit(17, null);
    expect(process.exitCode).toBe(17);
  });

  it("所有者交代後は実コマンドを起動しない", async () => {
    doubles.readFileSync.mockReturnValue("789");
    await expect(import("../src/managedDepsRunner.ts")).rejects.toThrow("所有者が交代しました");
    expect(doubles.linkSync).toHaveBeenCalledOnce();
    expect(doubles.spawn).not.toHaveBeenCalled();
    expect(doubles.unlinkSync).toHaveBeenCalledWith("/deps/install.lock.guard-execution-id.execution");
  });

  it("記録公開に失敗した場合は起動せず途中ファイルを除去する", async () => {
    doubles.linkSync.mockImplementationOnce(() => { throw new Error("guard disappeared"); });
    await expect(import("../src/managedDepsRunner.ts")).rejects.toThrow("guard disappeared");
    expect(doubles.unlinkSync).toHaveBeenCalledOnce();
    expect(doubles.spawn).not.toHaveBeenCalled();
  });

  it("Windows は寿命を確認できない実コマンドを開始しない", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    await expect(import("../src/managedDepsRunner.ts")).rejects.toThrow();
    expect(doubles.writeFileSync).not.toHaveBeenCalled();
    expect(doubles.spawn).not.toHaveBeenCalled();
  });
});
