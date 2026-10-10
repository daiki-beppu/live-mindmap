import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..");

describe("管理依存の固定版チェック", () => {
  it("server は型用の playwright-core を固定版で持ち、通常の playwright 依存を持たない", () => {
    const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(serverRoot, "managed-deps/chromium/package.json"), "utf8"));
    expect(pkg.devDependencies["playwright-core"]).toBe(manifest.dependencies["playwright-core"]);
    expect(pkg.devDependencies["playwright-core"]).toMatch(/^\d+\.\d+\.\d+$/);
    for (const deps of [pkg.dependencies, pkg.devDependencies]) expect(Object.keys(deps)).not.toContain("playwright");
  });

  it.each(["matching", "different", "range"])("typecheck に接続されたチェックは %s の版を判定する", (condition) => {
    const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
    const command = pkg.scripts.typecheck.split("&&").map((part: string) => part.trim()).find((part: string) => /\bnode\s+scripts\/check-managed-lock\.ts\b/.test(part));
    expect(command, "typecheck で固定版チェックを実行する").toBeDefined();
    expect(existsSync(join(serverRoot, "scripts/check-managed-lock.ts"))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "live-mindmap-managed-lock-"));
    try {
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, "managed-deps/chromium"), { recursive: true });
      copyFileSync(join(serverRoot, "scripts/check-managed-lock.ts"), join(dir, "scripts/check-managed-lock.ts"));
      for (const file of ["package.json", "package-lock.json"]) {
        copyFileSync(join(serverRoot, "managed-deps/chromium", file), join(dir, "managed-deps/chromium", file));
      }
      const manifest = JSON.parse(readFileSync(join(dir, "managed-deps/chromium/package.json"), "utf8"));
      const fixed = manifest.dependencies["playwright-core"];
      pkg.devDependencies["playwright-core"] = condition === "matching" ? fixed : condition === "range" ? `^${fixed}` : "0.0.0";
      const content = JSON.stringify(pkg, null, 2) + "\n";
      writeFileSync(join(dir, "package.json"), content);
      const result = spawnSync("bash", ["-e", "-c", command!], { cwd: dir, encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined();
      if (condition === "matching") expect(result.status, result.stderr).toBe(0);
      else {
        expect(result.status).not.toBe(0);
        const line = content.split("\n").findIndex((text) => text.includes('"playwright-core"')) + 1;
        expect(result.stderr).toContain(`package.json:${line}:`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
