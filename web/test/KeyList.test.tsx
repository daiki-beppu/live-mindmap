import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KEY_LIST, KeyList } from "../src/KeyList.tsx";

describe("KeyList: ? で開くキー一覧", () => {
  const html = renderToStaticMarkup(<KeyList />);

  it("key-list の class で出る", () => {
    expect(html).toContain("key-list");
  });

  it("行は配列の定数にまとまり、全ての行が描かれる", () => {
    expect(Array.isArray(KEY_LIST)).toBe(true);
    expect(KEY_LIST.length).toBeGreaterThanOrEqual(15);
    for (const row of KEY_LIST) {
      expect(row.keys.length).toBeGreaterThan(0);
      expect(html).toContain(row.keys.replace(/&/g, "&amp;"));
    }
  });

  it("キー: Esc F = - ^ 0 Shift ? が載る", () => {
    for (const k of ["Esc", "F", "=", "-", "^", "0", "Shift", "?"]) expect(html).toContain(k);
    expect(html).toContain("JIS");
  });

  it("E（右の列）と C（字幕）の行が、出す・隠すの説明つきで載る", () => {
    const row = (k: string) => KEY_LIST.find((r) => r.keys === k);
    expect(row("E")?.action).toContain("右の列");
    expect(row("C")?.action).toContain("字幕");
    expect(html).toContain("右の列");
    expect(html).toContain("字幕");
  });

  it("マウス・トラックパッド: スクロール・ドラッグ・ピンチ・クリック・縁の点が載る", () => {
    for (const w of ["スクロール", "ドラッグ", "ピンチ", "クリック", "縁の点"]) expect(html).toContain(w);
  });

  it("バッジは出さない", () => {
    expect(html).not.toContain("badge");
  });

  it("操作と説明が対応する行で出る", () => {
    const row = (keys: string) => KEY_LIST.find((r) => r.keys.includes(keys))?.action ?? "";
    expect(row("Shift + スクロール")).toContain("一方だけ");
    expect(row("Shift + スクロール")).not.toContain("拡大");
    expect(row("クリック /")).toContain("押したところを中心");
    expect(row("ノードのクリック")).toContain("根拠");
    expect(row("Shift + 矢印")).toContain("1/3");
    expect(html).toContain("押したところを中心に拡大 / 縮小");
  });

  it("矢印（Shift なし）の行が、ノードを選ぶ説明つきで載り、Shift + 矢印の行とは別になる", () => {
    const arrows = KEY_LIST.find((r) => r.keys === "← → ↑ ↓");
    expect(arrows).toBeDefined();
    expect(arrows!.action).toContain("選ぶ");
    expect(arrows!.action).toContain("Esc");
    expect(html).toContain("← → ↑ ↓");
    expect(KEY_LIST.filter((r) => r.keys.includes("矢印") || r.keys.includes("←"))).toHaveLength(2);
    expect(KEY_LIST.find((r) => r.keys === "Shift + 矢印")?.action).toContain("1/3");
  });
});
