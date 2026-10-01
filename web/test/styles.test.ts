import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  return m?.[1] ?? "";
};

describe("styles.css: 変わったノードの強調", () => {
  it("赤い枠（outline）と map-node--changed の規則がない", () => {
    expect(css).not.toContain("map-node--changed");
    expect(css).not.toMatch(/outline\s*:\s*[^;]*#dc2626/i);
  });

  it("枠・影を足さない（box-shadow は none のまま）", () => {
    for (const m of css.matchAll(/box-shadow\s*:\s*([^;]+);/g)) expect(m[1]!.trim()).toBe("none");
  });

  it("塗りの層は約 3 秒のアニメーションで、位置は absolute", () => {
    const r = rule(".map-node__flash");
    expect(r).toMatch(/position\s*:\s*absolute/);
    expect(r).toMatch(/animation\s*:[^;]*\b3s\b/);
  });

  it("「変わったこと」の変化の種類は赤でない", () => {
    expect(rule(".changes__type")).not.toMatch(/#dc2626/i);
  });
});

describe("styles.css: ルートの中央揃え", () => {
  it("map-node--root のボタンだけを中央揃えにし、既定は left のまま", () => {
    expect(rule(".map-node--root .map-node__button")).toMatch(/text-align\s*:\s*center/);
    expect(rule(".map-node__button")).toMatch(/text-align\s*:\s*left/);
  });
});
