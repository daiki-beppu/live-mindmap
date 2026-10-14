import { expect as expectScene, findAll, given, Mount, scene, selector, Subscription, tap, textContent } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import { keyListRows, type Screen } from "../src/app/keys/table.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { Message } from "../src/app/review/message.ts";
import { audioApp, audioContext, descendants, hasClass, plainApp, plainContext, settle, stateAt } from "./reviewHarness.ts";
import { attrOf, one, styleOf, type VNode } from "./sceneTree.ts";

// 見返しのキーの一覧（Issue #822）の Scene。描いた view から入り、? で開いた一覧が、表から作った行で、マップの区画の中に出ること、
// 開いたままマップを動かせること（背景を止めない）を見る。? のキーは文書の keydown（描いた木の外）から届くので Subscription.emit で流す。
// Scene は座標を持たないので「マップの区画の中」は、.map の子孫であることで確かめる（実際の座標は切り替えの段の heavy IT）。
// 閉じる側（Esc・? の 2 回目）は Popover が Command（フォーカスを戻す）を出すので、update の Story（keys.story.test.ts）で確かめる

const NO_MODIFIERS = { metaKey: false, ctrlKey: false, altKey: false };
const pressQuestion = Subscription.emit(Message.PressedKey({ key: "?", ...NO_MODIFIERS }));

const measuredModel = (context: typeof plainContext, app: typeof plainApp) =>
  app.update(stateAt(context, 100), Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, n1: 40, n2: 40, n3: 40 } }) })).model;
const wheel = (deltaY: number) =>
  MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0 });

const viewportTransform = (html: VNode): string => styleOf(one(html, ".map-viewport")).transform ?? "";
const keyListIn = (html: VNode, within: string): VNode[] => descendants(one(html, within)).filter((v) => hasClass(v, "key-list"));
const rowKeys = (html: VNode): string[] => findAll(html, ".key-list__keys").map((v) => textContent(v));
const rowTexts = (html: VNode): string[] => findAll(html, ".key-list__row").map((v) => textContent(v));

describe("キーの一覧の Scene: ? で開く", () => {
  it("最初は描かれず、? で .map（マップの区画）の中に 1 つ出る", () => {
    scene(
      plainApp,
      given(measuredModel(plainContext, plainApp)),
      settle,
      expectScene(selector(".key-list")).not.toExist(),
      pressQuestion,
      expectScene(selector(".key-list")).toExist(),
      tap((simulation) => {
        expect(keyListIn(simulation.html, ".map")).toHaveLength(1);
        expect(findAll(simulation.html, ".key-list")).toHaveLength(1);
      }),
      settle,
    );
  });

  it.each([
    ["録音なし", plainApp, plainContext, "review"],
    ["録音つき", audioApp, audioContext, "reviewAudio"],
  ] as const)("%s: 行は表から作った一覧と同じ順（キーの行 → 見返しの行 →（音声つきなら M）→ マウスの行）で、文言も同じ", (_name, app, context, screen: Screen) => {
    scene(
      app,
      given(measuredModel(context, app)),
      settle,
      pressQuestion,
      tap((simulation) => {
        const rows = keyListRows(screen);
        expect(rowKeys(simulation.html)).toEqual(rows.map((row) => row.keys));
        rowTexts(simulation.html).forEach((text, i) => {
          expect(text).toContain(rows[i]!.keys);
          expect(text).toContain(rows[i]!.action);
        });
        expect(rowKeys(simulation.html).includes("M")).toBe(screen === "reviewAudio");
      }),
      settle,
    );
  });

  it("描く構造は今の一覧と同じ: .key-list > .key-list__row > .key-list__keys", () => {
    scene(
      plainApp,
      given(measuredModel(plainContext, plainApp)),
      settle,
      pressQuestion,
      tap((simulation) => {
        const list = one(simulation.html, ".key-list");
        const rows = descendants(list).filter((v) => hasClass(v, "key-list__row"));
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(descendants(row).filter((v) => hasClass(v, "key-list__keys"))).toHaveLength(1);
      }),
      settle,
    );
  });
});

describe("キーの一覧の Scene: 開いたままマップを動かせる（背景を止めない）", () => {
  it("一覧を開いたまま wheel を送ると、マップの viewport の transform が変わり、一覧は残る", () => {
    let before = "";
    scene(
      plainApp,
      // ? で開いた Model（update が PressedKey を受けた結果）から始める。ObserveMapSurface を保留のまま残して、wheel を届けるため
      given(plainApp.update(measuredModel(plainContext, plainApp), Message.PressedKey({ key: "?", ...NO_MODIFIERS })).model),
      tap((simulation) => {
        before = viewportTransform(simulation.html);
        expect(before).not.toBe("");
        expect(keyListIn(simulation.html, ".map")).toHaveLength(1);
      }),
      Mount.resolve(ObserveMapSurface, wheel(100)),
      tap((simulation) => {
        expect(viewportTransform(simulation.html)).not.toBe(before);
        expect(keyListIn(simulation.html, ".map")).toHaveLength(1);
      }),
      settle,
    );
  });

  it("パネルに blur の受け口がない（blur で閉じない）。フォーカスを移さない一覧なので tabindex も無い", () => {
    scene(
      plainApp,
      given(measuredModel(plainContext, plainApp)),
      settle,
      pressQuestion,
      tap((simulation) => {
        const panel = one(simulation.html, ".key-list");
        expect(panel.data?.on?.blur).toBeUndefined();
        expect(attrOf(panel, "tabindex")).toBeUndefined();
      }),
      settle,
    );
  });

  it("開いている間、描いた木のどこにも inert が付かない（Dialog の背景の無効化をしていない）", () => {
    scene(
      plainApp,
      given(measuredModel(plainContext, plainApp)),
      settle,
      pressQuestion,
      tap((simulation) => {
        for (const vnode of [simulation.html, ...descendants(simulation.html)]) expect(attrOf(vnode, "inert"), vnode.sel).toBeUndefined();
        expect(attrOf(one(simulation.html, ".review__session"), "aria-hidden")).toBeUndefined();
      }),
      settle,
    );
  });

  it("開いたまま、キー（=）で拡大すると、マップが動き、一覧は残る", () => {
    let before = "";
    scene(
      plainApp,
      given(measuredModel(plainContext, plainApp)),
      settle,
      pressQuestion,
      settle,
      tap((simulation) => void (before = viewportTransform(simulation.html))),
      Subscription.emit(Message.PressedKey({ key: "=", ...NO_MODIFIERS })),
      tap((simulation) => {
        expect(viewportTransform(simulation.html)).not.toBe(before);
        expect(keyListIn(simulation.html, ".map")).toHaveLength(1);
      }),
      settle,
    );
  });
});
