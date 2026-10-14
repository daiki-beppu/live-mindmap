import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 見返しの操作の行（Issue #825）の、ファイルとして確かめるもの: Menu・Tooltip の状態の規則（素の CSS に残す）、video.js のアイコンの出どころとライセンスの表示（icons.NOTICE.md）。
// Slider・Tooltip・Menu と見た目のぶつかりを直す値（つまみの margin-left、包み要素の絶対配置、外側の fixed など）は、Tailwind に替えた後（Issue #830）は
// ユーティリティと素の CSS のどちらにも置けるので、置き場に依らない実ブラウザの computed style で確かめる（review.mount.heavy.test.ts の寸法）。
// 実ブラウザでの見た目（位置・重なり・スクリーンショットの差）は、画面の照合の heavy IT（screenCompare.heavy.test.ts、#826）が見る

const webRoot = join(import.meta.dirname, "..");
const reviewDir = join(webRoot, "src/app/review");
const read = (...path: string[]) => readFileSync(join(...path), "utf8");

// 素の CSS は web/src の下の全 .css に分かれうる（入口の styles.css・controls.css・keyList.css）。どれに置いても、状態の規則があることを確かめる
const cssFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? cssFiles(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []));
const allCss = () => cssFiles(join(webRoot, "src")).map((file) => readFileSync(file, "utf8")).join("\n");

// CSS の規則（セレクタの並び → 宣言）を取り出す。コメントは落とす。@media などの入れ子は扱わない（対象の規則は入れ子の外）
const rulesOf = (css: string): Array<{ selectors: string[]; body: string }> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")), body: m[2]!.replace(/\s+/g, " ") }));
const declarationsFor = (css: string, matches: (selector: string) => boolean): string =>
  rulesOf(css)
    .filter((rule) => rule.selectors.some(matches))
    .map((rule) => rule.body)
    .join(" ");

describe("素の CSS に残す Tooltip・Menu の状態の規則", () => {
  it("吹き出しは、開いている間（data-open）だけ出す: Tooltip の panel は常に描くので、開いたときに display: block にする規則が素の CSS にある", () => {
    expect(declarationsFor(allCss(), (s) => s.includes(".review-tip") && s.includes("[data-open]"))).toMatch(/display\s*:\s*block/);
  });

  it("開いていない吹き出しを出さない: .review-tip の基本の規則は display を block・flex・inline にしない", () => {
    expect(declarationsFor(allCss(), (s) => s === ".review-tip")).not.toMatch(/display\s*:\s*(block|flex|inline)/);
  });

  it("矢印キーなどで選んでいる項目（data-active）の強調が素の CSS にある: :hover・:focus-visible と同じ色 #4b5563（token でも可）", () => {
    const body = declarationsFor(allCss(), (s) => s.includes(".review-rate__item") && s.includes("[data-active]"));
    expect(body).toMatch(/background(-color)?\s*:\s*(#4b5563|var\(--color-gray-600\))/i);
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
