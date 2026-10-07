import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReviewControls } from "../src/ReviewControls.tsx";

// シークバー（Video.js）とアイコンはこのテストの契約ではない。サーバー側の描画で確実に出るよう、
// 中身のない代役にする。アイコンは名前を data-icon に出して、どれが描かれたかを区別する。
vi.mock("@videojs/react", () => {
  const Part = ({ children }: { children?: unknown }) => <div>{children as never}</div>;
  return { Slider: { Root: Part, Track: Part, Thumb: Part, Preview: Part, Value: Part } };
});
vi.mock("@videojs/react/icons", () => {
  const icon = (name: string) => () => <svg data-icon={name} />;
  return {
    CaptionsOnIcon: icon("CaptionsOnIcon"),
    CaptionsOffIcon: icon("CaptionsOffIcon"),
    CheckIcon: icon("CheckIcon"),
    PauseIcon: icon("PauseIcon"),
    PlayIcon: icon("PlayIcon"),
    SpeedIcon: icon("SpeedIcon"),
  };
});

const noop = () => {};
const base = {
  time: 30,
  duration: 100,
  playing: false,
  rate: 30,
  rates: [10, 30, 60, 120] as readonly number[],
  topicName: "採用",
  chapters: [],
  marks: [],
  captionsHidden: false,
  sideHidden: false,
  onSeek: noop,
  onToggle: noop,
  onPrev: noop,
  onNext: noop,
  onRate: noop,
  onCaptions: noop,
  onSide: noop,
};
const render = (over: Partial<typeof base> = {}) => renderToStaticMarkup(<ReviewControls {...base} {...over} />);

// aria-label が label のボタン 1 つ分の markup
const buttonOf = (html: string, label: string) => {
  const start = html.indexOf(`aria-label="${label}"`);
  expect(start, `${label} のボタン`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", start);
  return html.slice(open, html.indexOf("</button>", start) + "</button>".length);
};
const tipOf = (button: string) => /<span class="review-tip"[^>]*>([^<]*)<\/span>/.exec(button)?.[1];
const barOf = (html: string) => html.slice(html.indexOf('class="review-bar"'));

describe("ReviewControls: 操作の行の右は 字幕 → 速さ → 右の列 の順", () => {
  it("速さの並びが 2 つ以上のとき、字幕のボタン・速さのボタン・右の列のボタンの順に並ぶ", () => {
    const bar = barOf(render());
    const caption = bar.indexOf('aria-label="字幕"');
    const rate = bar.indexOf('aria-label="再生の速さ"');
    const side = bar.indexOf('aria-label="右の列"');
    expect(caption).toBeGreaterThan(-1);
    expect(rate).toBeGreaterThan(caption);
    expect(side).toBeGreaterThan(rate);
  });

  it("3 つとも、時刻と議題の名前より後ろ（行の右）にある", () => {
    const bar = barOf(render());
    const topic = bar.indexOf("review-bar__topic");
    expect(topic).toBeGreaterThan(-1);
    expect(bar.indexOf('aria-label="字幕"')).toBeGreaterThan(topic);
    expect(bar.indexOf('aria-label="右の列"')).toBeGreaterThan(topic);
  });

  it("3 つは右寄せのまとまり（review-bar__end）の中にある", () => {
    const bar = barOf(render());
    const end = bar.indexOf("review-bar__end");
    expect(end).toBeGreaterThan(-1);
    expect(bar.indexOf('aria-label="字幕"')).toBeGreaterThan(end);
    expect(bar.indexOf('aria-label="再生の速さ"')).toBeGreaterThan(end);
    expect(bar.indexOf('aria-label="右の列"')).toBeGreaterThan(end);
  });

  it("速さの並びが 1 つ（音声つき）なら速さは出ず、字幕 → 右の列の順で残る", () => {
    const bar = barOf(render({ rates: [1], rate: 1 }));
    expect(bar).not.toContain("再生の速さ");
    expect(bar.indexOf('aria-label="字幕"')).toBeGreaterThan(-1);
    expect(bar.indexOf('aria-label="右の列"')).toBeGreaterThan(bar.indexOf('aria-label="字幕"'));
  });

  it("字幕・右の列のボタンは button 要素で、操作の行（シークバーの外）にある", () => {
    const html = render();
    expect(buttonOf(html, "字幕")).toMatch(/^<button type="button"/);
    expect(buttonOf(html, "右の列")).toMatch(/^<button type="button"/);
    expect(html.indexOf('aria-label="字幕"')).toBeGreaterThan(html.indexOf('class="review-bar"'));
  });
});

describe("ReviewControls: 字幕のアイコンは出し入れの状態で変わる", () => {
  it("字幕が出ているときは CaptionsOnIcon、隠しているときは CaptionsOffIcon", () => {
    expect(buttonOf(render({ captionsHidden: false }), "字幕")).toContain('data-icon="CaptionsOnIcon"');
    expect(buttonOf(render({ captionsHidden: false }), "字幕")).not.toContain("CaptionsOffIcon");
    expect(buttonOf(render({ captionsHidden: true }), "字幕")).toContain('data-icon="CaptionsOffIcon"');
    expect(buttonOf(render({ captionsHidden: true }), "字幕")).not.toContain("CaptionsOnIcon");
  });

  it("字幕・右の列のボタンは表示中なら aria-pressed=true、隠しているなら false", () => {
    expect(buttonOf(render({ captionsHidden: false }), "字幕")).toContain('aria-pressed="true"');
    expect(buttonOf(render({ captionsHidden: true }), "字幕")).toContain('aria-pressed="false"');
    expect(buttonOf(render({ sideHidden: false }), "右の列")).toContain('aria-pressed="true"');
    expect(buttonOf(render({ sideHidden: true }), "右の列")).toContain('aria-pressed="false"');
  });

  it("右の列のボタンは svg のアイコンを持ち、隠している・いないで表示が変わる", () => {
    const shown = buttonOf(render({ sideHidden: false }), "右の列");
    const hidden = buttonOf(render({ sideHidden: true }), "右の列");
    expect(shown).toContain("<svg");
    expect(hidden).toContain("<svg");
    expect(shown).not.toBe(hidden);
  });
});

describe("ReviewControls: ポインタを乗せると名前とキーを出す", () => {
  it("反映 1 つ戻る（,）・反映 1 つ進む（.）", () => {
    const html = render();
    expect(tipOf(buttonOf(html, "反映 1 つ戻る"))).toBe("反映 1 つ戻る（,）");
    expect(tipOf(buttonOf(html, "反映 1 つ進む"))).toBe("反映 1 つ進む（.）");
  });

  it("▶ は止まっているとき『再生（Space・K）』、再生中は『止める（Space・K）』", () => {
    expect(tipOf(buttonOf(render({ playing: false }), "再生"))).toBe("再生（Space・K）");
    expect(tipOf(buttonOf(render({ playing: true }), "止める"))).toBe("止める（Space・K）");
  });

  it("字幕（C）・右の列（E）", () => {
    const html = render();
    expect(tipOf(buttonOf(html, "字幕"))).toBe("字幕（C）");
    expect(tipOf(buttonOf(html, "右の列"))).toBe("右の列（E）");
  });

  it("速さは『速さ（< >）』（< > は HTML の文字参照で出る）", () => {
    const tip = tipOf(buttonOf(render(), "再生の速さ"));
    expect(tip).toBe("速さ（&lt; &gt;）");
  });

  it("操作の行のボタンは全て名前とキーを持つ（吹き出しのないボタンが無い）", () => {
    const bar = barOf(render());
    const buttons = bar.match(/<button\b[^>]*review-bar__button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(6);
    for (const b of buttons) expect(tipOf(b), b).toMatch(/（.+）$/);
  });

  it("吹き出しは読み上げに二重に出さない（aria-hidden）。ボタンの名前は aria-label のまま", () => {
    const html = render();
    expect(buttonOf(html, "字幕")).toMatch(/<span class="review-tip" aria-hidden="true">/);
    expect(html).toContain('aria-label="反映 1 つ戻る"');
    expect(html).toContain('aria-label="反映 1 つ進む"');
  });
});
