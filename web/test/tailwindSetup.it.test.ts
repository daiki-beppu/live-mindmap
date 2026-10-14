import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

// Issue #830: CSS を Tailwind v4（@tailwindcss/vite）に替える。依存・Vite の設定を、ファイルとして確かめる。
// ビルドした CSS の中身（Preflight が無い・token・keyframes・影が無い）は server/test/reviewBuild.heavy.test.ts、画面の見た目は review.mount.heavy.test.ts・meeting.mount.heavy.test.ts の寸法の確認が見る。
const webRoot = join(import.meta.dirname, "..");
const read = (...path: string[]) => readFileSync(join(...path), "utf8");
const web = JSON.parse(read(webRoot, "package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const all = { ...web.dependencies, ...web.devDependencies };

describe("web の Tailwind 依存", () => {
  it.each(["tailwindcss", "@tailwindcss/vite"])("%s を v4 で入れる", (name) => {
    expect(all[name], name).toMatch(/^[\^~]?4\.\d+\.\d+$/);
  });

  it("v3 の設定ファイル（tailwind.config.*）と PostCSS の設定は置かない（CSS の中の @theme で設定する）", () => {
    const files = ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs", "tailwind.config.mjs", "postcss.config.js", "postcss.config.cjs", "postcss.config.mjs"];
    for (const file of files) expect(() => readFileSync(join(webRoot, file)), file).toThrow();
  });
});

describe("web の Vite の設定", () => {
  it("開発サーバーとビルドの両方で @tailwindcss/vite の plugin が入る（見返しのビルド・撮影・会議中の dev サーバーが同じ設定を使う）", async () => {
    for (const command of ["serve", "build"] as const) {
      const config = await resolveConfig({ root: webRoot, configFile: join(webRoot, "vite.config.ts") }, command);
      const names = config.plugins.map((plugin) => plugin.name);
      expect(names.some((name) => /tailwindcss/i.test(name)), `${command}: ${names.join(", ")}`).toBe(true);
      expect(names.some((name) => /foldkit/i.test(name)), command).toBe(true);
    }
  });

  it("vitest の mode（test）では Tailwind を通さない（unit・軽い IT は CSS をファイルとして読むだけで、foldkit() と同じく外す）", async () => {
    const config = await resolveConfig({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), mode: "test" }, "serve", "test");
    expect(config.plugins.map((plugin) => plugin.name).filter((name) => /tailwindcss/i.test(name))).toEqual([]);
  });
});
