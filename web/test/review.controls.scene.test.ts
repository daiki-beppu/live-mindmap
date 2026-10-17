import * as Menu from "@foldkit/ui/menu";
import * as Slider from "@foldkit/ui/slider";
import { Duration } from "effect";
import { all, blur, click, expect as expectScene, expectHandled, findAll, focus, given, hover, keydown, Mount, nth, pointerDown, scene, selector, Subscription, tap, textContent } from "foldkit/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeContext } from "../src/app/review/context.ts";
import { snapshotOf } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { ObserveAudio, ObserveSeekPointer } from "../src/app/review/mount.ts";
import { SlideCaptions } from "../src/app/sessionLayout/mount.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { KIND_COLOR } from "../src/kinds.ts";
import { AUDIO_RATES, PLAYBACK_RATES, rateItemLabel } from "../src/reviewPlayback.ts";
import { topicNameOf } from "../src/reviewTimeline.ts";
import { VIDEOJS_ICONS, type IconNode } from "./fixtures/videojsIcons.ts";
import {
  appOf,
  argsOf,
  audioApp,
  audioContext,
  commandNames,
  descendants,
  DURATION,
  expectedIds,
  hasClass,
  labelled,
  plainApp,
  plainContext,
  settle,
  sideHiddenOf,
  singleRateContext,
  stateAt,
  tagOf,
  TOOLTIPS_AUDIO,
  TOOLTIPS_PLAIN,
  tooltipMounts,
  type Sim,
} from "./reviewHarness.ts";
import { attrOf, elementsOf, one, renderedIds, styleOf, type VNode } from "./sceneTree.ts";

// 見返しの操作の行（Issue #825）の Scene。描いた view から入り、シークバー・音量・速さのメニュー・ツールチップ・アイコン・字幕と右の列のボタンを
// ユーザーが触る形（キー・クリック・フォーカス・ポインタ）で確かめる。会議の長さは 200 秒、章は A（0〜100）・B（100〜200）、TODO の印は 160 秒。
// Scene は保留の Command を残したまま次の操作を流せず、終わりに Mount が残ると落ちるので、操作のたびに settle で Command と Mount を解く。
// 実ブラウザでの見た目・Floating UI の位置・本物のポインタの座標は、この Scene では確かめない

const seekThumb = selector('[aria-label="時刻"]');
const volumeThumb = selector('[aria-label="音量"]');
const rateButton = selector('[aria-label="再生の速さ"]');
const menu = selector('[role="menu"]');
const menuItems = all.selector('[role="menuitem"]');
const seekRoot = selector(".review-seek");
const labelSel = (label: string) => selector(`[aria-label="${label}"]`);

// Scene の pointerDown は、押した要素と祖先の写しを document.createElement で作る（node の unit 環境には document が無い）。
// blur は relatedTarget の型を調べるのに Element を参照する。どちらも写しを作るだけで、中身は使われない
const stubDomForPointer = () => {
  beforeEach(() => vi.stubGlobal("document", { createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }) }));
  afterEach(() => vi.unstubAllGlobals());
};
const stubElementForBlur = () => {
  beforeEach(() => vi.stubGlobal("Element", class {}));
  afterEach(() => vi.unstubAllGlobals());
};

const textOf = (vnode: VNode): string => textContent(vnode).replace(/\s+/g, " ").trim();
const barText = (html: VNode, className: string): string => textOf(one(html, `.${className}`));
const numberAttr = (html: VNode, css: string, name: string): number => Number(attrOf(one(html, css), name));

// 描いた木を先頭から順に歩き、操作の行の部品を出てきた順の名前にする
const BAR_LABELS = new Set(["反映 1 つ戻る", "再生", "止める", "反映 1 つ進む", "ミュート", "ミュートを戻す", "音量", "字幕", "再生の速さ", "右の列"]);
const barOrder = (html: VNode): string[] => {
  const out: string[] = [];
  const walk = (v: VNode) => {
    if (hasClass(v, "review-volume")) out.push("<音量の束>");
    if (hasClass(v, "review-bar__time")) out.push("<時刻>");
    if (hasClass(v, "review-bar__topic")) out.push("<議題>");
    if (hasClass(v, "review-bar__end")) out.push("<右のまとまり>");
    const label = attrOf(v, "aria-label");
    if (label !== undefined && BAR_LABELS.has(label)) out.push(label);
    for (const child of elementsOf(v)) walk(child);
  };
  walk(one(html, ".review-bar"));
  return out;
};
const docIndex = (html: VNode, css: string): number => {
  const target = one(html, css);
  let index = -1;
  let found = -1;
  const walk = (v: VNode) => {
    index += 1;
    if (v === target) found = index;
    for (const child of elementsOf(v)) walk(child);
  };
  walk(html);
  return found;
};

// ---- アイコン: video.js の写しと比べる（fixtures/videojsIcons.ts）----
const DROPPED_ROOT_ATTRS = new Set(["xmlns", "width", "height", "aria-hidden", "class", "style"]);
const normalizeNumber = (value: string): string => (/^-?\d*\.?\d+$/.test(value) ? String(Number(value)) : value);
const attrsOfNode = (vnode: VNode): Record<string, string> => {
  const data = (vnode.data ?? {}) as { attrs?: Record<string, unknown> };
  return Object.fromEntries(Object.entries(data.attrs ?? {}).map(([k, v]) => [k, normalizeNumber(String(v))]));
};
const canonical = (vnode: VNode, isRoot: boolean, keepRootSize: boolean): IconNode => ({
  tag: tagOf(vnode),
  attrs: Object.fromEntries(Object.entries(attrsOfNode(vnode)).filter(([k]) => keepRootSize || !(isRoot && DROPPED_ROOT_ATTRS.has(k)))),
  children: elementsOf(vnode).map((c) => canonical(c, false, keepRootSize)),
});
const iconIn = (vnode: VNode): VNode => {
  const svgs = findAll(vnode, "svg");
  if (svgs.length === 0) throw new Error("svg がない");
  return svgs[0]!;
};
const expectVideoJsIcon = (vnode: VNode, name: keyof typeof VIDEOJS_ICONS) => {
  const svg = iconIn(vnode);
  expect(canonical(svg, true, false), name).toEqual(VIDEOJS_ICONS[name]);
  expect(attrOf(svg, "aria-hidden"), `${name} は読み上げない`).toBe("true");
};
const iconOfButton = (html: VNode, label: string): VNode => iconIn(one(html, `[aria-label="${label}"]`));

// ---- ツールチップの文言（styles.css が当たる形）----
const TIPS: ReadonlyArray<readonly [label: string, text: string]> = [
  ["反映 1 つ戻る", "反映 1 つ戻る（,）"],
  ["再生", "再生（Space・K）"],
  ["反映 1 つ進む", "反映 1 つ進む（.）"],
  ["ミュート", "ミュート（M）"],
  ["字幕", "字幕（C）"],
  ["再生の速さ", "速さ（< >）"],
  ["右の列", "右の列（E）"],
];
const tipPanelOf = (html: VNode, label: string): VNode => {
  const id = attrOf(one(html, `[aria-label="${label}"]`), "aria-describedby");
  expect(id, `${label} のボタンは吹き出しを aria-describedby で指す`).toBeDefined();
  return one(html, `[id="${id}"]`);
};
const isOpenTip = (html: VNode, label: string): boolean => attrOf(tipPanelOf(html, label), "data-open") !== undefined;

describe("操作の行の並び・名前・class（styles.css が当たる形）", () => {
  it("録音つき: .review の中は セッションの領域 → 操作の行。操作の行の中は シークバー → 行（戻る・再生・進む・音量・時刻・議題・右のまとまり）", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      tap((sim) => {
        const review = one(sim.html, ".review");
        expect(elementsOf(review).map((v) => (hasClass(v, "review__session") ? "session" : hasClass(v, "review-controls") ? "controls" : "other")).filter((n) => n !== "other")).toEqual(["session", "controls"]);
        expect(findAll(one(sim.html, ".review__session"), ".map-surface")).toHaveLength(1);
        expect(findAll(one(sim.html, ".review-controls"), ".map-surface")).toHaveLength(0);
        expect(docIndex(sim.html, ".review-seek")).toBeGreaterThan(docIndex(sim.html, ".review-controls"));
        expect(docIndex(sim.html, ".review-bar")).toBeGreaterThan(docIndex(sim.html, ".review-seek"));
        expect(barOrder(sim.html)).toEqual(["反映 1 つ戻る", "再生", "反映 1 つ進む", "<音量の束>", "ミュート", "音量", "<時刻>", "<議題>", "<右のまとまり>", "字幕", "再生の速さ", "右の列"]);
      }),
    );
  });

  it("録音なし: 音量とミュートを出さない（行は 戻る・再生・進む・時刻・議題・右のまとまり）", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      expectScene(selector(".review-volume")).not.toExist(),
      expectScene(volumeThumb).not.toExist(),
      expectScene(labelSel("ミュート")).not.toExist(),
      tap((sim) => expect(barOrder(sim.html)).toEqual(["反映 1 つ戻る", "再生", "反映 1 つ進む", "<時刻>", "<議題>", "<右のまとまり>", "字幕", "再生の速さ", "右の列"])),
    );
  });

  it("右のまとまり（.review-bar__end）の中は 字幕 → 速さ → 右の列 の順で、ほかのボタンは入らない", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      tap((sim) => {
        const end = one(sim.html, ".review-bar__end");
        const labels = findAll(end, "[aria-label]").map((v) => attrOf(v, "aria-label")).filter((l) => l !== undefined && BAR_LABELS.has(l));
        expect(labels).toEqual(["字幕", "再生の速さ", "右の列"]);
      }),
    );
  });

  it("速さの並びが 1 つだけなら、速さのボタンもメニューも出さない（字幕 → 右の列）。ツールチップはその分少ない", () => {
    scene(
      appOf(singleRateContext),
      given(stateAt(singleRateContext, 100)),
      Mount.expectExact(ObserveMapSurface, SlideCaptions, ObserveSeekPointer, ...tooltipMounts(TOOLTIPS_PLAIN - 1)),
      settle,
      expectScene(rateButton).not.toExist(),
      expectScene(selector(".review-rate")).not.toExist(),
      tap((sim) => expect(barOrder(sim.html)).toEqual(["反映 1 つ戻る", "再生", "反映 1 つ進む", "<時刻>", "<議題>", "<右のまとまり>", "字幕", "右の列"])),
    );
  });

  it("ボタンは review-bar__button、速さのボタンはさらに review-rate__button。時刻は「h:mm:ss / h:mm:ss」、議題はその時刻の議題の名前", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      tap((sim) => {
        for (const label of ["反映 1 つ戻る", "再生", "反映 1 つ進む", "ミュート", "字幕", "再生の速さ", "右の列"]) expect(hasClass(labelled(sim.html, label), "review-bar__button"), label).toBe(true);
        expect(hasClass(labelled(sim.html, "再生の速さ"), "review-rate__button")).toBe(true);
        expect(barText(sim.html, "review-bar__time")).toBe("0:01:40 / 0:03:20");
        const topic = topicNameOf(snapshotOf(audioContext, stateAt(audioContext, 100)));
        expect(topic).toBe("B");
        expect(barText(sim.html, "review-bar__topic")).toBe(topic);
      }),
    );
  });

  it("再生中は「止める」、止まっているときは「再生」の名前になる", () => {
    scene(plainApp, given(stateAt(plainContext, 100, { playing: true })), settle, expectScene(labelSel("止める")).toExist(), expectScene(labelSel("再生")).not.toExist());
    scene(plainApp, given(stateAt(plainContext, 100, { playing: false })), settle, expectScene(labelSel("再生")).toExist(), expectScene(labelSel("止める")).not.toExist());
  });

  it("起動時の Mount は 表示面・シークバーのポインタ・ボタンごとのツールチップ（録音つきはさらに <audio>）", () => {
    scene(audioApp, given(stateAt(audioContext, 100)), Mount.expectExact(ObserveMapSurface, SlideCaptions, ObserveAudio, ObserveSeekPointer, ...tooltipMounts(TOOLTIPS_AUDIO)), settle);
    scene(plainApp, given(stateAt(plainContext, 100)), Mount.expectExact(ObserveMapSurface, SlideCaptions, ObserveSeekPointer, ...tooltipMounts(TOOLTIPS_PLAIN)), settle);
  });
});

describe("シークバー: キーで時刻が動き、表示（時刻・議題・マップ）が追従する", () => {
  stubDomForPointer();
  it("名前「時刻」のスライダーは、最小 0・最大は会議の長さ・値は今の時刻を持つ", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      expectScene(seekThumb).toHaveAttr("role", "slider"),
      expectScene(seekThumb).toHaveAttr("aria-valuemin", "0"),
      expectScene(seekThumb).toHaveAttr("aria-valuemax", "200"),
      expectScene(seekThumb).toHaveAttr("aria-valuenow", "100"),
    );
  });

  it("Home で 0、End で 200、矢印で動く。どのキーも処理済み（既定の動きを止める）で、時刻・議題・マップが追従する", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      keydown(seekThumb, "Home"),
      expectHandled(),
      settle,
      expectScene(seekThumb).toHaveAttr("aria-valuenow", "0"),
      tap((sim) => {
        expect(barText(sim.html, "review-bar__time")).toBe("0:00:00 / 0:03:20");
        expect(barText(sim.html, "review-bar__topic")).toBe(topicNameOf(snapshotOf(plainContext, stateAt(plainContext, 0))));
        expect(renderedIds(sim.html).sort()).toEqual(expectedIds(plainContext, 0).sort());
      }),
      keydown(seekThumb, "ArrowRight"),
      expectHandled(),
      settle,
      tap((sim) => expect(numberAttr(sim.html, '[aria-label="時刻"]', "aria-valuenow")).toBeGreaterThan(0)),
      keydown(seekThumb, "End"),
      expectHandled(),
      settle,
      expectScene(seekThumb).toHaveAttr("aria-valuenow", "200"),
      tap((sim) => {
        expect(barText(sim.html, "review-bar__time")).toBe("0:03:20 / 0:03:20");
        expect(renderedIds(sim.html).sort()).toEqual(expectedIds(plainContext, DURATION).sort());
      }),
      keydown(seekThumb, "ArrowLeft"),
      expectHandled(),
      settle,
      tap((sim) => expect(numberAttr(sim.html, '[aria-label="時刻"]', "aria-valuenow")).toBeLessThan(200)),
    );
  });

  it("録音つきは、キーで動いた先を <audio> に書く Command（SeekAudio）が出る", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      keydown(seekThumb, "Home"),
      tap((sim: Sim) => {
        expect(commandNames(sim.commands)).toEqual(["SeekAudio"]);
        expect(argsOf(sim.commands, "SeekAudio")).toEqual([{ time: 0 }]);
      }),
      settle,
      expectScene(seekThumb).toHaveAttr("aria-valuenow", "0"),
    );
  });

  it("つまみを押すと .review-seek に data-dragging が付き、引いた位置へ時刻が動き、離すと外れる（引くのは文書の pointermove なので Subscription から届く）", () => {
    const drag = (message: Slider.Message) => Subscription.emit(Message.GotSeekSliderMessage({ message }));
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      expectScene(seekRoot).not.toHaveAttr("data-dragging"),
      pointerDown(seekThumb),
      settle,
      expectScene(seekRoot).toHaveAttr("data-dragging"),
      drag(Slider.Message.MovedDragPointer({ value: 50 })),
      settle,
      expectScene(seekThumb).toHaveAttr("aria-valuenow", "50"),
      tap((sim) => expect(barText(sim.html, "review-bar__time")).toBe("0:00:50 / 0:03:20")),
      drag(Slider.Message.ReleasedDragPointer()),
      expectScene(seekRoot).not.toHaveAttr("data-dragging"),
      expectScene(seekThumb).toHaveAttr("aria-valuenow", "50"),
    );
  });
});

describe("シークバーの track: 章・進み・決定と TODO の印", () => {
  const chaptersOf = (html: VNode) => findAll(one(html, ".review-seek"), ".review-seek__chapter");
  const progressOf = (chapter: VNode) => one(chapter, ".review-seek__progress");

  it("章ごとに .review-seek__chapter を置き、始まりの位置と幅（2px のすき間）を持つ。進みは時刻の章の中だけ、前の章は満タン・後ろの章は 0", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 150)),
      settle,
      tap((sim) => {
        const chapters = chaptersOf(sim.html);
        expect(chapters).toHaveLength(2);
        const [a, b] = chapters as [VNode, VNode];
        expect(styleOf(a)["left"]).toMatch(/^0(%|px)?$/);
        expect(styleOf(b)["left"]).toBe("50%");
        for (const chapter of chapters) expect(styleOf(chapter)["width"]).toMatch(/^calc\(\s*50%\s*-\s*2px\s*\)$/);
        expect(styleOf(progressOf(a))["width"]).toBe("100%");
        expect(styleOf(progressOf(b))["width"]).toBe("50%");
      }),
    );
  });

  it("時刻が最初なら進みは全部 0%、最後なら全部 100%（時刻に追従する）", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 150)),
      settle,
      keydown(seekThumb, "Home"),
      settle,
      tap((sim) => expect(chaptersOf(sim.html).map((c) => styleOf(progressOf(c))["width"])).toEqual(["0%", "0%"])),
      keydown(seekThumb, "End"),
      settle,
      tap((sim) => expect(chaptersOf(sim.html).map((c) => styleOf(progressOf(c))["width"])).toEqual(["100%", "100%"])),
    );
  });

  it("決定・TODO の印（.review-seek__mark）は反映の時刻の位置に、種別の色で置く", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      tap((sim) => {
        const marks = findAll(one(sim.html, ".review-seek"), ".review-seek__mark");
        expect(marks).toHaveLength(1);
        expect(styleOf(marks[0]!)["left"]).toBe("80%");
        expect(Object.values(styleOf(marks[0]!))).toContain(KIND_COLOR["TODO"]);
      }),
    );
  });

  const eventsWithoutTopic = [{ at: "a", type: "start", title: "定例" }, { at: "x", type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 60, text: "雑談です。" } }];

  it("章が無い会議は、区切らずに全幅の 1 本で描く。進みは時刻の割合、印は無い", () => {
    const context = makeContext(eventsWithoutTopic);
    scene(
      appOf(context),
      given(stateAt(context, 30)),
      settle,
      tap((sim) => {
        const chapters = chaptersOf(sim.html);
        expect(chapters).toHaveLength(1);
        expect(styleOf(chapters[0]!)["left"]).toMatch(/^0(%|px)?$/);
        expect(styleOf(chapters[0]!)["width"]).toBe("100%");
        expect(styleOf(progressOf(chapters[0]!))["width"]).toBe("50%");
        expect(findAll(one(sim.html, ".review-seek"), ".review-seek__mark")).toHaveLength(0);
      }),
    );
  });

  it("会議の長さが 0 でも、割り算で NaN を出さず、全幅の 1 本・進み 0%・印なしで描く", () => {
    const context = makeContext([{ at: "a", type: "start", title: "定例" }]);
    scene(
      appOf(context),
      given(stateAt(context, 0)),
      settle,
      tap((sim) => {
        const seek = one(sim.html, ".review-seek");
        const chapters = chaptersOf(sim.html);
        expect(chapters).toHaveLength(1);
        expect(styleOf(chapters[0]!)["width"]).toBe("100%");
        expect(styleOf(progressOf(chapters[0]!))["width"]).toBe("0%");
        expect(findAll(seek, ".review-seek__mark")).toHaveLength(0);
        const everyStyle = [seek, ...descendants(seek)].flatMap((v) => Object.values(styleOf(v)));
        expect(everyStyle.filter((value) => /NaN|Infinity/.test(value))).toEqual([]);
        expect(barText(sim.html, "review-bar__time")).toBe("0:00:00 / 0:00:00");
      }),
    );
  });
});

describe("ポインタの位置の章名と時刻のプレビュー", () => {
  const previewAt = (fraction: number, chapter: string, time: string) =>
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      expectScene(seekRoot).not.toHaveAttr("data-pointing"),
      Mount.resolve(ObserveSeekPointer, Message.MovedSeekPointer({ fraction })),
      expectScene(seekRoot).toHaveAttr("data-pointing"),
      expectScene(selector(".review-seek__preview-chapter")).toHaveText(chapter),
      expectScene(selector(".review-seek__preview-time")).toHaveText(time),
      settle,
    );

  it("シークバーの 25% は 50 秒（章 A・0:00:50）", () => previewAt(0.25, "A", "0:00:50"));
  it("75% は 150 秒（章 B・0:02:30）", () => previewAt(0.75, "B", "0:02:30"));
  it("章の境目ちょうど（50% = 100 秒）は後ろの章 B", () => previewAt(0.5, "B", "0:01:40"));
  it("左端は 0 秒（章 A）、右端は会議の長さ（最後の章 B・0:03:20）", () => {
    previewAt(0, "A", "0:00:00");
    previewAt(1, "B", "0:03:20");
  });

  it("ポインタがバーから離れると data-pointing が外れる（同じ画面の上で、乗せる → 離す）", () => {
    const pointing = plainApp.update(stateAt(plainContext, 100), Message.MovedSeekPointer({ fraction: 0.25 })).model;
    scene(
      plainApp,
      given(pointing),
      expectScene(seekRoot).toHaveAttr("data-pointing"),
      Mount.resolve(ObserveSeekPointer, Message.LeftSeekPointer()),
      expectScene(seekRoot).not.toHaveAttr("data-pointing"),
      settle,
    );
  });

  it("プレビューを見せても、時刻（再生の位置）は動かない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      Mount.resolve(ObserveSeekPointer, Message.MovedSeekPointer({ fraction: 0.9 })),
      expectScene(seekThumb).toHaveAttr("aria-valuenow", "100"),
      tap((sim) => expect(barText(sim.html, "review-bar__time")).toBe("0:01:40 / 0:03:20")),
      settle,
    );
  });
});

describe("音量: 録音つきだけ。Slider とミュートのボタン", () => {
  it("名前「音量」のスライダーは 0〜1 で、値は音量。ミュートのボタンの名前は「ミュート」", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      expectScene(volumeThumb).toHaveAttr("role", "slider"),
      expectScene(volumeThumb).toHaveAttr("aria-valuemin", "0"),
      expectScene(volumeThumb).toHaveAttr("aria-valuemax", "1"),
      expectScene(volumeThumb).toHaveAttr("aria-valuenow", "1"),
      expectScene(selector(".review-volume__fill")).toHaveStyle("width", "100%"),
      expectScene(labelSel("ミュート")).toExist(),
      expectScene(labelSel("ミュートを戻す")).not.toExist(),
    );
  });

  it("音量が半分なら値 0.5・塗りは 50%", () => {
    scene(audioApp, given(stateAt(audioContext, 100, { volume: 0.5 })), settle, expectScene(volumeThumb).toHaveAttr("aria-valuenow", "0.5"), expectScene(selector(".review-volume__fill")).toHaveStyle("width", "50%"));
  });

  it("ミュート中は、値と塗りが 0 になり、ボタンの名前は「ミュートを戻す」", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100, { muted: true, volume: 0.4 })),
      settle,
      expectScene(volumeThumb).toHaveAttr("aria-valuenow", "0"),
      expectScene(selector(".review-volume__fill")).toHaveStyle("width", "0%"),
      expectScene(labelSel("ミュートを戻す")).toExist(),
      expectScene(labelSel("ミュート")).not.toExist(),
    );
  });

  it("矢印で 0.05 刻みに下がり、<audio> に設定を書く Command が出る", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      keydown(volumeThumb, "ArrowLeft"),
      expectHandled(),
      tap((sim: Sim) => {
        expect(commandNames(sim.commands)).toEqual(["WriteAudioSettings"]);
        expect(argsOf(sim.commands, "WriteAudioSettings")).toEqual([{ rate: 1, muted: false, volume: 0.95 }]);
      }),
      settle,
      expectScene(volumeThumb).toHaveAttr("aria-valuenow", "0.95"),
      expectScene(selector(".review-volume__fill")).toHaveStyle("width", "95%"),
    );
  });

  it("ミュート中に矢印で上げると、ミュートが外れる（ボタンの名前が戻る）", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100, { muted: true, volume: 0.4 })),
      settle,
      keydown(volumeThumb, "ArrowRight"),
      settle,
      expectScene(volumeThumb).toHaveAttr("aria-valuenow", "0.05"),
      expectScene(labelSel("ミュート")).toExist(),
      expectScene(labelSel("ミュートを戻す")).not.toExist(),
    );
  });

  it("ミュートのボタンを押すと、ミュートが入り（名前が替わり）、<audio> に書き、フォーカスを外す。もう一度押すと戻る", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100, { volume: 0.4 })),
      settle,
      click(labelSel("ミュート")),
      tap((sim: Sim) => {
        expect(commandNames(sim.commands)).toEqual(["ReleaseFocus", "WriteAudioSettings"]);
        expect(argsOf(sim.commands, "WriteAudioSettings")).toEqual([{ rate: 1, muted: true, volume: 0.4 }]);
      }),
      settle,
      expectScene(labelSel("ミュートを戻す")).toExist(),
      expectScene(volumeThumb).toHaveAttr("aria-valuenow", "0"),
      click(labelSel("ミュートを戻す")),
      settle,
      expectScene(labelSel("ミュート")).toExist(),
      expectScene(volumeThumb).toHaveAttr("aria-valuenow", "0.4"),
    );
  });
});

describe("速さのメニュー（@foldkit/ui の Menu）", () => {
  const items = (html: VNode) => findAll(html, '[role="menuitem"]');

  it("ボタンは名前「再生の速さ」・aria-haspopup=menu・閉じている間は aria-expanded=false で、今の速さを「N×」で出す。メニューはまだ無い", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      expectScene(rateButton).toHaveAttr("aria-haspopup", "menu"),
      expectScene(rateButton).toHaveAttr("aria-expanded", "false"),
      expectScene(rateButton).toContainText("30×"),
      expectScene(menu).not.toExist(),
    );
    scene(audioApp, given(stateAt(audioContext, 100)), settle, expectScene(rateButton).toContainText("1×"));
  });

  it("押すとメニューが開く（aria-expanded=true）。項目は速さの並びの分で、文言は rateItemLabel。今の速さの項目だけ印（チェック）が付く", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      click(rateButton),
      settle,
      expectScene(menu).toExist(),
      expectScene(rateButton).toHaveAttr("aria-expanded", "true"),
      tap((sim) => {
        const rows = items(sim.html);
        expect(rows.map((row) => textOf(row))).toEqual(PLAYBACK_RATES.map((r) => rateItemLabel(r, DURATION, false)));
        const checks = rows.map((row) => findAll(row, ".review-rate__check").flatMap((c) => findAll(c, "svg")).length);
        expect(checks).toEqual(PLAYBACK_RATES.map((r) => (r === 30 ? 1 : 0)));
        expectVideoJsIcon(one(rows[1]!, ".review-rate__check"), "CheckIcon");
      }),
    );
  });

  it("録音つきは、項目が倍率だけ（所要時間を付けない）で、1 倍に印が付く", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      click(rateButton),
      settle,
      tap((sim) => {
        const rows = items(sim.html);
        expect(rows.map((row) => textOf(row))).toEqual(AUDIO_RATES.map((r) => rateItemLabel(r, DURATION, true)));
        expect(rows.map((row) => textOf(row))).toEqual(AUDIO_RATES.map((r) => `${r} 倍`));
        expect(rows.map((row) => findAll(row, ".review-rate__check svg").length)).toEqual(AUDIO_RATES.map((r) => (r === 1 ? 1 : 0)));
      }),
    );
  });

  it("項目を選ぶと、メニューが閉じ、ボタンの速さが替わる。フォーカスを外す Command が出る（Menu 自身のフォーカス戻しも出る）", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      click(rateButton),
      settle,
      click(nth(menuItems, 2)),
      tap((sim: Sim) => expect(commandNames(sim.commands)).toContain("ReleaseFocusAfterMenuClose")),
      settle,
      Mount.expectEnded(Menu.AnchorMenu, Menu.PortalMenuBackdrop),
      expectScene(menu).not.toExist(),
      expectScene(rateButton).toHaveAttr("aria-expanded", "false"),
      expectScene(rateButton).toContainText("60×"),
    );
  });

  it("録音つきで選ぶと、選んだ速さを <audio> に書く Command が出る", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      click(rateButton),
      settle,
      click(nth(menuItems, 3)),
      tap((sim: Sim) => expect(argsOf(sim.commands, "WriteAudioSettings")).toEqual([{ rate: 1.25, muted: false, volume: 1 }])),
      settle,
      Mount.expectEnded(Menu.AnchorMenu, Menu.PortalMenuBackdrop),
      expectScene(rateButton).toContainText("1.25×"),
    );
  });

  it("矢印キー: ボタンで ArrowDown を押すとメニューが開いて最初の項目が選ばれ、メニューの中で ArrowDown → Enter とすると次の項目を選べる", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      keydown(rateButton, "ArrowDown"),
      expectHandled(),
      settle,
      expectScene(menu).toExist(),
      tap((sim) => {
        const rows = items(sim.html);
        expect(attrOf(rows[0]!, "data-active")).toBeDefined();
        expect(attrOf(rows[1]!, "data-active")).toBeUndefined();
        expect(attrOf(one(sim.html, '[role="menu"]'), "aria-activedescendant")).toBe(attrOf(rows[0]!, "id"));
      }),
      keydown(menu, "ArrowDown"),
      expectHandled(),
      settle,
      tap((sim) => {
        const rows = items(sim.html);
        expect(attrOf(rows[0]!, "data-active")).toBeUndefined();
        expect(attrOf(rows[1]!, "data-active")).toBeDefined();
        expect(attrOf(one(sim.html, '[role="menu"]'), "aria-activedescendant")).toBe(attrOf(rows[1]!, "id"));
      }),
      keydown(menu, "Enter"),
      expectHandled(),
      // Enter は選ばれている項目のクリックを頼む（本物の実行は DOM のクリックで、次の項目の click になる）
      tap((sim: Sim) => {
        const clicks = sim.commands.filter((c) => c.name === "ClickItem");
        expect(clicks).toHaveLength(1);
        expect((clicks[0]!.args as { index: number }).index).toBe(1);
      }),
      settle,
      click(nth(menuItems, 1)),
      settle,
      Mount.expectEnded(Menu.AnchorMenu, Menu.PortalMenuBackdrop),
      expectScene(rateButton).toContainText("0.75×"),
    );
  });

  it("ArrowUp でボタンから開くと最後の項目が選ばれる", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      keydown(rateButton, "ArrowUp"),
      expectHandled(),
      settle,
      tap((sim) => {
        const rows = items(sim.html);
        expect(rows.map((row) => attrOf(row, "data-active") !== undefined)).toEqual([false, false, false, true]);
      }),
    );
  });

  it("外側のクリック（backdrop）でメニューが閉じる。速さは替わらない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      click(rateButton),
      settle,
      expectScene(selector(".review-rate__backdrop")).toExist(),
      click(selector(".review-rate__backdrop")),
      settle,
      Mount.expectEnded(Menu.AnchorMenu, Menu.PortalMenuBackdrop),
      expectScene(menu).not.toExist(),
      expectScene(rateButton).toHaveAttr("aria-expanded", "false"),
      expectScene(rateButton).toContainText("30×"),
    );
  });

  it("Esc でメニューが閉じる。速さは替わらない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      click(rateButton),
      settle,
      keydown(menu, "Escape"),
      expectHandled(),
      settle,
      Mount.expectEnded(Menu.AnchorMenu, Menu.PortalMenuBackdrop),
      expectScene(menu).not.toExist(),
      expectScene(rateButton).toContainText("30×"),
    );
  });

  it("ボタンをもう一度押しても閉じる（開く → 閉じる → 開く、を同じ画面の上で繰り返せる）", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      click(rateButton),
      settle,
      expectScene(menu).toExist(),
      click(rateButton),
      settle,
      Mount.expectEnded(Menu.AnchorMenu, Menu.PortalMenuBackdrop),
      expectScene(menu).not.toExist(),
      click(rateButton),
      settle,
      expectScene(menu).toExist(),
    );
  });
});

describe("ボタンのツールチップ（@foldkit/ui の Tooltip）", () => {
  stubElementForBlur();
  it("ボタンごとに role=tooltip の吹き出しがあり、文言は今と同じ。ボタンは aria-describedby でそれを指し、吹き出しは今の CSS の .review-tip を使う", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      tap((sim) => {
        expect(findAll(sim.html, '[role="tooltip"]')).toHaveLength(TOOLTIPS_AUDIO);
        for (const [label, text] of TIPS) {
          const panel = tipPanelOf(sim.html, label);
          expect(attrOf(panel, "role"), label).toBe("tooltip");
          expect(textOf(panel), label).toBe(text);
          expect(hasClass(panel, "review-tip"), label).toBe(true);
          expect(attrOf(panel, "aria-hidden"), `${label} の吹き出しは読み上げから隠さない`).toBeUndefined();
        }
      }),
    );
  });

  it("再生中の吹き出しは「止める（Space・K）」、ミュート中は「ミュートを戻す（M）」", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100, { playing: true, muted: true })),
      settle,
      tap((sim) => {
        expect(textOf(tipPanelOf(sim.html, "止める"))).toBe("止める（Space・K）");
        expect(textOf(tipPanelOf(sim.html, "ミュートを戻す"))).toBe("ミュートを戻す（M）");
      }),
      // 再生中の Scene の終わりに、消えた字幕の Mount（SlideCaptions）を受け取る
      Mount.expectEnded(SlideCaptions),
    );
  });

  it("録音なしは、ミュートの吹き出しが無い", () => {
    scene(plainApp, given(stateAt(plainContext, 100)), settle, tap((sim) => expect(findAll(sim.html, '[role="tooltip"]')).toHaveLength(TOOLTIPS_PLAIN)));
  });

  for (const [label, text] of TIPS) {
    it(`「${label}」にフォーカスすると「${text}」が出て、フォーカスが外れると消える`, () => {
      scene(
        audioApp,
        given(stateAt(audioContext, 100)),
        settle,
        tap((sim) => expect(isOpenTip(sim.html, label)).toBe(false)),
        focus(labelSel(label)),
        tap((sim) => expect(isOpenTip(sim.html, label)).toBe(true)),
        settle,
        blur(labelSel(label)),
        tap((sim) => expect(isOpenTip(sim.html, label)).toBe(false)),
        settle,
      );
    });

    it(`「${label}」にポインタを乗せると、遅れずに「${text}」が出る`, () => {
      scene(
        audioApp,
        given(stateAt(audioContext, 100)),
        settle,
        hover(labelSel(label)),
        tap((sim: Sim) => {
          const waits = argsOf(sim.commands, "WaitBeforeShowing") as Array<{ delay: Duration.Duration }>;
          expect(waits).toHaveLength(1);
          expect(Duration.toMillis(waits[0]!.delay), "今は乗せたらすぐ出る").toBe(0);
          expect(isOpenTip(sim.html, label)).toBe(false);
        }),
        settle,
        tap((sim) => {
          expect(isOpenTip(sim.html, label)).toBe(true);
          expect(textOf(tipPanelOf(sim.html, label))).toBe(text);
        }),
      );
    });
  }

  it("フォーカスで出た吹き出しは、そのボタンで Esc を押すと閉じる（戻る・進むのボタン）", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      focus(labelSel("反映 1 つ戻る")),
      settle,
      keydown(labelSel("反映 1 つ戻る"), "Escape"),
      expectHandled(),
      tap((sim) => expect(isOpenTip(sim.html, "反映 1 つ戻る")).toBe(false)),
      settle,
    );
  });

  it("吹き出しを出しても、速さのボタンの押す・矢印の動きは損なわれない（Tooltip の束と Menu の束が重なる）", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      focus(rateButton),
      settle,
      keydown(rateButton, "ArrowDown"),
      expectHandled(),
      settle,
      expectScene(menu).toExist(),
      expectScene(rateButton).toHaveAttr("aria-expanded", "true"),
    );
  });
});

describe("字幕と右の列のボタン", () => {
  it("字幕: 名前「字幕」。aria-pressed と、字幕の Disclosure のボタンの属性（id=captions-button・aria-expanded）を持つ", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      expectScene(labelSel("字幕")).toHaveAttr("aria-pressed", "true"),
      expectScene(labelSel("字幕")).toHaveAttr("aria-expanded", "true"),
      expectScene(labelSel("字幕")).toHaveId("captions-button"),
      expectScene(labelSel("字幕")).toHaveAttr("type", "button"),
    );
  });

  it("字幕: 押すと隠した状態になり（aria-pressed・aria-expanded が false、アイコンが替わる）、フォーカスを外す。もう一度押すと戻る", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      click(labelSel("字幕")),
      tap((sim: Sim) => expect(commandNames(sim.commands)).toEqual(["ReleaseFocus"])),
      settle,
      expectScene(labelSel("字幕")).toHaveAttr("aria-pressed", "false"),
      expectScene(labelSel("字幕")).toHaveAttr("aria-expanded", "false"),
      tap((sim) => expectVideoJsIcon(labelled(sim.html, "字幕"), "CaptionsOffIcon")),
      click(labelSel("字幕")),
      settle,
      expectScene(labelSel("字幕")).toHaveAttr("aria-pressed", "true"),
      expectScene(labelSel("字幕")).toHaveAttr("aria-expanded", "true"),
      tap((sim) => expectVideoJsIcon(labelled(sim.html, "字幕"), "CaptionsOnIcon")),
    );
  });

  it("右の列: 名前「右の列」。aria-pressed を持ち、Disclosure の属性（aria-expanded・aria-controls）は付けない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      expectScene(labelSel("右の列")).toHaveAttr("aria-pressed", "true"),
      expectScene(labelSel("右の列")).not.toHaveAttr("aria-expanded"),
      expectScene(labelSel("右の列")).not.toHaveAttr("aria-controls"),
    );
  });

  it("右の列: 押すと隠した状態になり（aria-pressed=false）、フォーカスを外す。もう一度押すと戻る。字幕には触らない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      click(labelSel("右の列")),
      tap((sim: Sim) => expect(commandNames(sim.commands)).toEqual(["ReleaseFocus"])),
      settle,
      expectScene(labelSel("右の列")).toHaveAttr("aria-pressed", "false"),
      expectScene(labelSel("字幕")).toHaveAttr("aria-pressed", "true"),
      click(labelSel("右の列")),
      settle,
      expectScene(labelSel("右の列")).toHaveAttr("aria-pressed", "true"),
    );
  });
});

describe("アイコン: インライン SVG。video.js のものを写し、描き直さない", () => {
  it("再生と止める（PlayIcon・PauseIcon）", () => {
    scene(plainApp, given(stateAt(plainContext, 100, { playing: false })), settle, tap((sim) => expectVideoJsIcon(labelled(sim.html, "再生"), "PlayIcon")));
    scene(plainApp, given(stateAt(plainContext, 100, { playing: true })), settle, tap((sim) => expectVideoJsIcon(labelled(sim.html, "止める"), "PauseIcon")));
  });

  it("速さのボタンは SpeedIcon", () => {
    scene(plainApp, given(stateAt(plainContext, 100)), settle, tap((sim) => expectVideoJsIcon(labelled(sim.html, "再生の速さ"), "SpeedIcon")));
  });

  it("音量のアイコンは、0.5 以上で High、0.5 未満で Low、0 とミュート中で Off", () => {
    const iconFor = (patch: Parameters<typeof stateAt>[2], name: keyof typeof VIDEOJS_ICONS) =>
      scene(audioApp, given(stateAt(audioContext, 100, patch)), settle, tap((sim) => expectVideoJsIcon(iconOfButton(sim.html, patch?.muted ? "ミュートを戻す" : "ミュート"), name)));
    iconFor({ volume: 1 }, "VolumeHighIcon");
    iconFor({ volume: 0.5 }, "VolumeHighIcon");
    iconFor({ volume: 0.45 }, "VolumeLowIcon");
    iconFor({ volume: 0.05 }, "VolumeLowIcon");
    iconFor({ volume: 0 }, "VolumeOffIcon");
    iconFor({ volume: 1, muted: true }, "VolumeOffIcon");
  });

  it("音量を動かすと、同じ画面の上でアイコンが High → Low → Off と替わる", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      tap((sim) => expectVideoJsIcon(labelled(sim.html, "ミュート"), "VolumeHighIcon")),
      keydown(volumeThumb, "Home"),
      settle,
      tap((sim) => expectVideoJsIcon(labelled(sim.html, "ミュート"), "VolumeOffIcon")),
      keydown(volumeThumb, "ArrowRight"),
      settle,
      tap((sim) => expectVideoJsIcon(labelled(sim.html, "ミュート"), "VolumeLowIcon")),
      keydown(volumeThumb, "End"),
      settle,
      tap((sim) => expectVideoJsIcon(labelled(sim.html, "ミュート"), "VolumeHighIcon")),
    );
  });

  it("戻る・進む（StepIcon）は今の形のまま（16×16、塗りは currentColor）", () => {
    const path = (d: string): IconNode => ({ tag: "path", attrs: { d }, children: [] });
    const step = (d: string): IconNode => ({ tag: "svg", attrs: { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true", fill: "currentColor" }, children: [path(d)] });
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      tap((sim) => {
        expect(canonical(iconOfButton(sim.html, "反映 1 つ戻る"), true, true)).toEqual(step("M3 3h2v10H3zM13 3v10L6 8z"));
        expect(canonical(iconOfButton(sim.html, "反映 1 つ進む"), true, true)).toEqual(step("M11 3h2v10h-2zM3 3l7 5-7 5z"));
      }),
    );
  });

  it("右の列（SideIcon）は今の形のまま。隠しているときは右の列を塗らない", () => {
    const side = (path: IconNode): IconNode => ({
      tag: "svg",
      attrs: { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": "1.5" },
      children: [{ tag: "rect", attrs: { x: "2", y: "3", width: "12", height: "10", rx: "1.5" }, children: [] }, path],
    });
    const shown: IconNode = { tag: "path", attrs: { d: "M10 3v10h3.5a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5z", fill: "currentColor" }, children: [] };
    const hidden: IconNode = { tag: "path", attrs: { d: "M10 3v10" }, children: [] };
    scene(plainApp, given(stateAt(plainContext, 100)), settle, tap((sim) => expect(canonical(iconOfButton(sim.html, "右の列"), true, true)).toEqual(side(shown))));
    scene(plainApp, given(sideHiddenOf(stateAt(plainContext, 100))), settle, tap((sim) => expect(canonical(iconOfButton(sim.html, "右の列"), true, true)).toEqual(side(hidden))));
  });

  it("字幕を隠した状態から始めると CaptionsOff、出した状態は CaptionsOn", () => {
    scene(plainApp, given({ ...stateAt(plainContext, 100), captionsHidden: true }), settle, tap((sim) => expectVideoJsIcon(labelled(sim.html, "字幕"), "CaptionsOffIcon")));
    scene(plainApp, given(stateAt(plainContext, 100)), settle, tap((sim) => expectVideoJsIcon(labelled(sim.html, "字幕"), "CaptionsOnIcon")));
  });
});

describe("Slider と今の CSS がぶつからない（Slider が付ける style をそのまま残す）", () => {
  it("シークバーのつまみは、Slider の位置の指定（絶対配置・左は時刻の割合・translateX(-50%)・touch-action）のまま。余白の指定を足さない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      expectScene(seekThumb).toHaveStyle("position", "absolute"),
      expectScene(seekThumb).toHaveStyle("left", "50%"),
      expectScene(seekThumb).toHaveStyle("transform", "translateX(-50%)"),
      expectScene(seekThumb).toHaveStyle("touch-action", "none"),
      tap((sim) => {
        const style = styleOf(labelled(sim.html, "時刻"));
        expect(Object.keys(style).filter((k) => /margin/i.test(k))).toEqual([]);
        expect(hasClass(labelled(sim.html, "時刻"), "review-seek__thumb")).toBe(true);
      }),
    );
  });

  it("音量のつまみも同じ。塗り（.review-volume__fill）は Slider の塗りの束で、幅は音量の割合", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100, { volume: 0.25 })),
      settle,
      expectScene(volumeThumb).toHaveStyle("position", "absolute"),
      expectScene(volumeThumb).toHaveStyle("left", "25%"),
      expectScene(volumeThumb).toHaveStyle("transform", "translateX(-50%)"),
      expectScene(selector(".review-volume__fill")).toHaveStyle("width", "25%"),
      expectScene(selector(".review-volume__fill")).toHaveStyle("position", "absolute"),
      tap((sim) => {
        expect(Object.keys(styleOf(labelled(sim.html, "音量"))).filter((k) => /margin/i.test(k))).toEqual([]);
        expect(hasClass(labelled(sim.html, "音量"), "review-volume__thumb")).toBe(true);
      }),
    );
  });

  it("Slider の track の束（data-slider-track-id、inline の position:relative）は、今の CSS の絶対配置の .review-seek__track・.review-volume__track には付けない（崩れる）", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      tap((sim) => {
        const tracks = findAll(sim.html, "[data-slider-track-id]");
        expect(tracks).toHaveLength(2);
        for (const track of tracks) {
          expect(styleOf(track)["position"]).toBe("relative");
          expect(styleOf(track)["touch-action"]).toBe("none");
          expect(hasClass(track, "review-seek__track")).toBe(false);
          expect(hasClass(track, "review-volume__track")).toBe(false);
        }
        // 見た目の track は別の要素として残り、Slider の style を持たない
        expect(Object.keys(styleOf(one(sim.html, ".review-seek__track")))).toEqual([]);
        expect(Object.keys(styleOf(one(sim.html, ".review-volume__track")))).toEqual([]);
      }),
    );
  });

  it("Slider の track の束は、押せる範囲用の包み要素（.review-slider-hit）に付ける。見た目の track はその中にあり、Slider の束を持たない", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      tap((sim) => {
        const tracks = findAll(sim.html, "[data-slider-track-id]");
        expect(tracks.map((t) => hasClass(t, "review-slider-hit"))).toEqual([true, true]);
        expect(findAll(tracks[0]!, ".review-seek__track")).toHaveLength(1);
        expect(findAll(tracks[1]!, ".review-volume__track")).toHaveLength(1);
      }),
    );
  });

  it("Slider の root（.review-seek・.review-volume__slider）には style を足さない（data 属性だけ）", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      tap((sim) => {
        expect(Object.keys(styleOf(one(sim.html, ".review-seek")))).toEqual([]);
        expect(Object.keys(styleOf(one(sim.html, ".review-volume__slider")))).toEqual([]);
      }),
    );
  });
});

describe("押して離したらフォーカスを外す（Scene）", () => {
  stubDomForPointer();
  it("シークバーを押して、文書で離す（Subscription）と ReleaseFocus が出る", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 100)),
      settle,
      pointerDown(seekRoot),
      settle,
      Subscription.emit(Message.ReleasedSliderPointer()),
      tap((sim: Sim) => expect(commandNames(sim.commands)).toEqual(["ReleaseFocus"])),
      settle,
    );
  });

  it("音量を押して、文書で離すと ReleaseFocus が出る", () => {
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      pointerDown(selector(".review-volume__slider")),
      settle,
      Subscription.emit(Message.ReleasedSliderPointer()),
      tap((sim: Sim) => expect(commandNames(sim.commands)).toEqual(["ReleaseFocus"])),
      settle,
    );
  });

  it("シークバーを引いている途中で pointercancel になると、引くのをやめる。そのあとの pointermove は時刻を動かさず、SeekAudio も出ない", () => {
    const drag = (message: Slider.Message) => Subscription.emit(Message.GotSeekSliderMessage({ message }));
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      pointerDown(seekThumb),
      pointerDown(seekRoot),
      settle,
      expectScene(seekRoot).toHaveAttr("data-dragging"),
      Subscription.emit(Message.CancelledSliderPointer()),
      settle,
      expectScene(seekRoot).not.toHaveAttr("data-dragging"),
      drag(Slider.Message.MovedDragPointer({ value: 50 })),
      tap((sim: Sim) => expect(commandNames(sim.commands)).toEqual([])),
      expectScene(seekThumb).toHaveAttr("aria-valuenow", "100"),
      tap((sim) => expect(barText(sim.html, "review-bar__time")).toBe("0:01:40 / 0:03:20")),
    );
  });

  it("音量を引いている途中で pointercancel になると、引くのをやめる。そのあとの pointermove は音量を動かさず、WriteAudioSettings も出ない", () => {
    const drag = (message: Slider.Message) => Subscription.emit(Message.GotVolumeSliderMessage({ message }));
    scene(
      audioApp,
      given(stateAt(audioContext, 100)),
      settle,
      pointerDown(volumeThumb),
      pointerDown(selector(".review-volume__slider")),
      settle,
      Subscription.emit(Message.CancelledSliderPointer()),
      settle,
      drag(Slider.Message.MovedDragPointer({ value: 0.5 })),
      tap((sim: Sim) => expect(commandNames(sim.commands)).toEqual([])),
      expectScene(volumeThumb).toHaveAttr("aria-valuenow", "1"),
      expectScene(selector(".review-volume__fill")).toHaveStyle("width", "100%"),
    );
  });
});
