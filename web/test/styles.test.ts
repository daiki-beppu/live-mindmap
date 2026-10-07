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


describe("styles.css: 字幕", () => {
  it("仮のノードの規則はない", () => {
    expect(css).not.toContain(".draft-node");
  });

  it("字幕は layout の下端に重ね、操作を邪魔しない。影は付けない", () => {
    expect(rule(".captions")).toMatch(/position\s*:\s*absolute/);
    expect(rule(".captions")).toMatch(/bottom\s*:/);
    expect(rule(".captions")).toMatch(/pointer-events\s*:\s*none/);
    expect(rule(".layout")).toMatch(/position\s*:\s*relative/);
    expect(rule(".captions__block")).toMatch(/box-shadow\s*:\s*none/);
    expect(rule(".captions__block")).not.toContain("--kind-color");
  });

  it("字幕は窓の中央に固定し、幅は列にかからない min(720px, 100vw − 2 × 316px)。見返しの操作の行に重ならないよう fixed にしない", () => {
    const r = rule(".captions");
    expect(r).toMatch(/left\s*:\s*50%/);
    expect(r).toMatch(/translateX\(-50%\)/);
    expect(r).toMatch(/width\s*:\s*min\(\s*720px\s*,\s*calc\(\s*100vw\s*-\s*2\s*\*\s*316px\s*\)\s*\)/);
    expect(r).not.toMatch(/position\s*:\s*fixed/);
    expect(rule(".intake-notice")).not.toMatch(/position\s*:\s*fixed/);
  });

  it("取り込みの一言は、字幕と同じ基準（layout）・同じ幅の式で、字幕の右端に並ぶ", () => {
    const r = rule(".intake-notice");
    expect(r).toMatch(/position\s*:\s*absolute/);
    expect(r).toMatch(/left\s*:[^;]*50%[^;]*min\(\s*720px\s*,\s*calc\(\s*100vw\s*-\s*2\s*\*\s*316px\s*\)\s*\)/);
    expect(r).not.toMatch(/80%/);
  });
});

describe("styles.css: キー一覧", () => {
  it("マップの右上に重ね、細い枠だけで、操作を邪魔しない。影は付けない", () => {
    const r = rule(".key-list");
    expect(r).toMatch(/position\s*:\s*absolute/);
    expect(r).toMatch(/top\s*:/);
    expect(r).toMatch(/right\s*:/);
    expect(r).toMatch(/border\s*:\s*1px solid/);
    expect(r).toMatch(/pointer-events\s*:\s*none/);
    expect(r).not.toMatch(/box-shadow\s*:\s*(?!none)/);
  });
});
