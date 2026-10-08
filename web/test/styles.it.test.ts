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

describe("styles.css: 共有画面を使っていない一文（Issue #280）", () => {
  it("layout の直下に重ねる（absolute、fixed にしない）ので、字幕とマップの位置を動かさない", () => {
    const r = rule(".screen-notice");
    expect(r).not.toBe(""); // 規則があること（否定のテストの前提）
    expect(r).toMatch(/position\s*:\s*absolute/);
    expect(r).not.toMatch(/position\s*:\s*fixed/);
    expect(rule(".layout")).toMatch(/position\s*:\s*relative/);
  });

  it("字幕（下端）と取り込みの一言（字幕の右、下端）と重ならないよう、下端基準ではなく上端基準で置く", () => {
    const r = rule(".screen-notice");
    expect(r).toMatch(/top\s*:/);
    expect(r).not.toMatch(/bottom\s*:/);
    expect(rule(".intake-notice")).toMatch(/bottom\s*:/);
  });

  it("操作を邪魔せず、影を付けない", () => {
    const r = rule(".screen-notice");
    expect(r).toMatch(/pointer-events\s*:\s*none/);
    expect(r).not.toMatch(/box-shadow\s*:\s*(?!\s*none)/);
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

describe("styles.css: 選んだノード", () => {
  it("塗りを薄い灰色にする（背景色の指定がある）", () => {
    expect(rule(".map-node--selected")).toMatch(/background(?:-color)?\s*:\s*(?:#(?:[ef][0-9a-f]){3}|#[ef][0-9a-f]{2}|rgb)/i);
  });

  it("枠・点滅の outline・影には触れない（実寸が変わり、配置がずれるため）", () => {
    const r = rule(".map-node--selected");
    expect(r).not.toMatch(/border|outline|box-shadow|padding|margin|width|height/);
  });

  it("畳んだノードの塗りに負けないよう、.map-node--folded より後ろに置く", () => {
    const selectedAt = css.search(/(?:^|\n)\.map-node--selected\s*\{/);
    const foldedAt = css.search(/(?:^|\n)\.map-node--folded\s*\{/);
    expect(selectedAt).toBeGreaterThanOrEqual(0);
    expect(foldedAt).toBeGreaterThanOrEqual(0);
    expect(selectedAt).toBeGreaterThan(foldedAt);
  });
});

describe("styles.css: 人が開いたノードの小さな丸", () => {
  it("ノードの実寸を変えないよう絶対位置で置き、ホバーしたときだけ出す", () => {
    expect(rule(".map-node__fold-dot")).toMatch(/position\s*:\s*absolute/);
    expect(css).toMatch(/\.map-node:hover\s+\.map-node__fold-dot\s*\{/);
  });

  it("display: none で隠さない（Tab で届くよう opacity: 0 で描く）。普段は透明で、ホバーと :focus-visible のときだけ opacity: 1", () => {
    const r = rule(".map-node__fold-dot");
    expect(r).not.toMatch(/display\s*:\s*none/);
    expect(r).not.toMatch(/visibility\s*:\s*hidden/);
    expect(r).toMatch(/opacity\s*:\s*0\s*(;|$)/);
    const shown = css.match(/[^{}]*\.map-node__fold-dot[^{}]*\{[^}]*opacity\s*:\s*1[^}]*\}/g) ?? [];
    expect(shown.some((b) => /\.map-node:hover\s+\.map-node__fold-dot/.test(b))).toBe(true);
    expect(shown.some((b) => /\.map-node__fold-dot:focus-visible/.test(b))).toBe(true);
  });

  it("ノードを選んだだけ・マウスで押した（:focus）だけでは出たままにしない", () => {
    for (const m of css.matchAll(/([^{}]*\.map-node__fold-dot[^{}]*)\{([^}]*)\}/g)) {
      if (/opacity\s*:\s*1/.test(m[2]!)) {
        expect(m[1]).not.toMatch(/map-node--selected|:focus-within/);
        expect(m[1]).not.toMatch(/:focus(?!-visible)/);
      }
    }
  });

  it("ボタンの既定の枠・余白を打ち消し、寸法と位置は今のまま", () => {
    const r = rule(".map-node__fold-dot");
    expect(r).toMatch(/padding\s*:\s*0\s*(;|$)/);
    expect(r).toMatch(/margin\s*:\s*0\s*(;|$)/);
    expect(r).toMatch(/width\s*:\s*12px/);
    expect(r).toMatch(/height\s*:\s*12px/);
    expect(r).toMatch(/top\s*:\s*50%/);
    expect(r).toMatch(/right\s*:\s*6px/);
  });

  it("フォーカスの輪は :focus-visible のときだけ、既存のフォーカスと同じ outline: 2px solid #facc15。影は足さない", () => {
    expect(rule(".map-node__fold-dot:focus-visible")).toMatch(/outline\s*:\s*2px solid #facc15/i);
    expect(rule(".map-node__fold-dot:focus-visible")).not.toMatch(/box-shadow/);
    expect(rule(".map-node__fold-dot:focus")).toBe("");
  });
});

describe("styles.css: 畳んだノードの隠れた数の丸（押せるもの）", () => {
  it("ボタンの既定の枠・余白を打ち消す（border: 0・margin: 0・font-family: inherit）。font の一括指定で大きさを変えない", () => {
    const r = rule(".map-node__count--pressable");
    expect(r).toMatch(/border\s*:\s*0\s*(;|$)/);
    expect(r).toMatch(/margin\s*:\s*0\s*(;|$)/);
    expect(r).toMatch(/font-family\s*:\s*inherit/);
    expect(r).not.toMatch(/(?<![-\w])font\s*:/);
  });

  it("寸法・位置・普段の見た目は今のまま（.map-node__count の規則）", () => {
    const r = rule(".map-node__count");
    expect(r).toMatch(/position\s*:\s*absolute/);
    expect(r).toMatch(/top\s*:\s*50%/);
    expect(r).toMatch(/right\s*:\s*6px/);
    expect(r).toMatch(/min-width\s*:\s*18px/);
    expect(r).toMatch(/height\s*:\s*18px/);
    expect(r).toMatch(/padding\s*:\s*0 4px/);
    expect(r).toMatch(/background\s*:\s*#e5e7eb/);
    expect(r).toMatch(/font-size\s*:\s*11px/);
    expect(r).toMatch(/line-height\s*:\s*18px/);
  });

  it("フォーカスの輪は :focus-visible のときだけ、outline: 2px solid #facc15。影は足さない", () => {
    expect(rule(".map-node__count--pressable:focus-visible")).toMatch(/outline\s*:\s*2px solid #facc15/i);
    expect(rule(".map-node__count--pressable:focus-visible")).not.toMatch(/box-shadow/);
    expect(rule(".map-node__count--pressable:focus")).toBe("");
  });
});
