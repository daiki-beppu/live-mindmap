import { click, expect as expectScene, findAll, given, scene, selector, Subscription, tap, textContent } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import { captionsOf } from "../src/captions.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { Message } from "../src/app/review/message.ts";

import { speakingAt } from "../src/reviewTimeline.ts";
import { snapshotOf } from "../src/app/review/main.ts";
import { attrOf, audioApp, audioContext, elementsOf, hasClass, one, plainApp, plainContext, settle, stateAt, type Sim, type VNode } from "./reviewHarness.ts";

// 見返しを 1 つのプログラムに組み上げた（Issue #826）Scene。描いた view から入り、
// .review > .review__session > .layout > [.map > [.map-surface, 見る状態の知らせ, キーの一覧], 字幕, .side]、.review-controls、<audio> の並びで、
// 字幕・右の列・見る状態の知らせが時刻と見る状態に追従することを見る。並びは React の版と同じ（画面の照合のスクリーンショットに要る）。
// キー・時刻の動きは文書の keydown（描いた木の外）から届くので Subscription.emit で流す。会議の長さは 200 秒

const NO_MODIFIERS = { metaKey: false, ctrlKey: false, altKey: false };
const press = (key: string) => Subscription.emit(Message.PressedKey({ key: key as never, ...NO_MODIFIERS }));
const labelSel = (label: string) => selector(`[aria-label="${label}"]`);

const MANUAL = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
const OVERVIEW = "全体を見ています・F か Esc で戻る・? でキー一覧";

const classesOf = (vnode: VNode): string[] => elementsOf(vnode).map((v) => attrOf(v, "class") ?? "");
const orderOf = (vnode: VNode, names: readonly string[]): string[] =>
  elementsOf(vnode).flatMap((child) => names.filter((name) => hasClass(child, name)));
const texts = (sim: Sim, css: string): string[] => findAll(sim.html, css).map(textContent);

const captionLines = (context: typeof plainContext, time: number): string[] =>
  captionsOf(speakingAt(context.timeline, time)).flatMap((caption) => caption.lines);

describe("見返しの Scene: 画面の並び", () => {
  it.each([
    ["録音なし", plainApp, plainContext],
    ["録音つき", audioApp, audioContext],
  ] as const)("%s: .review の直下は .review__session → .review-controls（→ 録音つきだけ audio）で、.review__session の中は .layout だけ", (_name, app, context) => {
    scene(
      app,
      given(stateAt(context, 105)),
      settle,
      tap((sim) => {
        const review = one(sim.html, ".review");
        const parts = elementsOf(review).map((v) => (hasClass(v, "review__session") ? "session" : hasClass(v, "review-controls") ? "controls" : v.sel?.startsWith("audio") ? "audio" : "other"));
        expect(parts).toEqual(context === audioContext ? ["session", "controls", "audio"] : ["session", "controls"]);
        expect(classesOf(one(sim.html, ".review__session")).map((c) => c.split(" ")[0])).toEqual(["layout"]);
      }),
    );
  });

  it(".layout の直下は 表示面の区画（.map）→ 字幕（.captions）→ 右の列（.side） の順で、取り込み・共有画面の知らせは出さない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 105)),
      settle,
      tap((sim) => {
        const layout = one(sim.html, ".layout");
        expect(orderOf(layout, ["map", "captions", "side", "intake-notice", "screen-notice", "local-mode-notice", "diff-update-notice"])).toEqual(["map", "captions", "side"]);
        expect(findAll(one(sim.html, ".map"), ".map-surface")).toHaveLength(1);
        expect(findAll(sim.html, ".map-surface")).toHaveLength(1);
      }),
    );
  });

  it("キーの一覧と見る状態の知らせは .map の中で 表示面 → 見る状態の知らせ → キーの一覧 の順に並ぶ", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 105)),
      settle,
      press("="),
      settle,
      press("?"),
      settle,
      tap((sim) => expect(orderOf(one(sim.html, ".map"), ["map-surface", "viewing-notice", "key-list__anchor"])).toEqual(["map-surface", "viewing-notice", "key-list__anchor"])),
      settle,
    );
  });
});

describe("見返しの Scene: 字幕は時刻の発言に追従し、C と字幕のボタンで出し入れできる", () => {
  it("その時刻の発言（speakingAt）の文を描く。時刻が動くと文が替わり、発言が無い時刻では .captions ごと描かない", () => {
    expect(captionLines(plainContext, 105)).not.toEqual([]);
    expect(captionLines(plainContext, 200)).not.toEqual(captionLines(plainContext, 105));
    expect(captionLines(plainContext, 0)).toEqual([]);
    scene(
      plainApp,
      given(stateAt(plainContext, 105)),
      settle,
      tap((sim) => expect(texts(sim, ".captions__line")).toEqual(captionLines(plainContext, 105))),
      press("End"),
      settle,
      tap((sim) => expect(texts(sim, ".captions__line")).toEqual(captionLines(plainContext, 200))),
      press("Home"),
      settle,
      expectScene(selector(".captions")).toBeAbsent(),
    );
  });

  it("C で字幕を隠し、もう一度の C で戻す。字幕のボタンも同じ", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 105)),
      settle,
      expectScene(selector(".captions")).toExist(),
      press("C"),
      settle,
      expectScene(selector(".captions")).toBeAbsent(),
      expectScene(labelSel("字幕")).toHaveAttr("aria-pressed", "false"),
      press("C"),
      settle,
      expectScene(selector(".captions")).toExist(),
      click(labelSel("字幕")),
      settle,
      expectScene(selector(".captions")).toBeAbsent(),
      click(labelSel("字幕")),
      settle,
      expectScene(selector(".captions")).toExist(),
      expectScene(labelSel("字幕")).toHaveAttr("aria-pressed", "true"),
    );
  });
});

describe("見返しの Scene: 右の列は表示面の見る状態に従い、E と右の列のボタンで出し入れできる", () => {
  it("その時刻のマップの変わったこと（.changes__item）を描き、時刻が動くと替わる", () => {
    const countAt = (time: number) => snapshotOf(plainContext, stateAt(plainContext, time)).changes.length;
    expect(countAt(200)).toBeGreaterThan(countAt(10));
    scene(
      plainApp,
      given(stateAt(plainContext, 200)),
      settle,
      tap((sim) => expect(findAll(sim.html, ".changes__item")).toHaveLength(countAt(200))),
      press("Home"),
      settle,
      tap((sim) => expect(findAll(sim.html, ".changes__item")).toHaveLength(countAt(0))),
    );
  });

  it("E で .side を描かなくなり、右の列のボタンの aria-pressed が false になる。もう一度の E で戻る", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 105)),
      settle,
      expectScene(selector(".side")).toExist(),
      expectScene(labelSel("右の列")).toHaveAttr("aria-pressed", "true"),
      press("E"),
      settle,
      expectScene(selector(".side")).toBeAbsent(),
      expectScene(labelSel("右の列")).toHaveAttr("aria-pressed", "false"),
      press("E"),
      settle,
      expectScene(selector(".side")).toExist(),
      expectScene(labelSel("右の列")).toHaveAttr("aria-pressed", "true"),
    );
  });

  it("右の列のボタンを押すと .side が消え、もう一度押すと戻る。字幕には触らない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 105)),
      settle,
      click(labelSel("右の列")),
      settle,
      expectScene(selector(".side")).toBeAbsent(),
      expectScene(selector(".captions")).toExist(),
      click(labelSel("右の列")),
      settle,
      expectScene(selector(".side")).toExist(),
    );
  });

  it("変わったことの項目を押すと、そのノードが選ばれて根拠のパネルに出る（右の列が表示面の選択とつながる）", () => {
    // 時刻 10 のマップの変わったことは 1 件（議題 A の追加）だけ
    const changes = snapshotOf(plainContext, stateAt(plainContext, 10)).changes;
    expect(changes).toHaveLength(1);
    scene(
      plainApp,
      given(stateAt(plainContext, 10)),
      settle,
      expectScene(selector(".evidence__empty")).toExist(),
      click(selector("button.changes__button")),
      settle,
      tap((sim) => expect(texts(sim, ".evidence__text")).toEqual([changes[0]!.text])),
    );
  });
});

describe("見返しの Scene: 見る状態の知らせ", () => {
  it("拡大（manual）で『動かしています』、F で『全体を見ています』が .map の中に出て、時刻を動かすと消える", () => {
    scene(
      plainApp,
      given(
        plainApp.update(stateAt(plainContext, 105), Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: {} }) })).model,
      ),
      settle,
      expectScene(selector(".viewing-notice")).toBeAbsent(),
      press("="),
      settle,
      expectScene(selector(".viewing-notice")).toHaveText(MANUAL),
      tap((sim) => expect(findAll(one(sim.html, ".map"), "p.viewing-notice")).toHaveLength(1)),
      press("F"),
      settle,
      expectScene(selector(".viewing-notice")).toHaveText(OVERVIEW),
      click(labelSel("反映 1 つ戻る")),
      settle,
      expectScene(selector(".viewing-notice")).toBeAbsent(),
    );
  });

  it("取り込みの知らせ・共有画面の知らせは、どの状態でも出ない", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 105)),
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
      expectScene(selector(".screen-notice")).toBeAbsent(),
      press("="),
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
      expectScene(selector(".screen-notice")).toBeAbsent(),
    );
  });
});

describe("見返しの Scene: 見る状態を動かす操作で、同じ画面の上で表示と状態が続けて追従する", () => {
  it("拡大 → ▶ で時刻を動かす → 知らせが消えて、字幕と変わったことが新しい時刻のものになる", () => {
    scene(
      plainApp,
      given(stateAt(plainContext, 105)),
      settle,
      press("="),
      settle,
      expectScene(selector(".viewing-notice")).toExist(),
      press("End"),
      settle,
      expectScene(selector(".viewing-notice")).toBeAbsent(),
      tap((sim) => expect(texts(sim, ".captions__line")).toEqual(captionLines(plainContext, 200))),
    );
  });
});
