import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// Tailwind v4 の入口（Issue #830）。styles.css は @theme の token を持つ。素の CSS に残した規則が色を var(--color-*) で書いても、今の hex として読めるよう解決する
const themeBlock = css.match(/@theme\b[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const colorTokens = new Map([...themeBlock.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const));
const resolveColors = (value: string) => value.replace(/var\(\s*(--color-[\w-]+)\s*\)/g, (whole, name: string) => colorTokens.get(name) ?? whole);
const rule = (selector: string) => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  return resolveColors(m?.[1] ?? "");
};

const WIDTH_FORMULA = /min\(\s*720px\s*,\s*calc\(\s*100vw\s*-\s*2\s*\*\s*316px\s*\)\s*\)/;

// 素の CSS に残す規則（点滅・子孫と状態のセレクタ・min()/calc() の長い値）は、styles.css の文面で確かめる。
// ユーティリティへ移した規則（.layout・.key-list・.map-node__count・.map-node__fold-dot の基本の値など）は、置き場に依らない実ブラウザの computed style で確かめる
// （review.mount.heavy.test.ts・meeting.mount.heavy.test.ts の寸法）。

describe("styles.css: Tailwind v4 の入口（Issue #830）", () => {
  const imports = [...css.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)].map((m) => m[1]!);

  it("Preflight を入れない: theme.css と utilities.css だけを import し、`tailwindcss` の丸ごとの import も preflight.css も使わない", () => {
    expect(imports).toContain("tailwindcss/theme.css");
    expect(imports).toContain("tailwindcss/utilities.css");
    expect(imports).not.toContain("tailwindcss");
    expect(imports.filter((name) => /preflight/.test(name))).toEqual([]);
    expect(css).not.toMatch(/@import\s+["']tailwindcss["']/);
  });

  it("既定のテーマを消す: @theme で `--*: initial` を宣言し、既定の token（影・角丸・OKLCH の色）を残さない", () => {
    expect(css).toMatch(/@theme\b[^{]*\{/);
    expect(themeBlock).toMatch(/--\*\s*:\s*initial\s*;/);
    expect(css).not.toMatch(/--shadow-|--drop-shadow-|--inset-shadow-|--radius-/);
    expect(css).not.toMatch(/oklch\(/i);
  });

  it("今の色 12 種を、今の hex のまま --color-* の token にする", () => {
    const values = new Set([...colorTokens.values()].map((value) => value.toLowerCase()));
    for (const hex of ["#111827", "#166534", "#374151", "#4b5563", "#6b7280", "#9ca3af", "#c2410c", "#e5e7eb", "#f3f4f6", "#f9fafb", "#facc15", "#fff"]) {
      expect(values.has(hex), hex).toBe(true);
    }
    expect(colorTokens.get("--color-yellow-400")).toBe("#facc15");
  });

  it("走査を web のソースに絞る: utilities の import は source(none) で自動の走査を止め、@source で web/src だけを指す", () => {
    expect(css).toMatch(/@import\s+["']tailwindcss\/utilities\.css["'][^;]*source\(none\)/);
    const sources = [...css.matchAll(/@source\s+(?:not\s+)?["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(sources.length).toBeGreaterThan(0);
    // 走査の起点は web/src の中だけ（リポジトリ全体・server・node_modules を読まない）
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const path of sources) {
      const resolved = resolve(srcDir, path) + sep;
      expect(resolved.startsWith(srcDir), path).toBe(true);
      expect(resolved, path).not.toContain("node_modules");
    }
  });

  it("素の CSS に残す点滅の @keyframes と子孫・状態のセレクタが、層（@layer { … } のブロック）の外にある: ユーティリティに勝つため", () => {
    const outsideBlocks = css.replace(/@layer\s+[\w-]+\s*\{[\s\S]*?\n\}/g, "");
    expect(outsideBlocks).toMatch(/@keyframes map-node-blink/);
    expect(outsideBlocks).toMatch(/\.map-node:hover\s+\.map-node__fold-dot\s*\{/);
    expect(outsideBlocks).toMatch(/\.review-seek\[data-pointing\]/);
  });
});

describe("styles.css: 変わったノードの強調", () => {
  it("赤い枠（outline）と map-node--changed の規則がない", () => {
    expect(css).not.toContain("map-node--changed");
    expect(css).not.toMatch(/outline\s*:\s*[^;]*#dc2626/i);
    expect(css).not.toMatch(/#dc2626/i);
  });

  it("枠・影を足さない（box-shadow は none のまま）", () => {
    for (const m of css.matchAll(/box-shadow\s*:\s*([^;]+);/g)) expect(m[1]!.trim()).toBe("none");
    expect(css).not.toMatch(/--tw-shadow|--shadow-/);
  });

  it("点滅は 1 秒周期で 3 回、ノードの塗りと枠だけを変え、文字は薄くしない（opacity を使わない）", () => {
    expect(rule(".map-node--blink")).toMatch(/animation\s*:[^;]*\b1s\b[^;]*\s3;/); // 1 秒周期を 3 回
    const frames = css.match(/@keyframes map-node-blink\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? "";
    expect(frames).toMatch(/background-color/);
    expect(frames).toMatch(/border-color/);
    expect(frames).not.toMatch(/opacity|(?<!-)color\s*:/);
    expect(css).not.toContain("map-node__flash");
  });

  it("変わったノードには細い黄色の枠を outline で付ける（実寸を変えない）。点滅は animate-* のユーティリティにしない", () => {
    expect(rule(".map-node--blink")).toMatch(/outline\s*:\s*1\.5px solid #facc15/i);
    expect(css).not.toMatch(/--animate-/);
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

  it("カーソルは 1 秒周期で止まらず点滅し、@keyframes は層の外。animate-* のユーティリティにしない", () => {
    expect(rule(".captions__cursor")).toMatch(/animation\s*:[^;]*\b1s\b[^;]*\binfinite\b/);
    const outsideBlocks = css.replace(/@layer\s+[\w-]+\s*\{[\s\S]*?\n\}/g, "");
    expect(outsideBlocks).toMatch(/@keyframes\s+[\w-]+\s*\{[^@]*\}\s*\}/);
    const name = rule(".captions__cursor").match(/animation\s*:\s*([\w-]+)/)?.[1] ?? "";
    expect(name).not.toBe("");
    expect(outsideBlocks).toMatch(new RegExp(`@keyframes\\s+${name}\\b`));
    expect(css).not.toMatch(/--animate-/);
    // 参照先の keyframes が、可視状態を切り替える（点滅する）定義であること
    expect(outsideBlocks).toMatch(new RegExp(`@keyframes\\s+${name}\\b[^{]*\\{[^@]*visibility\\s*:\\s*hidden`));
  });

  it("prefers-reduced-motion: reduce のときは、カーソルを点滅させずに出したままにする（animation: none）", () => {
    const m = css.match(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([\s\S]*?\.captions__cursor\s*\{[^}]*\})/);
    expect(m?.[1] ?? "").toMatch(/\.captions__cursor\s*\{[^}]*animation\s*:\s*none/);
  });

  it("仮のノードの規則はない", () => {
    expect(css).not.toContain(".draft-node");
  });

  it("字幕は窓の中央に固定する幅が min(720px, 100vw − 2 × 316px)（右の列にかからない）。見返しの操作の行に重ならないよう fixed にしない", () => {
    const r = rule(".captions");
    expect(r).toMatch(new RegExp(`width\\s*:\\s*${WIDTH_FORMULA.source}`));
    expect(r).not.toMatch(/position\s*:\s*fixed/);
    expect(rule(".intake-notice")).not.toMatch(/position\s*:\s*fixed/);
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

  it("相手の音声が届かない一文（Issue #863）は、字幕の左に置く式で、バッジ・影・枠・背景を付けず、10 秒で消えるアニメーションを持たない", () => {
    const r = rule(".tap-notice");
    expect(r).not.toBe("");
    expect(r).toMatch(/right\s*:[^;]*50%[^;]*min\(\s*720px\s*,\s*calc\(\s*100vw\s*-\s*2\s*\*\s*316px\s*\)\s*\)/);
    expect(r).not.toMatch(/position\s*:\s*fixed/);
    expect(r).not.toMatch(/box-shadow\s*:\s*(?!\s*none)/);
    expect(r).not.toMatch(/border\s*:|background(-color)?\s*:/);
    expect(r).not.toMatch(/animation/);
  });

  it("取り込みの一言（intake-notice）と相手の音声が届かない一文（tap-notice）は、字幕の左右の反対側に置く", () => {
    const side = (r: string) => (/(^|[\s;])right\s*:/.test(r) ? "right" : /(^|[\s;])left\s*:/.test(r) ? "left" : "none");
    expect(side(rule(".tap-notice"))).not.toBe("none");
    expect(side(rule(".tap-notice"))).not.toBe(side(rule(".intake-notice")));
  });
});

describe("styles.css: 選んだノード", () => {
  it("塗りを薄い灰色にする（背景色の指定がある）", () => {
    expect(rule(".map-node--selected")).toMatch(/background(?:-color)?\s*:\s*(?:#(?:[ef][0-9a-f]){3}|#[ef][0-9a-f]{2}|rgb)/i);
  });

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
  it("ホバーしたときだけ出す規則が子孫のセレクタで素の CSS にある（group-hover のユーティリティにしない）", () => {
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
