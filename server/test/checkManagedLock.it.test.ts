import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..");

describe("管理依存の固定版チェック", () => {
  it("server は SDK 型用の固定版を開発依存に置き、管理 manifest と lock の版を揃える", () => {
    const name = "@anthropic-ai/claude-agent-sdk";
    const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
    expect(pkg.dependencies[name]).toBeUndefined();
    expect(pkg.devDependencies[name]).toBe("0.3.288");
    const manifest = JSON.parse(readFileSync(join(serverRoot, "managed-deps/claude/package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(serverRoot, "managed-deps/claude/package-lock.json"), "utf8"));
    expect(manifest.dependencies[name]).toBe(pkg.devDependencies[name]);
    expect(lock.packages[`node_modules/${name}`].version).toBe(pkg.devDependencies[name]);
  });

  it("server は型用の playwright-core を固定版で持ち、通常の playwright 依存を持たない", () => {
    const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(serverRoot, "managed-deps/chromium/package.json"), "utf8"));
    expect(pkg.devDependencies["playwright-core"]).toBe(manifest.dependencies["playwright-core"]);
    expect(pkg.devDependencies["playwright-core"]).toMatch(/^\d+\.\d+\.\d+$/);
    for (const deps of [pkg.dependencies, pkg.devDependencies]) expect(Object.keys(deps)).not.toContain("playwright");
  });

  it.each(["playwright-core", "@anthropic-ai/claude-agent-sdk"].flatMap((name) => ["matching", "different", "range"].map((condition) => ({ name, condition }))))("typecheck に接続されたチェックは $name の $condition を判定する", ({ name, condition }) => {
    const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
    const command = pkg.scripts.typecheck.split("&&").map((part: string) => part.trim()).find((part: string) => /\bnode\s+scripts\/check-managed-lock\.ts\b/.test(part));
    expect(command, "typecheck で固定版チェックを実行する").toBeDefined();
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
      pkg.devDependencies["playwright-core"] = fixed;
      const sdkVersion = "0.3.288";
      pkg.devDependencies["@anthropic-ai/claude-agent-sdk"] = sdkVersion;
      mkdirSync(join(dir, "managed-deps/claude"), { recursive: true });
      writeFileSync(join(dir, "managed-deps/claude/package.json"), JSON.stringify({ dependencies: { "@anthropic-ai/claude-agent-sdk": sdkVersion } }));
      writeFileSync(join(dir, "managed-deps/claude/package-lock.json"), JSON.stringify({ packages: { "node_modules/@anthropic-ai/claude-agent-sdk": { version: sdkVersion } } }));
      const expected = name === "playwright-core" ? fixed : sdkVersion;
      pkg.devDependencies[name] = condition === "matching" ? expected : condition === "range" ? `^${expected}` : "0.0.0";
      const content = JSON.stringify(pkg, null, 2) + "\n";
      writeFileSync(join(dir, "package.json"), content);
      const result = spawnSync("bash", ["-e", "-c", command!], { cwd: dir, encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined();
      if (condition === "matching") expect(result.status, result.stderr).toBe(0);
      else {
        expect(result.status).not.toBe(0);
        const line = content.split("\n").findIndex((text) => text.includes(`"${name}"`)) + 1;
        expect(result.stderr).toContain(`package.json:${line}:`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
