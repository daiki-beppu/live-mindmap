import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 見返しの操作の行（Issue #825）の、ファイルとして確かめるもの: Slider・Tooltip・Menu と今のスタイルシートのぶつかりを直す CSS（controls.css）、
// 今の web/src/styles.css を変えないこと、video.js のアイコンの出どころとライセンスの表示（icons.NOTICE.md）。
// 実ブラウザでの見た目（位置・重なり・スクリーンショットの差）は、画面の照合の heavy IT（screenCompare.heavy.test.ts、#826）が見る

const webRoot = join(import.meta.dirname, "..");
const reviewDir = join(webRoot, "src/app/review");
const read = (...path: string[]) => readFileSync(join(...path), "utf8");

// ファイルが無いときに、無関係なテストまで読み込みで落ちないよう、読むのはテストの中
const controlsCss = () => read(reviewDir, "controls.css");
const stylesCss = () => read(webRoot, "src/styles.css");

// CSS の規則（セレクタの並び → 宣言）を取り出す。コメントは落とす。@media などの入れ子は扱わない（controls.css・styles.css の対象の規則は入れ子の外）
const rulesOf = (css: string): Array<{ selectors: string[]; body: string }> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")), body: m[2]!.replace(/\s+/g, " ") }));
const declarationsFor = (css: string, matches: (selector: string) => boolean): string =>
  rulesOf(css)
    .filter((rule) => rule.selectors.some(matches))
    .map((rule) => rule.body)
    .join(" ");
const declarationsOf = (css: string, selector: string): string => declarationsFor(css, (s) => s === selector);

describe("controls.css: Slider・Tooltip・Menu と今のスタイルシートのぶつかりを Foldkit 側で直す", () => {
  it("Slider の track の束を付ける包み要素（.review-slider-hit）は、inline の position:relative に勝って絶対配置になり、バー全体を覆う（押せる範囲）", () => {
    const body = declarationsOf(controlsCss(), ".review-slider-hit");
    expect(body).toMatch(/position\s*:\s*absolute\s*!important/);
    const covers = /inset\s*:\s*0(px)?(\s*!important)?\s*;/.test(body) || ["top", "left", "right", "bottom"].every((side) => new RegExp(`${side}\\s*:\\s*0(px)?\\b`).test(body));
    expect(covers, body).toBe(true);
  });

  it("つまみの左のずらし（styles.css の margin-left: -6px）を 0 にする: Slider の translateX(-50%) と二重にずれるため（シークバーと音量の両方）", () => {
    for (const selector of [".review-seek__thumb", ".review-volume__thumb"]) expect(declarationsOf(controlsCss(), selector), selector).toMatch(/margin-left\s*:\s*0(px)?\b/);
  });

  it("速さのメニューの外側（.review-rate__backdrop）は、画面いっぱいに fixed で広がる（大きさが 0 だと外側のクリックを受けられない）", () => {
    const body = declarationsOf(controlsCss(), ".review-rate__backdrop");
    expect(body).toMatch(/position\s*:\s*fixed/);
    const covers = /inset\s*:\s*0(px)?\b/.test(body) || ["top", "left", "right", "bottom"].every((side) => new RegExp(`${side}\\s*:\\s*0(px)?\\b`).test(body));
    expect(covers, body).toBe(true);
    expect(body).toMatch(/z-index\s*:\s*\d+/);
  });

  it("吹き出しは、開いている間（data-open）だけ出す: Tooltip の panel は常に描くので、今の .review-tip の display: none を開いたときに打ち消す", () => {
    const body = declarationsFor(controlsCss(), (s) => s.includes(".review-tip") && s.includes("[data-open]"));
    expect(body).toMatch(/display\s*:\s*block/);
    // 開いていないときの規則を controls.css が上書きしない（開いていない吹き出しを出さない）
    expect(declarationsOf(controlsCss(), ".review-tip")).not.toMatch(/display\s*:\s*(block|flex|inline)/);
  });
});

describe("web/src/styles.css は変えない（載せ替えの間は今のスタイルシートをそのまま使う）", () => {
  it("今の規則が残っている: つまみの margin-left: -6px、吹き出しの display: none、速さのメニューの規則", () => {
    expect(declarationsOf(stylesCss(), ".review-seek__thumb")).toMatch(/margin-left\s*:\s*-6px/);
    expect(declarationsOf(stylesCss(), ".review-volume__thumb")).toMatch(/margin-left\s*:\s*-6px/);
    expect(declarationsOf(stylesCss(), ".review-tip")).toMatch(/display\s*:\s*none/);
    expect(declarationsOf(stylesCss(), ".review-rate__menu")).toMatch(/position\s*:\s*absolute/);
  });

  it("Foldkit 側の直しのための規則（包み要素・外側・data-open）は styles.css に入れていない", () => {
    expect(stylesCss()).not.toContain("review-slider-hit");
    expect(stylesCss()).not.toContain("review-rate__backdrop");
    expect(stylesCss()).not.toMatch(/\.review-tip\[data-open\]/);
  });
});

describe("アイコン: video.js のものを写す。出どころとライセンスを残す", () => {
  const notice = () => read(reviewDir, "icons.NOTICE.md");

  it("icons.NOTICE.md に、写したアイコンの出どころ（video.js・@videojs/react）と著作権表示、Apache License 2.0 の全文が入る", () => {
    const text = notice();
    expect(text).toMatch(/video\.?js/i);
    expect(text).toContain("@videojs/react");
    expect(text).toContain("Copyright 2025-present Video.js contributors");
    expect(text).toContain("Apache-2.0");
    expect(text).toContain('Licensed under the Apache License, Version 2.0 (the "License");');
    expect(text).toContain("http://www.apache.org/licenses/LICENSE-2.0");
    expect(text).toContain('distributed under the License is distributed on an "AS IS" BASIS');
    expect(text).toContain("limitations under the License.");
  });

  it("出どころは、アイコンを写したことを言う（出どころのコメントだけで済ませず、HTML に残す文言である）", () => {
    const text = notice();
    expect(text).toMatch(/アイコン|icon/i);
    expect(text.trim().length).toBeGreaterThan(500);
  });
});
