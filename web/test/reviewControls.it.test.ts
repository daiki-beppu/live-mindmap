import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = join(import.meta.dirname, "..");
const reviewDir = join(webRoot, "src/app/review");
const read = (...path: string[]) => readFileSync(join(...path), "utf8");

const cssFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? cssFiles(join(dir, entry.name)) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []));
const allCss = () => cssFiles(join(webRoot, "src")).map((file) => readFileSync(file, "utf8")).join("\n");

const rulesOf = (css: string): Array<{ selectors: string[]; body: string }> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")), body: m[2]!.replace(/\s+/g, " ") }));
const declarationsFor = (css: string, matches: (selector: string) => boolean): string =>
  rulesOf(css)
    .filter((rule) => rule.selectors.some(matches))
    .map((rule) => rule.body)
    .join(" ");

describe("素の CSS に残す Tooltip・Menu の状態の規則", () => {
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
