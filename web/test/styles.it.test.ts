import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NARROW_QUERY } from "../src/app/startFlags.ts";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// トークン参照で書かれた色も、画面で使う hex として確かめる。
const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const colorTokens = new Map([...rootBlock.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const));
const resolveColors = (value: string) => value.replace(/var\(\s*(--color-[\w-]+)\s*\)/g, (whole, name: string) => colorTokens.get(name) ?? whole);
const rule = (selector: string) => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  return resolveColors(m?.[1] ?? "");
};

const WIDTH_FORMULA = /min\(\s*720px\s*,\s*calc\(\s*100vw\s*-\s*2\s*\*\s*316px\s*\)\s*\)/;

// 寸法と位置は、CSS の置き場によらず実ブラウザの computed style で確かめる
// （review.mount.heavy.test.ts・meeting.mount.heavy.test.ts）。

describe("styles.css: 色のトークンと点滅", () => {
  it("今の色 12 種を、今の hex のまま --color-* の token にする", () => {
    expect(Object.fromEntries(colorTokens)).toEqual({
      "--color-white": "#fff",
      "--color-gray-50": "#f9fafb",
      "--color-gray-100": "#f3f4f6",
      "--color-gray-200": "#e5e7eb",
      "--color-gray-400": "#9ca3af",
      "--color-gray-500": "#6b7280",
      "--color-gray-600": "#4b5563",
      "--color-gray-700": "#374151",
      "--color-gray-900": "#111827",
      "--color-yellow-400": "#facc15",
      "--color-green-800": "#166534",
      "--color-orange-700": "#c2410c",
    });
  });

  it("点滅の @keyframes と子孫・状態のセレクタがある", () => {
    expect(css).toMatch(/@keyframes map-node-blink/);
    expect(css).toMatch(/\.map-node:hover\s+\.map-node__fold-dot\s*\{/);
    expect(css).toMatch(/\.review-seek\[data-pointing\]/);
  });
});

describe("styles.css: 変わったノードの強調", () => {
  it("赤い枠（outline）と map-node--changed の規則がない", () => {
    expect(css).not.toContain("map-node--changed");
    expect(css).not.toMatch(/outline\s*:\s*[^;]*#dc2626/i);
    expect(css).not.toMatch(/#dc2626/i);
  });

  it("点滅はノードの塗りと枠だけを変え、文字は薄くしない（opacity を使わない）", () => {
    const frames = css.match(/@keyframes map-node-blink\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? "";
    expect(frames).toMatch(/background-color/);
    expect(frames).toMatch(/border-color/);
    expect(frames).not.toMatch(/opacity|(?<!-)color\s*:/);
    expect(css).not.toContain("map-node__flash");
  });

  it("変わったノードには細い黄色の枠を outline で付ける（実寸を変えない）", () => {
    expect(rule(".map-node--blink")).toMatch(/outline\s*:\s*1\.5px solid #facc15/i);
  });
});

describe("styles.css: 字幕と知らせ", () => {
  it("途中の分のカーソル: 幅 2px・文字の高さ・話者の色（currentColor）で、幅を取らない（右の margin が -2px）。影・枠は付けない", () => {
    const r = rule(".captions__cursor");
    expect(r).toMatch(/width\s*:\s*2px/);
    expect(r).toMatch(/height\s*:\s*1em/);
    expect(r).toMatch(/margin-right\s*:\s*-2px/);
    expect(r).toMatch(/background-color\s*:\s*currentColor/i);
    expect(r).not.toMatch(/box-shadow|border|outline/);
  });

  it("カーソルは 1 秒周期で止まらず点滅する", () => {
    expect(rule(".captions__cursor")).toMatch(/animation\s*:[^;]*\b1s\b[^;]*\binfinite\b/);
    expect(css).toMatch(/@keyframes\s+[\w-]+\s*\{[^@]*\}\s*\}/);
    const name = rule(".captions__cursor").match(/animation\s*:\s*([\w-]+)/)?.[1] ?? "";
    expect(name).not.toBe("");
    expect(css).toMatch(new RegExp(`@keyframes\\s+${name}\\b`));
    // 参照先の keyframes が、可視状態を切り替える（点滅する）定義であること
    expect(css).toMatch(new RegExp(`@keyframes\\s+${name}\\b[^{]*\\{[^@]*visibility\\s*:\\s*hidden`));
  });

  it("prefers-reduced-motion: reduce のときは、カーソルを点滅させずに出したままにする（animation: none）", () => {
    const m = css.match(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([\s\S]*?\.captions__cursor\s*\{[^}]*\})/);
    expect(m?.[1] ?? "").toMatch(/\.captions__cursor\s*\{[^}]*animation\s*:\s*none/);
  });

  it("仮のノードの規則はない", () => {
    expect(css).not.toContain(".draft-node");
  });

  it("取り込みの一言は、字幕の右端に並ぶ: left が 50% と同じ幅の式から決まる。80% の決め打ちではない", () => {
    const r = rule(".intake-notice");
    expect(r).toMatch(/left\s*:[^;]*50%[^;]*min\(\s*720px\s*,\s*calc\(\s*100vw\s*-\s*2\s*\*\s*316px\s*\)\s*\)/);
    expect(r).not.toMatch(/80%/);
  });

  it("共有画面を使っていない一文は、字幕と同じ幅の式で、影を付けず、fixed にしない", () => {
    const r = rule(".screen-notice");
    expect(r).not.toBe(""); // 規則があること（否定のテストの前提）
    expect(r).toMatch(new RegExp(`width\\s*:\\s*${WIDTH_FORMULA.source}`));
    expect(r).not.toMatch(/position\s*:\s*fixed/);
    expect(r).not.toMatch(/bottom\s*:/);
    expect(r).not.toMatch(/box-shadow\s*:\s*(?!\s*none)/);
  });

  it("取り込みの一言（intake-notice）と相手の音声が届かない一文（tap-notice）は、字幕の左右の反対側に置く", () => {
    const side = (r: string) => (/(^|[\s;])right\s*:/.test(r) ? "right" : /(^|[\s;])left\s*:/.test(r) ? "left" : "none");
    expect(side(rule(".tap-notice"))).not.toBe("none");
    expect(side(rule(".tap-notice"))).not.toBe(side(rule(".intake-notice")));
  });
});

describe("styles.css: 選んだノード", () => {
  it("枠・点滅の outline・影には触れない（実寸が変わり、配置がずれるため）", () => {
    const r = rule(".map-node--selected");
    expect(r).not.toBe("");
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

describe("styles.css: 人が開いたノードの小さな丸と、畳んだノードの隠れた数の丸（状態の規則）", () => {
  it("ホバーしたときだけ出す規則が子孫のセレクタにある", () => {
    expect(css).toMatch(/\.map-node:hover\s+\.map-node__fold-dot\s*\{/);
  });

  it("普段は透明で、ホバーと :focus-visible のときだけ opacity: 1。display: none・visibility: hidden では隠さない（Tab で届く）", () => {
    const shown = css.match(/[^{}]*\.map-node__fold-dot[^{}]*\{[^}]*opacity\s*:\s*1[^}]*\}/g) ?? [];
    expect(shown.some((b) => /\.map-node:hover\s+\.map-node__fold-dot/.test(b))).toBe(true);
    expect(shown.some((b) => /\.map-node__fold-dot:focus-visible/.test(b))).toBe(true);
    expect(css).not.toMatch(/\.map-node__fold-dot[^{}]*\{[^}]*(display\s*:\s*none|visibility\s*:\s*hidden)/);
  });

  it("ノードを選んだだけ・マウスで押した（:focus）だけでは出たままにしない", () => {
    for (const m of css.matchAll(/([^{}]*\.map-node__fold-dot[^{}]*)\{([^}]*)\}/g)) {
      if (/opacity\s*:\s*1/.test(m[2]!)) {
        expect(m[1]).not.toMatch(/map-node--selected|:focus-within/);
        expect(m[1]).not.toMatch(/:focus(?!-visible)/);
      }
    }
  });

  it("フォーカスの輪は :focus-visible のときだけ、outline: 2px solid #facc15。影は足さない", () => {
    for (const selector of [".map-node__fold-dot:focus-visible", ".map-node__count--pressable:focus-visible"]) {
      expect(rule(selector), selector).toMatch(/outline\s*:\s*2px solid #facc15/i);
      expect(rule(selector), selector).not.toMatch(/box-shadow/);
    }
    expect(rule(".map-node__fold-dot:focus")).toBe("");
    expect(rule(".map-node__count--pressable:focus")).toBe("");
  });
});

describe("styles.css: 狭い幅", () => {
  it("狭い幅: 会議中の画面を並べ替える @media の条件は NARROW_QUERY と同じ（Issue #1470）", () => {
    expect([...css.matchAll(/@media\s*([^{]+?)\s*\{\s*\.meeting \.layout\s*\{/g)].map((m) => m[1])).toEqual([NARROW_QUERY]);
  });
});
