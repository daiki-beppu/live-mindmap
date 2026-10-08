import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AUDIO_KEY_LIST, KEY_LIST, KeyList, REVIEW_KEY_LIST } from "../src/KeyList.tsx";

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

describe("KeyList: Z（選んだノードへ寄る）", () => {
  it("Z の行が、選んだノードと子孫が収まるまで寄る説明つきで載る", () => {
    const row = KEY_LIST.find((r) => r.keys === "Z");
    expect(row).toBeDefined();
    expect(row!.action).toContain("選んだノード");
    expect(row!.action).toContain("寄");
    expect(renderToStaticMarkup(<KeyList />)).toContain(row!.action);
  });

  it("見返しの一覧にも同じ行が載る（ライブ・見返しの両方で使うキー）", () => {
    expect(renderToStaticMarkup(<KeyList review />)).toContain(KEY_LIST.find((r) => r.keys === "Z")!.action);
  });
});

describe("KeyList: 見返しのキーは見返しの一覧にだけ載る", () => {
  const live = renderToStaticMarkup(<KeyList />);
  const review = renderToStaticMarkup(<KeyList review />);
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  it("見返しの行は Space・K / J / L / , . / < > / Home End の 5 行", () => {
    expect(REVIEW_KEY_LIST.map((r) => r.keys)).toEqual(["Space・K", "J / L", ", / .", "< / >", "Home / End"]);
    expect(REVIEW_KEY_LIST.find((r) => r.keys === "Space・K")?.action).toContain("止める");
    expect(REVIEW_KEY_LIST.find((r) => r.keys === "J / L")?.action).toContain("10 秒");
    expect(REVIEW_KEY_LIST.find((r) => r.keys === ", / .")?.action).toContain("反映");
    expect(REVIEW_KEY_LIST.find((r) => r.keys === "< / >")?.action).toContain("速さ");
    expect(REVIEW_KEY_LIST.find((r) => r.keys === "Home / End")?.action).toContain("最初");
  });

  it("見返しの一覧には、見返しの 5 行が載る", () => {
    for (const row of REVIEW_KEY_LIST) {
      expect(review).toContain(esc(row.keys));
      expect(review).toContain(esc(row.action));
    }
  });

  it("見返しの一覧には、ライブの全ての行も載ったままになる", () => {
    for (const row of KEY_LIST) expect(review).toContain(esc(row.keys));
  });

  it("C（字幕）の行は 1 回だけ（二重に載せない）", () => {
    expect(review.match(/>C<\/span>/g)).toHaveLength(1);
    expect(live.match(/>C<\/span>/g)).toHaveLength(1);
    expect(REVIEW_KEY_LIST.some((r: { keys: string }) => r.keys === "C")).toBe(false);
  });

  it("ライブの一覧（引数なし・review: false）には見返しのキーは載らない", () => {
    for (const html of [live, renderToStaticMarkup(<KeyList review={false} />)]) {
      for (const row of REVIEW_KEY_LIST) expect(html).not.toContain(esc(row.keys));
      expect(html).not.toContain("Home / End");
    }
  });

  it("KEY_LIST そのものには見返しの行を足さない", () => {
    expect(KEY_LIST.some((r: { keys: string }) => r.keys === "J / L" || r.keys === "Home / End" || r.keys === "Space・K")).toBe(false);
  });

  it("見返しの行は『キー』の行の後、マウスの行の前に挟む", () => {
    const at = (t: string) => review.indexOf(t);
    expect(at("Home / End")).toBeGreaterThan(at(">?</span>"));
    expect(at("Space・K")).toBeLessThan(at("スクロール"));
    expect(at("Home / End")).toBeLessThan(at("スクロール"));
  });
});

describe("KeyList: M（ミュート）の行は音声つきの見返しの一覧にだけ載る", () => {
  const audio = renderToStaticMarkup(<KeyList review audio />);
  const review = renderToStaticMarkup(<KeyList review />);
  const live = renderToStaticMarkup(<KeyList />);
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  it("M の行は『ミュート・戻す』で、1 行だけ", () => {
    expect(AUDIO_KEY_LIST).toEqual([{ group: "キー", keys: "M", action: "ミュート・戻す" }]);
  });

  it("音声つきの見返しの一覧には M の行が載る", () => {
    expect(audio).toContain(">M</span>");
    expect(audio).toContain("ミュート・戻す");
  });

  it("音声つきの一覧にも、見返しの行とライブの全ての行は載ったまま（C は 1 回だけ）", () => {
    for (const row of [...KEY_LIST, ...REVIEW_KEY_LIST]) expect(audio).toContain(esc(row.keys));
    expect(audio.match(/>C<\/span>/g)).toHaveLength(1);
  });

  it("M の行は見返しの行の後、マウスの行の前に挟む", () => {
    const at = (t: string) => audio.indexOf(t);
    expect(at(">M</span>")).toBeGreaterThan(at("Home / End"));
    expect(at(">M</span>")).toBeLessThan(at("スクロール"));
  });

  it("音声なしの見返しの一覧には載らない（音声つきでは載る）", () => {
    expect(audio).toContain(">M</span>");
    expect(review).not.toContain(">M</span>");
    expect(review).not.toContain("ミュート");
    expect(renderToStaticMarkup(<KeyList review audio={false} />)).not.toContain(">M</span>");
  });

  it("ライブの一覧には載らない。audio だけを渡しても、見返しでなければ載らない", () => {
    expect(audio).toContain("ミュート・戻す");
    expect(live).not.toContain(">M</span>");
    expect(live).not.toContain("ミュート");
    expect(renderToStaticMarkup(<KeyList audio />)).not.toContain("ミュート");
  });

  it("KEY_LIST・REVIEW_KEY_LIST そのものには M の行を足さない", () => {
    expect(KEY_LIST.some((r: { keys: string }) => r.keys === "M")).toBe(false);
    expect(REVIEW_KEY_LIST.some((r: { keys: string }) => r.keys === "M")).toBe(false);
  });
});
