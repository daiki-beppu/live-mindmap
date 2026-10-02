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

  it("点滅は 1 秒周期で 3 回、ノードの塗りと枠だけを変え、文字は薄くしない（opacity を使わない）", () => {
    expect(rule(".map-node--blink")).toMatch(/animation\s*:[^;]*\b1s\b[^;]*\s3;/); // 1 秒周期を 3 回
    const frames = css.match(/@keyframes map-node-blink\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? "";
    expect(frames).toMatch(/background-color/);
    expect(frames).toMatch(/border-color/);
    expect(frames).not.toMatch(/opacity|(?<!-)color\s*:/);
    expect(css).not.toContain("map-node__flash");
  });

  it("変わったノードには細い黄色の枠を outline で付ける（実寸を変えない）", () => {
    expect(rule(".map-node--blink")).toMatch(/outline\s*:\s*1\.5px solid #facc15/i);
  });

  it("「変わったこと」の変化の種類は赤でない", () => {
    expect(rule(".changes__type")).not.toMatch(/#dc2626/i);
  });
});


describe("styles.css: 仮のノード", () => {
  const body = () => rule(".draft-node");
  const hex = (value: string): [number, number, number] => {
    const m = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) throw new Error(`色が #rrggbb ではありません: ${value}`);
    return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  };
  // 灰色（Tailwind の gray は少し青みがある: #9ca3af・#6b7280 はチャンネル差が 19〜21）。種別の色は彩度が高く、これを超える
  const isGray = ([r, g, b]: [number, number, number]) => Math.max(r, g, b) - Math.min(r, g, b) <= 24;

  it("正式なノードと同じ幅で、規則がある", () => {
    expect(body()).not.toBe("");
    expect(body()).toMatch(/width\s*:\s*200px/);
  });

  it("枠は破線で、灰色。文字も灰色。塗りはない", () => {
    expect(body()).toMatch(/border\s*:[^;]*\bdashed\b/);
    const border = body().match(/border\s*:[^;]*(#[0-9a-f]{6})/i)?.[1];
    expect(isGray(hex(border!))).toBe(true);
    const color = body().match(/(?:^|[;\s])color\s*:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(isGray(hex(color!))).toBe(true);
    expect(body()).toMatch(/background\s*:\s*(none|transparent)\s*;/);
  });

  it("種別の色を使わず、影も付けない", () => {
    expect(body()).not.toContain("--kind-color");
    expect(body()).not.toMatch(/box-shadow\s*:(?!\s*none)/);
    expect(body()).toMatch(/box-shadow\s*:\s*none/);
  });
});
