import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

const webRoot = join(import.meta.dirname, "..");
const repoRoot = join(webRoot, "..");
const read = (...path: string[]) => readFileSync(join(...path), "utf8");
const manifest = (dir: string) => JSON.parse(read(dir, "package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const web = manifest(webRoot);
const all = { ...web.dependencies, ...web.devDependencies };

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

describe("web の Foldkit 依存（exact 固定）", () => {
  it.each([
    ["foldkit", "0.167.0"],
    ["@foldkit/ui", "0.167.0"],
    ["@foldkit/vite-plugin", "0.27.0"],
    ["@foldkit/oxlint-plugin", "0.15.3"],
  ])("%s を %s で入れる", (name, version) => {
    expect(all[name]).toBe(version);
    expect(all[name]).toMatch(EXACT_VERSION);
  });

  it("effect と @effect/platform-browser を server の effect と同じ版の exact で持つ", () => {
    const serverEffect = manifest(join(repoRoot, "server")).dependencies?.effect;
    expect(serverEffect).toMatch(EXACT_VERSION);
    expect(web.dependencies?.effect).toBe(serverEffect);
    expect(web.dependencies?.["@effect/platform-browser"]).toBe(serverEffect);
  });
});

describe("Foldkit の peer（effect 4.0.0）の許可", () => {
  const workspace = read(repoRoot, "pnpm-workspace.yaml");

  it("peerDependencyRules.allowedVersions で 4 つの peer を 4.0.1 に許す", () => {
    const lines = workspace.split("\n").map((line) => line.trimEnd());
    const rootIndex = lines.indexOf("peerDependencyRules:");
    expect(rootIndex, "peerDependencyRules:").toBeGreaterThanOrEqual(0);
    const afterRoot = lines.slice(rootIndex + 1);
    const rootEnd = afterRoot.findIndex((line) => line !== "" && !/^\s/.test(line));
    const rootBlock = rootEnd === -1 ? afterRoot : afterRoot.slice(0, rootEnd);
    const allowedIndex = rootBlock.indexOf("  allowedVersions:");
    expect(allowedIndex, "allowedVersions:").toBeGreaterThanOrEqual(0);
    const afterAllowed = rootBlock.slice(allowedIndex + 1);
    const childEnd = afterAllowed.findIndex((line) => !line.startsWith("    "));
    const childLines = childEnd === -1 ? afterAllowed : afterAllowed.slice(0, childEnd);
    const allowed: Record<string, string> = {};
    for (const line of childLines) {
      const match = /^(['"]?)(.+)\1:\s*(['"]?)([^'"\s]+)\3$/.exec(line.trim());
      const key = match?.[2];
      const value = match?.[4];
      expect(key !== undefined && value !== undefined, line).toBe(true);
      if (key !== undefined && value !== undefined) allowed[key] = value;
    }
    expect(allowed).toEqual({
      "foldkit>effect": "4.0.1",
      "foldkit>@effect/platform-browser": "4.0.1",
      "@foldkit/ui>effect": "4.0.1",
      "@foldkit/vite-plugin>effect": "4.0.1",
    });
  });

  it("既存の packages と ignoredOptionalDependencies を残す", () => {
    expect(workspace).toMatch(/^packages:/m);
    expect(workspace).toContain("ignoredOptionalDependencies");
  });
});

describe("束ねる effect は 1 つ（lockfile）", () => {
  const lock = read(repoRoot, "pnpm-lock.yaml");

  it("解決された effect の実体は 4.0.1 だけ", () => {
    const entries = [...lock.matchAll(/^ {2}'?(effect@[^:'\s]+)'?:/gm)].map((m) => m[1]);
    expect(new Set(entries)).toEqual(new Set(["effect@4.0.1"]));
  });

  it("Foldkit 一式の peer の effect も 4.0.1 に解決される", () => {
    for (const name of ["foldkit", "@foldkit/ui", "@foldkit/vite-plugin"]) {
      const resolved = [...lock.matchAll(new RegExp(`^ {2}'?${name}@[^:'\\s]+\\(.*:$`, "gm"))].map((m) => m[0]);
      expect(resolved.length, name).toBeGreaterThan(0);
      for (const entry of resolved) expect(entry, name).toContain("effect@4.0.1");
    }
  });
});

describe("web の Vite の設定", () => {
  it("@foldkit/vite-plugin が plugins に入り、React のプラグインと開発サーバーの CSP も残る", async () => {
    const config = await resolveConfig({ root: webRoot, configFile: join(webRoot, "vite.config.ts") }, "serve");
    const names = config.plugins.map((plugin) => plugin.name);
    expect(names.some((name) => /foldkit/i.test(name))).toBe(true);
    expect(names.some((name) => /react/i.test(name))).toBe(true);
    expect(config.server.headers).toEqual({ "Content-Security-Policy": "connect-src 'self'" });
  });
});
