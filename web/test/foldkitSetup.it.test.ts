import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  it("tsconfig.json に JSX の設定（jsx）が無い", () => {
    const tsconfig = JSON.parse(read(webRoot, "tsconfig.json")) as { compilerOptions: Record<string, unknown> };
    expect("jsx" in tsconfig.compilerOptions).toBe(false);
  });
});

// Issue #829: 会議中の画面を Foldkit へ切り替えて、React と React に結び付いた依存を web から消した
describe("React と React 用の依存は web に無い（Issue #829）", () => {
  const REMOVED = ["react", "react-dom", "@xyflow/react", "@videojs/react", "@tanstack/react-hotkeys", "@tanstack/hotkeys", "@types/react", "@types/react-dom", "@vitejs/plugin-react"];

  it("web/package.json の dependencies・devDependencies に無い", () => {
    for (const name of REMOVED) expect(all[name], name).toBeUndefined();
  });

  it("pnpm-lock.yaml の web の importer に無い（package.json だけ直して lockfile を古いままにしない）", () => {
    const lines = read(repoRoot, "pnpm-lock.yaml").split("\n");
    const start = lines.findIndex((line) => line === "  web:");
    expect(start, "importers の web:").toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}\S/.test(line) || /^\S/.test(line));
    const block = end === -1 ? rest : rest.slice(0, end);
    const declared = block.map((line) => /^ {6}'?([^':]+)'?:$/.exec(line)?.[1]).filter((name): name is string => name !== undefined);
    expect(declared).toContain("foldkit");
    for (const name of REMOVED) expect(declared, name).not.toContain(name);
  });

  it("web/src と web/test に、.tsx のファイルも、React・@xyflow・@videojs/react・@tanstack の import も無い", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    const sources = [...files(join(webRoot, "src")), ...files(join(webRoot, "test"))].filter((path) => path !== import.meta.filename);
    expect(sources.filter((path) => path.endsWith(".tsx"))).toEqual([]);
    const IMPORT = /(?:from|import)\s*\(?\s*["'](react|react-dom|react\/[^"']*|react-dom\/[^"']*|@xyflow\/[^"']*|@videojs\/react[^"']*|@tanstack\/[^"']*)["']/;
    const importing = sources.filter((path) => path.endsWith(".ts") && IMPORT.test(read(path)));
    expect(importing).toEqual([]);
  });

  it("入口は .tsx ではなく Foldkit だけで起動する web/src/main.ts で、index.html がそれを指す", () => {
    expect(existsSync(join(webRoot, "src", "main.tsx"))).toBe(false);
    expect(existsSync(join(webRoot, "src", "main.ts"))).toBe(true);
    const html = read(webRoot, "index.html");
    expect(html).toContain('src="/src/main.ts"');
    expect(html).not.toContain("main.tsx");
  });

  it("照合のための一時の印（window の __LIVE_MINDMAP_RENDERER__）が web・server・e2e のどこにも残っていない", () => {
    const MARK = ["__LIVE_MINDMAP", "RENDERER__"].join("_");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === "node_modules" || entry.name === ".e2e" || entry.name === "dist" || entry.name.startsWith(".")) return [];
        const path = join(dir, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      });
    const holders = ["web", "server", "e2e"]
      .flatMap((dir) => files(join(repoRoot, dir)))
      .filter((path) => path !== import.meta.filename && /\.(ts|tsx|html|css|json)$/.test(path))
      .filter((path) => read(path).includes(MARK));
    expect(holders).toEqual([]);
  });
});
