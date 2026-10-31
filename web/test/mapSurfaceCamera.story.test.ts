import { HashMap, Option, Schema } from "effect";
import { given, message, model, story } from "foldkit/story";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Snapshot, type ChangeEntry, type SnapshotNode } from "../../server/src/core/index.ts";
import { blinkRestartsOf, changedSnapshot, displayedPositions, init, Model, update } from "../src/app/mapSurface/main.ts";
import { Message } from "../src/app/mapSurface/message.ts";
import * as Meeting from "../src/app/meeting/main.ts";
import { Message as MeetingMessage } from "../src/app/meeting/message.ts";
import { Message as LiveFeedMessage } from "../src/app/liveFeed/message.ts";
import {
  cameraFocus,
  anchoredViewport,
  changedFocus,
  clampUserZoom,
  fitViewport,
  focusViewport,
  nodeFocusViewport,
  nodeRect,
  overviewViewport,
  panViewport,
  revealViewport,
  screenPoint,
  shiftIntoView,
  subtreeViewport,
  USER_MAX_ZOOM,
  USER_MIN_ZOOM,
  zoomAroundCenter,
  type Rect,
  type Viewport,
} from "../src/camera.ts";
import { foldView, keepTargetOf } from "../src/folding.ts";
import { layout, NODE_WIDTH } from "../src/layout.ts";
import { type ViewKey } from "../src/viewing.ts";

// マップの表示面のカメラ（Issue #819）の Story。update に Message を流し、そのたびの Model の viewport と viewing を見る。
// 反映で寄せる・人が動かすと止まる・全体を見て戻る・開閉で位置を保つ・列を出してずらす、を update の中の関数の呼び順として確かめる。
// 期待する viewport は、camera.ts の純粋な関数を直接呼んだ値（目標の位置と高さで測る。補間中の位置で測るのは、今の議題が無いときの収め直しだけ）。
// 同じ Model に Message を続けて流し、その途中の Model を観測する（条件だけ変えた別の Model を作り直して比べない）

type MapSurfaceModel = typeof Model.Type;

const node = (id: string, parent: string | null, kind: Exclude<SnapshotNode["kind"], "補足"> = "議題", extra: Partial<Exclude<SnapshotNode, { kind: "補足" }>> = {}): Exclude<SnapshotNode, { kind: "補足" }> => ({ id, parent, kind, text: id, evidence: parent ? ["r1"] : [], ...extra });
const snap = (nodes: SnapshotNode[], extra: Partial<Snapshot> = {}): Snapshot => ({ nodes, round: 1, changes: [], remarks: [], ...extra });

// 会議 root > 議題 A（論点 A1・A2）・議題 B（論点 B1・B2・B3）。済みも古いものも無いので、畳まれるノードは無い。今の議題は A
const baseNodes = (): SnapshotNode[] => [
  node("root", null, "会議"),
  node("A", "root"),
  node("A1", "A", "論点"),
  node("A2", "A", "論点"),
  node("B", "root"),
  node("B1", "B", "論点"),
  node("B2", "B", "論点"),
  node("B3", "B", "論点"),
];
const tree = (extra: Partial<Snapshot> = {}): Snapshot => snap(baseNodes(), { currentTopic: "A", ...extra });
const change = (nodeId: string, round: number): ChangeEntry => ({ change: "追加", node: nodeId, kind: "論点", text: nodeId, round, at: round }) as ChangeEntry;
// 今の議題は A のまま、round の反映で ids が変わった。lastChanged は ids の最後
const withChanges = (ids: string[], round = 2, extra: Partial<Snapshot> = {}): Snapshot =>
  snap(baseNodes(), { round, currentTopic: "A", changes: ids.map((id) => change(id, round)), lastChanged: ids.at(-1)!, ...extra });
// 今の議題の下に、変更の記録を残さずノードが 1 つ増えた反映（寄せ先の箱が変わる）
const withSilentNode = (extra: Partial<Snapshot> = {}): Snapshot => snap([...baseNodes(), node("A3", "A", "論点")], { round: 2, currentTopic: "A", ...extra });

// 済みの議題 A（論点 A1・A2）は畳まれ、話し中の今の議題 B は畳まれない。A を開くと B が下へ動く
const foldable = (extra: Partial<Snapshot> = {}): Snapshot =>
  snap(
    [node("root", null, "会議"), node("A", "root", "議題", { talkStatus: "済み" }), node("A1", "A", "論点"), node("A2", "A", "論点"), node("B", "root"), node("B1", "B", "論点")],
    { currentTopic: "B", now: 100, ...extra },
  );

const HEIGHTS: Record<string, number> = { root: 40, A: 60, A1: 60, A2: 60, A3: 60, B: 60, B1: 60, B2: 60, B3: 60 };
const SIZE = { width: 600, height: 400 };
const SMALL = { width: 300, height: 200 };
const measure = (size = SIZE, nodeHeights: Record<string, number> = HEIGHTS) => Message.MeasuredMapSurface({ ...size, nodeHeights });

const settle = (snapshot: Snapshot, mode: MapSurfaceModel["mode"] = "live", size = SIZE): MapSurfaceModel => update(init(snapshot, mode, false), measure(size)).model;
type Msg = typeof Message.Type;
const run = (start: MapSurfaceModel, ...messages: Array<Msg>): MapSurfaceModel => messages.reduce((m, next) => update(m, next).model, start);

// --- 入力の Message ---
const wheel = (over: Partial<typeof Message.WheeledMapSurface.Type> = {}) =>
  Message.WheeledMapSurface({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0, x: 300, y: 200, ...over });
const scroll = wheel({ deltaX: 40, deltaY: 100 });
const tick = (deltaMs: number) => Message.TickedAnimationFrame({ deltaMs });
const mods = { metaKey: false, ctrlKey: false, altKey: false };
const key = (k: ViewKey, over: Partial<typeof mods> = {}) => Message.PressedViewKey({ key: k, ...mods, ...over });
const changed = (snapshot: Snapshot) => Message.ChangedSnapshot({ snapshot });
const clickFoldDot = (nodeId: string) => Message.ClickedFoldDot({ nodeId });
const clickNode = (nodeId: string) => Message.ClickedNodeButton({ nodeId, clientX: 0, clientY: 0 });

// --- 期待する値（純粋な関数を直接呼ぶ） ---
const heightsOf = (m: MapSurfaceModel): Record<string, number> => Object.fromEntries(HashMap.toEntries(m.nodeHeights));
const dimsOf = (m: MapSurfaceModel): Record<string, { height: number }> => Object.fromEntries(HashMap.toEntries(m.nodeHeights).map(([id, height]) => [id, { height }]));
const sizeOf = (m: MapSurfaceModel) => Option.getOrThrow(m.size);
const viewOf = (m: MapSurfaceModel) => {
  if (m.mode === "still") return null;
  return foldView(m.snapshot, m.viewing.humanFolds, m.viewing.selection?.id ?? null);
};
const shownOf = (m: MapSurfaceModel): SnapshotNode[] => viewOf(m)?.nodes ?? m.snapshot.nodes;
const targetsOf = (m: MapSurfaceModel) => layout(shownOf(m), heightsOf(m));

// 今の議題へ寄せた位置。見せないノードは、それを隠している畳んだノードに置き換えて測る
const focusExpected = (m: MapSurfaceModel): Viewport => {
  const focus = cameraFocus(m.snapshot)!;
  const view = viewOf(m);
  const shownId = (id: string) => view?.shownAs[id] ?? id;
  const target = targetsOf(m);
  const dims = dimsOf(m);
  return focusViewport([...new Set(focus.ids.map(shownId))].map((id) => nodeRect(id, target, dims)), nodeRect(shownId(focus.center), target, dims), sizeOf(m));
};
// 最後の反映で変わったノードへ寄せた位置（下限は人の下限）。見せないノードは、見えている代わりのノードに置き換えて測る
const changedExpected = (m: MapSurfaceModel): Viewport => {
  const view = viewOf(m);
  const focus = changedFocus(m.snapshot, (id) => keepTargetOf(view, id))!;
  const target = targetsOf(m);
  const dims = dimsOf(m);
  return focusViewport(focus.ids.map((id) => nodeRect(id, target, dims)), nodeRect(focus.center, target, dims), sizeOf(m), USER_MIN_ZOOM);
};
// 全体を収めた位置。測れたノードだけを、positions の位置で収める（still は下限 0.02、ふだんは 0.5）
const fitExpected = (m: MapSurfaceModel, positions: Record<string, { x: number; y: number }> = targetsOf(m)): Viewport => {
  const heights = heightsOf(m);
  const rects = shownOf(m)
    .filter((n) => heights[n.id] !== undefined)
    .map((n): Rect => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights[n.id]! }));
  return fitViewport(rects, sizeOf(m), m.mode === "still" ? 0.02 : 0.5, USER_MAX_ZOOM)!;
};
const overviewExpected = (m: MapSurfaceModel): Viewport => overviewViewport(shownOf(m).map((n) => n.id), targetsOf(m), dimsOf(m), sizeOf(m))!;

const expectViewport = (actual: Viewport, expected: Viewport) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 6);
};
const expectDifferent = (a: Viewport, b: Viewport) => expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.zoom - b.zoom)).toBeGreaterThan(1e-3);
const manualAt = (topic: string | undefined) => ({ mode: "manual", topic });
const cameraViewOf = (m: MapSurfaceModel) => m.camera.mode === "auto" ? { mode: "auto" } : { mode: m.camera.mode, topic: m.camera.topic };
const withViewport = (m: MapSurfaceModel, viewport: Viewport): MapSurfaceModel => ({ ...m, camera: { ...m.camera, viewport } });

describe("補足とカメラ", () => {
  it("変更一覧の最後が補足でも、通常ノードを中心に選ぶ", () => {
    const supplement = { id: "s", parent: "B1", kind: "補足", text: "背景", evidence: ["r1"], origin: "会議の中" } satisfies SnapshotNode;
    const snapshot = snap([...baseNodes(), supplement], {
      round: 2, currentTopic: "B",
      changes: [change("B1", 2), { change: "追加", node: "s", kind: "補足", text: "背景", round: 2, at: 2 }],
    });
    expect(changedFocus(snapshot, (id) => id)?.center).toBe("B1");
    expect(cameraFocus({ ...snapshot, lastChanged: "s" })?.center).toBe("B1");
  });

  it("通常更新の後に補足だけ届いて高さを測り直しても、同じ画面の中心を補足へ移さない", () => {
    const normal = withChanges(["B1"], 2, { currentTopic: "B" });
    const supplement = { id: "s", parent: "B1", kind: "補足", text: "高さのある補足", evidence: ["r1"], origin: "会議の外" } satisfies SnapshotNode;
    const supplemented: Snapshot = { ...normal, nodes: [...normal.nodes, supplement] };
    let viewport: Viewport;
    story(update, given(settle(tree())),
      message(changed(normal)), message(tick(1000)),
      model((m) => { viewport = m.camera.viewport; }),
      message(changed(supplemented)), message(measure(SIZE, { ...HEIGHTS, s: 2000 })), message(tick(1000)),
      model((m) => expectViewport(m.camera.viewport, viewport)));
  });
});

describe("入力と前の見方から決まるカメラ", () => {
  type Mode = MapSurfaceModel["camera"]["mode"];
  type Case = {
    input: string;
    before: Mode;
    after: Mode;
    start: () => MapSurfaceModel;
    apply: (m: MapSurfaceModel) => MapSurfaceModel;
    expected: (before: MapSurfaceModel, after: MapSurfaceModel) => Viewport;
  };
  const modes: Mode[] = ["auto", "manual", "overview", "diff"];
  const inMode = (mode: Mode, scope: "live" | "review" = "live"): MapSurfaceModel => {
    const initial = settle(withChanges(["B1"]), scope);
    if (mode === "manual") return run(initial, scroll);
    if (mode === "overview") return run(initial, key("F"));
    if (mode === "diff") return run(initial, key("F"), key("F"));
    return initial;
  };
  const unchanged = (before: MapSurfaceModel) => before.camera.viewport;
  const clamped = (m: MapSurfaceModel) => zoomAroundCenter(m.camera.viewport, clampUserZoom(m.camera.viewport.zoom), sizeOf(m));
  const keys: ReadonlyArray<readonly [ViewKey, (m: MapSurfaceModel) => Viewport]> = [
    ["=", (m) => zoomAroundCenter(m.camera.viewport, clampUserZoom(m.camera.viewport.zoom * 1.25), sizeOf(m))],
    ["-", (m) => zoomAroundCenter(m.camera.viewport, clampUserZoom(m.camera.viewport.zoom / 1.25), sizeOf(m))],
    ["0", (m) => zoomAroundCenter(m.camera.viewport, clampUserZoom(1), sizeOf(m))],
    ["Shift+ArrowRight", (m) => panViewport(clamped(m), { dx: 1, dy: 0 }, sizeOf(m))],
    ["Shift+ArrowLeft", (m) => panViewport(clamped(m), { dx: -1, dy: 0 }, sizeOf(m))],
    ["Shift+ArrowUp", (m) => panViewport(clamped(m), { dx: 0, dy: -1 }, sizeOf(m))],
    ["Shift+ArrowDown", (m) => panViewport(clamped(m), { dx: 0, dy: 1 }, sizeOf(m))],
  ];
  const cases: Case[] = modes.flatMap((mode): Case[] => [
    ...keys.map(([pressed, expected]): Case => ({ input: pressed, before: mode, after: "manual", start: () => inMode(mode), apply: (m) => run(m, key(pressed)), expected })),
    { input: "F", before: mode, after: mode === "overview" ? "diff" : "overview", start: () => inMode(mode), apply: (m) => run(m, key("F")), expected: (_before, after) => mode === "overview" ? changedExpected(after) : overviewExpected(after) },
    { input: "Esc", before: mode, after: "auto", start: () => inMode(mode), apply: (m) => run(m, Message.PressedEscapeKey(mods)), expected: (_before, after) => focusExpected(after) },
    { input: "クリックで選ぶ", before: mode, after: mode, start: () => inMode(mode), apply: (m) => run(m, clickNode("A")), expected: unchanged },
    { input: "選択を外す", before: mode, after: mode, start: () => run(inMode(mode), clickNode("A")), apply: (m) => run(m, Message.ClickedEvidenceClose()), expected: unchanged },
    { input: "Z（選択あり）", before: mode, after: "manual", start: () => run(inMode(mode), clickNode("A")), apply: (m) => run(m, key("Z")), expected: (_before, after) => {
      const shown = shownOf(after);
      return subtreeViewport("A", { ids: shown.map((n) => n.id), parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])) }, targetsOf(after), dimsOf(after), sizeOf(after));
    } },
    { input: "Z（選択なし）", before: mode, after: mode, start: () => inMode(mode), apply: (m) => run(m, key("Z")), expected: unchanged },
    { input: "矢印で画面外の子を選ぶ", before: mode, after: "manual", start: () => run(inMode(mode), clickNode("A")), apply: (m) => run(m, Message.PressedArrowKey({ dir: "right", ...mods })), expected: (before, after) => revealViewport(clamped(before), nodeRect("A1", targetsOf(after), dimsOf(after)), sizeOf(after)) },
    { input: "縁の点", before: mode, after: "manual", start: () => inMode(mode), apply: (m) => run(m, Message.ClickedEdgeDot({ nodeId: "B3" })), expected: (before, after) => nodeFocusViewport(nodeRect("B3", targetsOf(after), dimsOf(after)), before.camera.viewport.zoom, sizeOf(after)) },
    { input: "変更項目", before: mode, after: "manual", start: () => inMode(mode), apply: (m) => run(m, Message.ClickedChangeItem({ nodeId: "B3" })), expected: (before, after) => nodeFocusViewport(nodeRect("B3", targetsOf(after), dimsOf(after)), before.camera.viewport.zoom, sizeOf(after)) },
    { input: "同じ議題の反映", before: mode, after: mode, start: () => inMode(mode), apply: (m) => run(m, changed(withChanges(["A1", "B3"], 3))), expected: (before, after) => mode === "manual" ? before.camera.viewport : mode === "overview" ? overviewExpected(after) : mode === "diff" ? changedExpected(after) : focusExpected(after) },
    { input: "議題が変わる反映", before: mode, after: "auto", start: () => inMode(mode), apply: (m) => run(m, changed(withChanges(["B3"], 3, { currentTopic: "B" }))), expected: (_before, after) => focusExpected(after) },
    { input: "議題がなくなる反映", before: mode, after: "auto", start: () => inMode(mode), apply: (m) => run(m, changed(snap(baseNodes(), { round: 3 }))), expected: (_before, after) => fitExpected(after) },
    { input: "ライブの時刻の移動", before: mode, after: mode, start: () => inMode(mode), apply: (m) => run(m, Message.MovedTime()), expected: unchanged },
    { input: "人のスクロール", before: mode, after: "manual", start: () => inMode(mode), apply: (m) => run(m, scroll), expected: (before) => zoomAroundCenter({ ...before.camera.viewport, x: before.camera.viewport.x - 20, y: before.camera.viewport.y - 50 }, clampUserZoom(before.camera.viewport.zoom), sizeOf(before)) },
    { input: "見返しの待ち時間", before: mode, after: mode === "manual" ? "auto" : mode, start: () => inMode(mode, "review"), apply: (m) => run(m, Message.ElapsedIdleTime()), expected: (before, after) => mode === "manual" ? focusExpected(after) : before.camera.viewport },
    { input: "見返しの時刻の移動", before: mode, after: "auto", start: () => inMode(mode, "review"), apply: (m) => run(m, Message.MovedTime()), expected: (before, after) => mode === "auto" ? before.camera.viewport : focusExpected(after) },
  ]);
  const afterQuietReflection = (): MapSurfaceModel => {
    const start = settle(foldable({ lastChanged: "B1" }));
    const quiet = snap([...foldable().nodes, node("B2", "B", "論点")], { round: 2, currentTopic: "B", now: 100 });
    const next = run(start, changed(quiet));
    expect(next.camera.mode).toBe("auto");
    expectViewport(next.camera.viewport, start.camera.viewport);
    expectDifferent(focusExpected(next), next.camera.viewport);
    return next;
  };
  const refocusedAfterQuiet = (before: MapSurfaceModel, after: MapSurfaceModel): Viewport => {
    const expected = focusExpected(after);
    expectDifferent(expected, before.camera.viewport);
    return expected;
  };
  cases.push(
    { input: "空の反映の後の画面サイズ変更", before: "auto", after: "auto", start: afterQuietReflection, apply: (m) => {
      const next = run(m, measure(SMALL, {}));
      expectDifferent(focusExpected(next), focusExpected(m));
      return next;
    }, expected: refocusedAfterQuiet },
    { input: "空の反映の後のノードの高さ変更", before: "auto", after: "auto", start: afterQuietReflection, apply: (m) => {
      const next = run(m, measure(SIZE, { B: 200 }));
      expectDifferent(focusExpected(next), focusExpected(m));
      return next;
    }, expected: refocusedAfterQuiet },
    { input: "空の反映の後の選択による畳み変更", before: "auto", after: "auto", start: afterQuietReflection, apply: (m) => {
      expect(shownOf(m).map((n) => n.id)).not.toContain("A1");
      const next = run(m, clickNode("A1"));
      expect(shownOf(next).map((n) => n.id)).toContain("A1");
      expectDifferent(focusExpected(next), focusExpected(m));
      return next;
    }, expected: refocusedAfterQuiet },
    { input: "空の反映の後の Esc", before: "auto", after: "auto", start: afterQuietReflection, apply: (m) => run(m, Message.PressedEscapeKey(mods)), expected: refocusedAfterQuiet },
  );
  for (const mode of modes) {
    cases.push({ input: "空の反映そのもの", before: mode, after: mode, start: () => inMode(mode), apply: (m) => run(m, changed(tree({ round: 3 }))), expected: unchanged });
  }
  for (const [input, toggle] of [["丸で開いて畳む", clickFoldDot("A")], ["Enterで開いて畳む", Message.PressedEnterKey(mods)]] as const) {
    cases.push({
      input,
      before: "diff",
      after: "diff",
      start: () => run(settle(foldable({ round: 2, changes: [change("B1", 2)], lastChanged: "B1" })), clickNode("A"), key("F"), key("F")),
      apply: (start) => {
        expect(displayedPositions(start)["A1"]).toBeUndefined();
        expect(displayedPositions(start)["A2"]).toBeUndefined();
        let current = start;
        for (const open of [true, false]) {
          const before = current;
          const position = displayedPositions(before)["A"]!;
          const point = screenPoint(before.camera.viewport, position);
          current = run(current, toggle);
          for (const elapsed of [0, 250, 500]) {
            if (elapsed > 0) current = run(current, tick(250));
            const positions = displayedPositions(current);
            const actual = screenPoint(current.camera.viewport, positions["A"]!);
            expect(current.camera.mode).toBe("diff");
            expect(current.camera.viewport.zoom).toBe(before.camera.viewport.zoom);
            expect(actual.x).toBeCloseTo(point.x, 6);
            expect(actual.y).toBeCloseTo(point.y, 6);
            expect(["A1", "A2"].map((id) => positions[id] !== undefined)).toEqual([open, open]);
            if (elapsed > 0) expectDifferent({ ...positions["A"]!, zoom: 1 }, { ...position, zoom: 1 });
          }
        }
        return current;
      },
      expected: (before, after) => anchoredViewport(before.camera.viewport, displayedPositions(after)["A"]!, screenPoint(before.camera.viewport, displayedPositions(before)["A"]!)),
    });
  }
  for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
    for (const pressed of [...keys.map(([key]) => key), "F", "Z"] satisfies ViewKey[]) {
      cases.push({ input: `${modifier}＋${pressed}`, before: "manual", after: "manual", start: () => run(inMode("manual"), clickNode("A")), apply: (m) => run(m, key(pressed, { [modifier]: true })), expected: unchanged });
    }
    cases.push({ input: `${modifier}＋Esc`, before: "manual", after: "manual", start: () => inMode("manual"), apply: (m) => run(m, Message.PressedEscapeKey({ ...mods, [modifier]: true })), expected: unchanged });
    cases.push({ input: `空の反映の後の ${modifier}＋Esc`, before: "auto", after: "auto", start: afterQuietReflection, apply: (m) => run(m, Message.PressedEscapeKey({ ...mods, [modifier]: true })), expected: unchanged });
  }
  // C は親画面で字幕を切り替えるため、実際の親のキー経路を通す。
  const parentKey = (surface: MapSurfaceModel, key: "?" | "C"): MapSurfaceModel => {
    const initial = Meeting.update(Meeting.init(false), MeetingMessage.GotLiveFeedMessage({ message: LiveFeedMessage.ReceivedLiveFrame({ frame: { type: "snapshot", snapshot: surface.snapshot }, receivedAt: 0 }) })).model;
    const session = Option.getOrThrow(initial.session);
    const parent = { ...initial, session: Option.some({ ...session, mapSurface: surface }) };
    const result = Meeting.update(parent, MeetingMessage.PressedKey({ key, ...mods })).model;
    const next = Option.getOrThrow(result.session);
    if (key === "?") expect(next.keyList.isOpen).toBe(true);
    else expect(next.sessionLayout.captionsHidden).toBe(!session.sessionLayout.captionsHidden);
    return { ...surface, ...next.mapSurface };
  };
  for (const mode of modes) {
    for (const key of ["?", "C"] as const) cases.push({ input: key, before: mode, after: mode, start: () => inMode(mode), apply: (m) => parentKey(m, key), expected: unchanged });
  }
  const narrow = { width: 500, height: 400 };
  const shiftExpected = (m: MapSurfaceModel) => shiftIntoView(m.camera.viewport, cameraFocus(m.snapshot)!.ids.map((id) => nodeRect(id, targetsOf(m), dimsOf(m))), narrow);
  const beforeSide = (m: MapSurfaceModel): MapSurfaceModel => ({ ...withViewport(m, { x: 100, y: 0, zoom: 1 }), viewing: { ...m.viewing, sideHidden: true } });
  const unrelated: ReadonlyArray<readonly [string, (m: MapSurfaceModel) => MapSurfaceModel]> = [
    ["?", (m) => parentKey(m, "?")],
    ["C", (m) => parentKey(m, "C")],
    ["クリックで選ぶ", (m) => run(m, clickNode("B"))],
    ["選択を外す", (m) => run(m, Message.ClickedEvidenceClose())],
    ...(["metaKey", "ctrlKey", "altKey"] as const).map((modifier): readonly [string, (m: MapSurfaceModel) => MapSurfaceModel] => [
      `${modifier}＋=`, (m) => run(m, key("=", { [modifier]: true })),
    ]),
  ];
  const nonAutomatic: ReadonlyArray<Exclude<Mode, "auto">> = ["manual", "overview", "diff"];
  const foldMode = (initial: MapSurfaceModel, mode: Exclude<Mode, "auto">): MapSurfaceModel =>
    mode === "manual" ? run(initial, scroll) : mode === "overview" ? run(initial, key("F")) : run(initial, key("F"), key("F"));
  const beforeFold = (mode: Exclude<Mode, "auto">): MapSurfaceModel =>
    run(foldMode(settle(foldable({ round: 2, changes: [change("B1", 2)], lastChanged: "B1" })), mode), clickNode("A"), tick(500));
  cases.push(...nonAutomatic.flatMap((mode): Case[] => {
    const rows: Case[] = [];
    for (const pressed of ["F", "Z"] as const) {
      rows.push({
        input: `開閉の途中の ${pressed} を優先する`,
        before: mode,
        after: pressed === "Z" ? "manual" : mode === "overview" ? "diff" : "overview",
        start: () => run(beforeFold(mode), clickFoldDot("A"), tick(100)),
        apply: (before) => {
          const moved = run(before, key(pressed));
          const expected = pressed === "F"
            ? mode === "overview" ? changedExpected(moved) : overviewExpected(moved)
            : subtreeViewport("A", { ids: shownOf(moved).map((n) => n.id), parents: Object.fromEntries(shownOf(moved).map((n) => [n.id, n.parent])) }, targetsOf(moved), dimsOf(moved), sizeOf(moved));
          expectViewport(moved.camera.viewport, expected);
          expectDifferent(moved.camera.viewport, before.camera.viewport);
          const after = run(moved, tick(150), tick(250));
          expectViewport(after.camera.viewport, moved.camera.viewport);
          return after;
        },
        expected: (before) => run(before, key(pressed)).camera.viewport,
      });
    }
    rows.push({
      input: "開閉の途中の空でない反映で保持を外す",
      before: mode,
      after: mode,
      start: () => run(beforeFold(mode), clickFoldDot("A"), tick(100)),
      apply: (before) => {
        const snapshot = foldable({ round: 3, changes: [change("B1", 3)], lastChanged: "B1" });
        const reflected = run(before, changed(snapshot));
        const expected = mode === "manual" ? before.camera.viewport : mode === "overview" ? overviewExpected(reflected) : changedExpected(reflected);
        expectViewport(reflected.camera.viewport, expected);
        const after = run(reflected, tick(500));
        expectDifferent({ ...displayedPositions(after)["A"]!, zoom: 1 }, { ...displayedPositions(reflected)["A"]!, zoom: 1 });
        expectViewport(after.camera.viewport, expected);
        return after;
      },
      expected: (before, after) => mode === "manual" ? before.camera.viewport : mode === "overview" ? overviewExpected(after) : changedExpected(after),
    });
    for (const [input, apply] of unrelated) {
      rows.push({
        input: `開閉の途中の ${input} で画面座標を保つ`,
        before: mode,
        after: mode,
        start: () => beforeFold(mode),
        apply: (start) => {
          let current = start;
          for (const open of [true, false]) {
            const before = current;
            const point = screenPoint(before.camera.viewport, displayedPositions(before)["A"]!);
            current = run(current, clickFoldDot("A"), tick(100));
            expectDifferent({ ...displayedPositions(current)["A"]!, zoom: 1 }, { ...targetsOf(current)["A"]!, zoom: 1 });
            const intermediate = current;
            current = apply(current);
            for (const deltaMs of [0, 150, 250]) {
              if (deltaMs > 0) current = run(current, tick(deltaMs));
              const at = screenPoint(current.camera.viewport, displayedPositions(current)["A"]!);
              expect(current.camera.mode).toBe(mode);
              expect(current.camera.viewport.zoom).toBe(before.camera.viewport.zoom);
              expect(at.x).toBeCloseTo(point.x, 6);
              expect(at.y).toBeCloseTo(point.y, 6);
              expect(displayedPositions(current)["A1"] !== undefined).toBe(open);
            }
            expectDifferent({ ...displayedPositions(current)["A"]!, zoom: 1 }, { ...displayedPositions(intermediate)["A"]!, zoom: 1 });
          }
          return current;
        },
        expected: (before, after) => anchoredViewport(before.camera.viewport, displayedPositions(after)["A"]!, screenPoint(before.camera.viewport, displayedPositions(before)["A"]!)),
      });
    }
    for (const [input, apply] of unrelated.filter(([input]) => input === "クリックで選ぶ" || input === "選択を外す")) {
      rows.push({
        input: `畳む途中の ${input} でまとめに移っても画面座標を保つ`,
        before: mode,
        after: mode,
        start: () => {
          const snapshot = snap([
            node("root", null, "会議"), node("A", "root"), node("A1", "A", "論点"), node("A2", "A", "論点"),
            node("D", "root", "議題", { talkStatus: "済み" }), node("B", "root"), node("B1", "B", "論点"),
          ], { round: 2, currentTopic: "B", changes: [change("B1", 2)], lastChanged: "B1", now: 100 });
          return run(foldMode(settle(snapshot), mode), measure(SIZE, { D: 60, "run:A": 50 }), tick(500), clickNode("A"));
        },
        apply: (before) => {
          const point = screenPoint(before.camera.viewport, displayedPositions(before)["A"]!);
          let current = run(before, clickFoldDot("A"), tick(100));
          expect(shownOf(current).map((n) => n.id)).toContain("A");
          current = apply(current);
          expect(shownOf(current).find((n) => n.id === "run:A")?.text).toBe("議題 2 件");
          expect(displayedPositions(current)["A"]).toBeUndefined();
          const intermediate = displayedPositions(current)["run:A"]!;
          expectDifferent({ ...intermediate, zoom: 1 }, { ...targetsOf(current)["run:A"]!, zoom: 1 });
          for (const deltaMs of [0, 250, 250]) {
            if (deltaMs > 0) current = run(current, tick(deltaMs));
            const at = screenPoint(current.camera.viewport, displayedPositions(current)["run:A"]!);
            expect(current.camera.mode).toBe(mode);
            expect(current.camera.viewport.zoom).toBe(before.camera.viewport.zoom);
            expect(at.x).toBeCloseTo(point.x, 6);
            expect(at.y).toBeCloseTo(point.y, 6);
          }
          expectDifferent({ ...displayedPositions(current)["run:A"]!, zoom: 1 }, { ...intermediate, zoom: 1 });
          return current;
        },
        expected: (before, after) => anchoredViewport(before.camera.viewport, displayedPositions(after)["run:A"]!, screenPoint(before.camera.viewport, displayedPositions(before)["A"]!)),
      });
    }
    rows.push({
      input: "畳む途中の選択解除でまとめが替わっても測り直しまで画面座標を保つ",
      before: mode,
      after: mode,
      start: () => {
        const snapshot = snap([
          node("root", null, "会議"), node("X", "root", "議題", { talkStatus: "済み" }),
          node("A", "root"), node("A1", "A", "論点"), node("A2", "A", "論点"),
          node("D", "root", "議題", { talkStatus: "済み" }), node("B", "root"), node("B1", "B", "論点"),
        ], { round: 2, currentTopic: "B", changes: [change("B1", 2)], lastChanged: "B1", now: 100 });
        const opened = run(settle(snapshot), clickNode("A"), Message.PressedEnterKey(mods), Message.PressedEnterKey(mods),
          measure(SIZE, { root: 200, X: 60, D: 60, "run:A": 50, "run:X": 50 }), tick(500));
        return run(foldMode(opened, mode), clickNode("X"), tick(500));
      },
      apply: (before) => {
        const point = screenPoint(before.camera.viewport, displayedPositions(before)["A"]!);
        const expectAnchor = (current: MapSurfaceModel, id: string) => {
          const at = screenPoint(current.camera.viewport, displayedPositions(current)[id]!);
          expect(current.camera.mode).toBe(mode);
          expect(current.camera.viewport.zoom).toBe(before.camera.viewport.zoom);
          expect(at.x).toBeCloseTo(point.x, 6);
          expect(at.y).toBeCloseTo(point.y, 6);
        };
        let current = run(before, clickFoldDot("A"), tick(100));
        expect(Option.getOrThrow(current.camera.keepAnchor).id).toBe("run:A");
        expect(shownOf(current).find((n) => n.id === "run:A")?.text).toBe("議題 2 件");
        expectAnchor(current, "run:A");
        expectAnchor(run(current, key("=", { metaKey: true })), "run:A");
        current = run(current, Message.ClickedEvidenceClose());
        expect(shownOf(current).find((n) => n.id === "run:X")?.text).toBe("議題 3 件");
        expect(displayedPositions(current)["run:A"]).toBeUndefined();
        expect(displayedPositions(current)["A"]).toBeUndefined();
        expectAnchor(current, "run:X");
        const intermediate = displayedPositions(current)["run:X"]!;
        current = run(current, tick(250));
        expectAnchor(current, "run:X");
        current = run(current, tick(250));
        expectAnchor(current, "run:X");
        expectDifferent({ ...displayedPositions(current)["run:X"]!, zoom: 1 }, { ...intermediate, zoom: 1 });
        const beforeMeasurement = displayedPositions(current)["run:X"]!;
        current = run(current, measure(SIZE, { "run:X": 180 }));
        expectDifferent({ ...targetsOf(current)["run:X"]!, zoom: 1 }, { ...beforeMeasurement, zoom: 1 });
        expectAnchor(current, "run:X");
        current = run(current, tick(250));
        expectAnchor(current, "run:X");
        current = run(current, tick(250));
        expectAnchor(current, "run:X");
        return current;
      },
      expected: (before, after) => anchoredViewport(before.camera.viewport, displayedPositions(after)["run:X"]!, screenPoint(before.camera.viewport, displayedPositions(before)["A"]!)),
    });
    return rows;
  }));
  for (const mode of modes) {
    for (const [input, apply] of unrelated) {
      cases.push({
        input: `列幅を測る前の ${input}`,
        before: mode,
        after: mode,
        start: () => beforeSide(run(inMode(mode), clickNode("A"))),
        apply: (m) => {
          const shown = run(m, Message.PressedSideKey(mods));
          expectViewport(shown.camera.viewport, m.camera.viewport);
          const next = apply(shown);
          expect(next.camera.mode).toBe(mode);
          expectViewport(next.camera.viewport, m.camera.viewport);
          expectDifferent(shiftExpected(next), m.camera.viewport);
          return run(next, measure(narrow, {}));
        },
        expected: (before) => shiftExpected(before),
      });
    }
    if (mode === "auto") continue;
    cases.push({
      input: "開閉の途中で E、幅の計測、補間の完了",
      before: mode,
      after: mode,
      start: () => {
        const initial = settle(foldable({ round: 2, changes: [change("B1", 2)], lastChanged: "B1" }));
        const current = mode === "manual" ? run(initial, scroll) : mode === "overview" ? run(initial, key("F")) : run(initial, key("F"), key("F"));
        return run(beforeSide(current), clickFoldDot("A"), tick(100));
      },
      apply: (m) => {
        expectDifferent({ ...displayedPositions(m)["A"]!, zoom: 1 }, { ...targetsOf(m)["A"]!, zoom: 1 });
        const shown = run(m, Message.PressedSideKey(mods));
        expectViewport(shown.camera.viewport, m.camera.viewport);
        const expected = shiftExpected(shown);
        expectDifferent(expected, shown.camera.viewport);
        const measured = run(shown, measure(narrow, {}));
        expectViewport(measured.camera.viewport, expected);
        return run(measured, tick(500));
      },
      expected: (before) => shiftExpected(before),
    });
  }
  const cancellations: ReadonlyArray<readonly [string, Msg, Mode]> = [
    ["人のスクロール", scroll, "manual"],
    ["mode を変える F", key("F"), "overview"],
    ["1 回きりの Z", key("Z"), "manual"],
    ["空でない反映", changed(withChanges(["B3"], 3)), "manual"],
  ];
  for (const [input, message, after] of cancellations) {
    cases.push({
      input: `E の後に ${input} で保留を消す`,
      before: "manual",
      after,
      start: () => beforeSide(run(inMode("manual"), clickNode("A"))),
      apply: (m) => {
        const shown = run(m, Message.PressedSideKey(mods));
        expectDifferent(shiftExpected(shown), shown.camera.viewport);
        const canceled = run(shown, message);
        const expected = after === "overview" ? overviewExpected({ ...canceled, size: Option.some(narrow) }) : canceled.camera.viewport;
        expectDifferent(shiftExpected(canceled), expected);
        return run(canceled, measure(narrow, {}));
      },
      expected: (before, after) => after.camera.mode === "overview" ? overviewExpected(after) : run(before, message).camera.viewport,
    });
  }

  it.each(cases)("$input × $before → $after と期待の viewport", ({ before, after, start, apply, expected }) => {
    const initial = start();
    expect(initial.camera.mode).toBe(before);
    const next = apply(initial);
    expect(next.camera.mode).toBe(after);
    expectViewport(next.camera.viewport, expected(initial, next));
  });
});

describe("更新後の畳み結果を共有する", () => {
  it("隠れた変更項目を選ぶと、その枝が開き選択先へ寄る", () => {
    const start = settle(foldable());
    expect(displayedPositions(start)["A1"]).toBeUndefined();
    const after = update(start, Message.ClickedChangeItem({ nodeId: "A1" })).model;
    expect(displayedPositions(after)["A1"]).toBeDefined();
    expect(after.viewing.selection).toEqual({ id: "A1", byKey: false });
    expectViewport(after.camera.viewport, nodeFocusViewport(nodeRect("A1", targetsOf(after), dimsOf(after)), start.camera.viewport.zoom, SIZE));
  });
});

describe("カメラの Model: 欄の初期値と本物の Schema", () => {
  it("初期は viewport (0, 0, 倍率 1)。出来事の履歴で決まる事実は「無い」（Option の None・false）で、idleStamp は有限の数", () => {
    const m = init(tree(), "live", false);
    expect(m.camera.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(Option.isNone(m.camera.placedRound)).toBe(true);
    expect(Option.isNone(m.camera.keepAnchor)).toBe(true);
    expect(m.camera.pendingShift).toBe(false);
    expect(Number.isFinite(m.idleStamp)).toBe(true);
  });

  it("「無い」を null で書いたカメラの欄・形の違う欄は通らず、値を持つ欄は通る", () => {
    const is = Schema.is(Model);
    const m = init(tree(), "live", false);
    expect(is(m)).toBe(true);
    expect(is({ ...m, camera: { ...m.camera, placedRound: Option.some(2), keepAnchor: Option.some({ id: "A", point: { x: 3, y: 4 } }), pendingShift: true } })).toBe(true);
    expect(is({ ...m, camera: { ...m.camera, placedRound: null } })).toBe(false);
    expect(is({ ...m, camera: { ...m.camera, keepAnchor: null } })).toBe(false);
    expect(is({ ...m, camera: { ...m.camera, keepAnchor: Option.some({ id: "A", point: { x: "3", y: 4 } }) } })).toBe(false);
    expect(is({ ...m, camera: { ...m.camera, pendingShift: "yes" } })).toBe(false);
  });
});

describe("反映で寄せる: 反映（round の変化）を見る状態へ渡す", () => {
  it("止めている（manual）間に、今の議題が変わる反映が来ると、自動に戻り、新しい今の議題へ寄る", () => {
    const start = settle(tree());
    story(
      update,
      given(start),
      message(scroll),
      model((m) => expect(cameraViewOf(m)).toEqual(manualAt("A"))),
      message(changed(tree({ round: 2, currentTopic: "B", lastChanged: "B1" }))),
      model((m) => {
        expect(cameraViewOf(m)).toEqual({ mode: "auto" });
        expect(m.snapshot.currentTopic).toBe("B");
        expectViewport(m.camera.viewport, focusExpected(m));
        expectDifferent(m.camera.viewport, start.camera.viewport);
      }),
    );
  });

  it("止めている間に、同じ今の議題のままの反映が来ても、止めたまま（manual のまま）", () => {
    story(
      update,
      given(settle(tree())),
      message(scroll),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      model((m) => expect(cameraViewOf(m)).toEqual(manualAt("A"))),
    );
  });

  it("round が変わらない Snapshot の差し替えは反映ではないので、今の議題が変わっても止めたまま", () => {
    story(
      update,
      given(settle(tree())),
      message(scroll),
      message(changed(tree({ currentTopic: "B" }))),
      model((m) => expect(cameraViewOf(m)).toEqual(manualAt("A"))),
    );
  });

  it("選んでいたノードが反映で消えたら、選択が親（relocations の移り先）に替わる。木は反映の後の Snapshot で作る", () => {
    const withoutB2 = snap(
      baseNodes().filter((n) => n.id !== "B2"),
      { round: 2, currentTopic: "A" },
    );
    story(
      update,
      given(settle(tree())),
      message(clickNode("B2")),
      model((m) => expect(m.viewing.selection).toEqual({ id: "B2", byKey: false })),
      message(changed(withoutB2)),
      model((m) => expect(m.viewing.selection).toEqual({ id: "B", byKey: false })),
    );
  });

  it("止めている間でも、選んでいたノードが消えれば選択は移り先に替わる（止めたまま）", () => {
    const withoutB2 = snap(
      baseNodes().filter((n) => n.id !== "B2"),
      { round: 2, currentTopic: "A" },
    );
    story(
      update,
      given(settle(tree())),
      message(clickNode("B2")),
      message(scroll),
      message(changed(withoutB2)),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "B", byKey: false });
        expect(m.camera.mode).toBe("manual");
      }),
    );
  });

  it("1 つの Message の中で、反映（選択の移し替え・自動に戻す）→ 寄せる の順に働き、寄せ先は反映の後の Snapshot と選択で決まる", () => {
    const withoutB2 = snap(
      baseNodes().filter((n) => n.id !== "B2"),
      { round: 2, currentTopic: "B", lastChanged: "B1" },
    );
    const start = settle(tree());
    story(
      update,
      given(start),
      message(clickNode("B2")),
      message(scroll),
      message(changed(withoutB2)),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "B", byKey: false });
        expect(m.camera.mode).toBe("auto");
        expectViewport(m.camera.viewport, focusExpected(m));
        expectDifferent(m.camera.viewport, start.camera.viewport);
      }),
    );
  });
});

describe("反映で寄せる: 自動のとき今の議題へ寄せる・今の議題が無ければ全体を収める", () => {
  it("測ると、今の議題（と祖先・子孫）を、倍率 0.75〜1.1 で画面に収める位置になる。全体を収めた位置とは違う", () => {
    const m = settle(tree());
    expect(cameraViewOf(m)).toEqual({ mode: "auto" });
    expectViewport(m.camera.viewport, focusExpected(m));
    expectDifferent(m.camera.viewport, fitExpected(m));
  });

  it("変化の付いた反映（lastChanged あり）で今の議題が変わると、新しい今の議題へ寄る（目標の位置で測る）", () => {
    const start = settle(tree());
    story(
      update,
      given(start),
      message(changed(tree({ round: 2, currentTopic: "B", lastChanged: "B3" }))),
      model((m) => {
        expectViewport(m.camera.viewport, focusExpected(m));
        expectDifferent(m.camera.viewport, start.camera.viewport);
        expect(cameraViewOf(m)).toEqual({ mode: "auto" });
      }),
    );
  });

  it("変化の無い反映（lastChanged も、その round の変更も無い）では、寄せ直さない。変化の付く反映では、同じ構成でも寄せ直す", () => {
    const start = settle(tree());
    // 今の議題の下にノードが増えているので、寄せ直せば寄せ先は変わる（変わらないことで、寄せ直していないと分かる）
    const quiet = update(start, changed(withSilentNode())).model;
    expect(quiet.camera.viewport).toEqual(start.camera.viewport);
    const noisy = update(start, changed(withSilentNode({ lastChanged: "A3" }))).model;
    expectViewport(noisy.camera.viewport, focusExpected(noisy));
    expectDifferent(noisy.camera.viewport, start.camera.viewport);
  });

  it("その round の変更の記録が付いた反映でも寄せ直す", () => {
    const start = settle(tree());
    const m = update(start, changed(withSilentNode({ changes: [{ change: "追加", node: "A3", kind: "論点", text: "A3", round: 2, at: 0 } as Snapshot["changes"][number]] }))).model;
    expectViewport(m.camera.viewport, focusExpected(m));
    expectDifferent(m.camera.viewport, start.camera.viewport);
  });

  it("空の反映では動かず、続く変化のある反映で今の議題へ寄る", () => {
    const start = settle(foldable({ lastChanged: "B1" }));
    const quiet = snap([...foldable().nodes, node("B2", "B", "論点")], { round: 2, currentTopic: "B", now: 100 });
    story(
      update,
      given(start),
      message(changed(quiet)),
      model((m) => expect(m.camera.viewport).toEqual(start.camera.viewport)),
      message(changed({ ...quiet, round: 3, lastChanged: "B2" })),
      model((m) => {
        expectViewport(m.camera.viewport, focusExpected(m));
        expectDifferent(m.camera.viewport, start.camera.viewport);
      }),
    );
  });

  it("同じ round の測り直し（実寸が届いた）では、変化が無くても寄せ直す", () => {
    const start = settle(tree());
    const m = update(start, measure(SIZE, { A: 200 })).model;
    expect(heightsOf(m)["A"]).toBe(200);
    expectViewport(m.camera.viewport, focusExpected(m));
    expectDifferent(m.camera.viewport, start.camera.viewport);
  });

  it("寄せ先の箱は、畳まれて見えないノードを、それを隠している畳んだノードに置き換えて測る（位置の無い ID を原点で測らない）", () => {
    // 今の議題 B の子の議題 C（済み）は畳まれ、C1 は隠れる。C1 は寄せ先の子孫に入るが、見せているのは C
    const snapshot = snap(
      [node("root", null, "会議"), node("A", "root"), node("B", "root"), node("B1", "B", "論点"), node("C", "B", "議題", { talkStatus: "済み" }), node("C1", "C", "論点")],
      { currentTopic: "B", now: 100 },
    );
    const m = update(init(snapshot, "live", false), measure(SIZE, { root: 40, A: 60, B: 60, B1: 60, C: 60, C1: 60 })).model;
    const view = viewOf(m)!;
    expect(view.shownAs["C1"]).toBe("C");
    expect(cameraFocus(m.snapshot)!.ids).toContain("C1");
    expectViewport(m.camera.viewport, focusExpected(m));
  });

  it("今の議題が無い反映では、全体を収める（ふだんは下限 0.5）。今の議題が戻った反映は、変化が無くても寄せる", () => {
    const start = settle(tree());
    story(
      update,
      given(start),
      message(changed(snap(baseNodes(), { round: 2 }))),
      model((m) => {
        expectViewport(m.camera.viewport, fitExpected(m));
        expect(cameraViewOf(m)).toEqual({ mode: "auto" });
      }),
      message(changed(tree({ round: 3 }))),
      model((m) => expectViewport(m.camera.viewport, focusExpected(m))),
    );
  });

  it("撮影（still）は今の議題があっても全体を収め、下限は 0.02（大きなマップも収める）", () => {
    const m = settle(tree(), "still", SMALL);
    expectViewport(m.camera.viewport, fitExpected(m));
    expect(m.camera.viewport.zoom).toBeLessThan(0.5);
    expect(cameraViewOf(m)).toEqual({ mode: "auto" });
  });

  it("今の議題が無いとき、ふだん（live）の全体の収め方は倍率 0.5 で止まる", () => {
    const m = settle(snap(baseNodes()), "live", SMALL);
    expect(m.camera.viewport.zoom).toBe(0.5);
    expectViewport(m.camera.viewport, fitExpected(m));
  });

  it("今の議題が無いと、補間のフレームごとに、そのときの（補間中の）位置で全体を収め直し、補間が終わると目標の位置で収める", () => {
    const start = settle(snap(baseNodes()));
    story(
      update,
      given(start),
      message(changed(snap([...baseNodes(), node("A3", "A", "論点")], { round: 2 }))),
      model((m) => {
        expect(Option.isSome(m.motion)).toBe(true);
        // この入力は、補間中の位置で収めた値が、目標の位置で収めた値と違うものでなければ検証にならない
        expectDifferent(fitExpected(m, displayedPositions(m)), fitExpected(m));
        expectViewport(m.camera.viewport, fitExpected(m, displayedPositions(m)));
      }),
      message(tick(100)),
      model((m) => expectViewport(m.camera.viewport, fitExpected(m, displayedPositions(m)))),
      message(tick(150)),
      model((m) => expectViewport(m.camera.viewport, fitExpected(m, displayedPositions(m)))),
      message(tick(500)),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
        expectViewport(m.camera.viewport, fitExpected(m));
      }),
    );
  });

  it("今の議題があるときは、補間のフレームでは動かさない（寄せ先は目標の位置で測るので変わらない）", () => {
    const start = settle(tree());
    story(
      update,
      given(start),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      model((m) => expect(Option.isSome(m.motion)).toBe(true)),
      message(tick(100)),
      model((m) => expectViewport(m.camera.viewport, focusExpected(m))),
    );
  });
});

describe("人が動かすと止まる: パン・ズームで見る状態の userMoved を渡す", () => {
  const press = Message.PressedMapSurface({ clientX: 100, clientY: 100, button: 0, ctrlKey: false, insideNoPan: false });
  const POINT = { x: 300, y: 200 };
  const moves: ReadonlyArray<readonly [string, ReadonlyArray<Msg>]> = [
    ["二本指スクロール", [scroll]],
    ["⌘/Ctrl＋Shift＋スクロール（軸固定）", [wheel({ deltaX: 30, deltaY: 5, shiftKey: true, metaKey: true, timeStamp: 1000 })]],
    ["Ctrl＋ホイール（ピンチ）", [wheel({ ctrlKey: true, deltaY: -100, ...POINT })]],
    ["⌘＋クリック", [Message.ClickedMapSurfaceWithModifier({ ...POINT, ctrlKey: false, metaKey: true, altKey: false })]],
    ["Safari の gesture", [Message.StartedMapSurfaceGesture(), Message.ChangedMapSurfaceGesture({ scale: 1.3, ...POINT })]],
    ["空いたところのドラッグ", [press, Message.MovedPointer({ clientX: 130, clientY: 90, buttons: 1 })]],
  ];

  it("パンとズームの各入力経路は手動になり、続く同じ議題の反映・実測・補間で viewport を動かさない", () => {
    for (const [name, inputs] of moves) {
      const start = settle(tree());
      const moved = run(start, ...inputs);
      expect(cameraViewOf(moved), name).toEqual(manualAt("A"));
      expectDifferent(moved.camera.viewport, start.camera.viewport);
      // 今の議題の下にノードが増えた反映と、実寸の変化で、自動のままなら寄せ先が変わる
      story(
        update,
        given(moved),
        message(changed(withSilentNode({ lastChanged: "A3" }))),
        model((m) => {
          expect(m.camera.viewport).toEqual(moved.camera.viewport);
          expect(cameraViewOf(m)).toEqual(manualAt("A"));
        }),
        message(measure(SIZE, { A: 200, A1: 120 })),
        model((m) => expect(m.camera.viewport).toEqual(moved.camera.viewport)),
        message(tick(100)),
        model((m) => expect(m.camera.viewport).toEqual(moved.camera.viewport)),
      );
    }
  });

  it("押しただけ（動かしていない）では、自動のカメラを止めない", () => {
    story(
      update,
      given(settle(tree())),
      message(press),
      model((m) => expect(cameraViewOf(m)).toEqual({ mode: "auto" })),
    );
  });

  it("still は人のパン・ズームを受けず、見る状態も変えない", () => {
    const start = settle(tree(), "still");
    const m = run(start, scroll, wheel({ ctrlKey: true, deltaY: -100, ...POINT }), press, Message.MovedPointer({ clientX: 130, clientY: 90, buttons: 1 }));
    expect(m.camera.viewport).toEqual(start.camera.viewport);
    expect(cameraViewOf(m)).toEqual({ mode: "auto" });
  });

  it("全体を見ていて 0.5 未満の倍率から動かすと、人の倍率の範囲（0.5）に収めてから manual になる", () => {
    const overview = run(settle(tree(), "live", SMALL), key("F"));
    expect(overview.camera.viewport.zoom).toBeLessThan(0.5);
    story(
      update,
      given(overview),
      message(scroll),
      model((m) => {
        expect(cameraViewOf(m)).toEqual(manualAt("A"));
        expect(m.camera.viewport.zoom).toBeCloseTo(0.5, 9);
      }),
    );
  });

  it("0.5 以上の倍率からは、倍率を変えない（スクロールは平行移動だけ）", () => {
    const start = settle(tree());
    const m = update(start, scroll).model;
    expect(m.camera.viewport.zoom).toBe(start.camera.viewport.zoom);
    expect(m.camera.viewport.x).toBeCloseTo(start.camera.viewport.x - 20, 9);
    expect(m.camera.viewport.y).toBeCloseTo(start.camera.viewport.y - 50, 9);
  });
});

describe("全体を見て、もう一度で変わったところへ寄る", () => {
  // 今の議題 A の外（B1）が最後の反映で変わった。自動のカメラは A に寄るので、B1 は寄せ先に入らない
  const outside = () => settle(withChanges(["B1"]));

  it("止めている位置から F を押すと、全体を目標の位置で収めた viewport になり（見る状態は overview）、もう一度 F で、変わったノードへ寄る viewport になって diff になる（止めていた位置へは戻らない）", () => {
    const start = outside();
    story(
      update,
      given(start),
      message(scroll),
      model((m) => expect(cameraViewOf(m)).toEqual(manualAt("A"))),
      message(key("F")),
      model((m) => {
        expect(m.camera.mode).toBe("overview");
        expectViewport(m.camera.viewport, overviewExpected(m));
      }),
      message(key("F")),
      model((m) => {
        expect(cameraViewOf(m)).toEqual({ mode: "diff", topic: "A" });
        expectViewport(m.camera.viewport, changedExpected(m));
        // 止めていた位置でも、自動のカメラが寄る今の議題でもない
        expectDifferent(m.camera.viewport, update(start, scroll).model.camera.viewport);
        expectDifferent(m.camera.viewport, focusExpected(m));
      }),
    );
  });

  it("自動から F・F でも同じ。diff になり、変わったノード（議題の外の B1）へ寄る", () => {
    story(
      update,
      given(outside()),
      message(key("F")),
      model((m) => expect(m.camera.mode).toBe("overview")),
      message(key("F")),
      model((m) => {
        expect(cameraViewOf(m)).toEqual({ mode: "diff", topic: "A" });
        expectViewport(m.camera.viewport, changedExpected(m));
        expectDifferent(m.camera.viewport, focusExpected(m));
      }),
    );
  });

  it("寄せ先は最後の反映で変わったノード全部。議題の外（B1）と中（A1）の両方が画面に入る", () => {
    const m = run(settle(withChanges(["A1", "B1"])), key("F"), key("F"));
    const target = targetsOf(m);
    const dims = dimsOf(m);
    expect(cameraViewOf(m)).toEqual({ mode: "diff", topic: "A" });
    for (const id of ["A1", "B1"]) {
      const r = nodeRect(id, target, dims);
      const left = r.x * m.camera.viewport.zoom + m.camera.viewport.x;
      const top = r.y * m.camera.viewport.zoom + m.camera.viewport.y;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + r.width * m.camera.viewport.zoom).toBeLessThanOrEqual(SIZE.width);
      expect(top + r.height * m.camera.viewport.zoom).toBeLessThanOrEqual(SIZE.height);
    }
  });

  it("人の下限 0.5 でも収まらないとき、倍率は 0.5 で、最後に変わったノード（lastChanged）が画面の中央に来る", () => {
    const m = run(settle(withChanges(["A1", "B3"]), "live", SMALL), key("F"), key("F"));
    const b3 = nodeRect("B3", targetsOf(m), dimsOf(m));
    expect(cameraViewOf(m)).toEqual({ mode: "diff", topic: "A" });
    expect(m.camera.viewport.zoom).toBeCloseTo(USER_MIN_ZOOM, 6);
    const at = screenPoint(m.camera.viewport, { x: b3.x + b3.width / 2, y: b3.y + b3.height / 2 });
    expect(at.x).toBeCloseTo(SMALL.width / 2, 6);
    expect(at.y).toBeCloseTo(SMALL.height / 2, 6);
  });

  it("変わったノードが畳みで隠れているとき、畳みを解かず、見えている祖先（済みの議題 A）に寄る", () => {
    const folded = foldable({ round: 2, changes: [change("A1", 2)], lastChanged: "A1" });
    const m = run(settle(folded), key("F"), key("F"));
    const view = viewOf(m)!;
    expect(view.nodes.map((n) => n.id)).not.toContain("A1");
    expect(cameraViewOf(m)).toEqual({ mode: "diff", topic: "B" });
    const a = nodeRect("A", targetsOf(m), dimsOf(m));
    expectViewport(m.camera.viewport, focusViewport([a], a, sizeOf(m), USER_MIN_ZOOM));
  });

  it("最後の反映で変わったノードが無いときの F・F は、自動に戻り、今の議題へ寄せ直す。止めていても同じ", () => {
    const quiet = settle(tree());
    for (const start of [quiet, update(quiet, scroll).model]) {
      const m = run(start, key("F"), key("F"));
      expect(cameraViewOf(m)).toEqual({ mode: "auto" });
      expectViewport(m.camera.viewport, focusExpected(m));
    }
  });

  it("何もしない反映の後（最後の反映で変わったノードが無い）も、F・F は自動に戻る。前の反映の変化は寄せ先にならない", () => {
    const afterQuiet = run(outside(), changed(withChanges(["B1"], 2, { round: 3, changes: [change("B1", 2)] })));
    const m = run(afterQuiet, key("F"), key("F"));
    expect(cameraViewOf(m)).toEqual({ mode: "auto" });
    expectViewport(m.camera.viewport, focusExpected(m));
  });

  it("自動から F・F で戻る前に、変化の無い反映が届いても、自動に戻り、今の議題へ寄せ直す（全体を見ている間の反映を含めた今の寄せ先）", () => {
    story(
      update,
      given(settle(tree())),
      message(key("F")),
      model((m) => expect(m.camera.mode).toBe("overview")),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      message(key("F")),
      model((m) => {
        expect(cameraViewOf(m)).toEqual({ mode: "auto" });
        expectViewport(m.camera.viewport, focusExpected(m));
      }),
    );
  });

  it("全体を見ている間は、反映のたびに、全体を目標の位置で収め直す（同じ今の議題の反映でも overview のまま）", () => {
    const start = run(settle(tree()), key("F"));
    story(
      update,
      given(start),
      message(changed(withSilentNode({ lastChanged: "A3" }))),
      model((m) => {
        expect(m.camera.mode).toBe("overview");
        expectViewport(m.camera.viewport, overviewExpected(m));
        expectDifferent(m.camera.viewport, start.camera.viewport);
      }),
    );
  });

  it("全体を見ている間は、実測（ノードの高さ・画面の大きさ）が届くたびに収め直す", () => {
    const start = run(settle(tree()), key("F"));
    story(
      update,
      given(start),
      message(measure(SIZE, { B: 400 })),
      model((m) => {
        expectViewport(m.camera.viewport, overviewExpected(m));
        expectDifferent(m.camera.viewport, start.camera.viewport);
      }),
      message(measure({ width: 900, height: 500 }, {})),
      model((m) => expectViewport(m.camera.viewport, overviewExpected(m))),
    );
  });

  it("全体を見ている間に、人が動かすと manual になる（動かすだけで viewport は変わらない）", () => {
    story(
      update,
      given(settle(tree())),
      message(scroll),
      message(key("F")),
      message(wheel({ deltaX: 10, deltaY: 10 })),
      model((m) => expect(cameraViewOf(m)).toEqual(manualAt("A"))),
    );
  });
});

describe("差分を見ている間のカメラ", () => {
  const inDiff = () => run(settle(withChanges(["B1"])), key("F"), key("F"));

  it("印だけの付与・解除では寄せ先を変えず、根拠・履歴・点滅は更新する", () => {
    const start = inDiff();
    let current = start;
    for (const [digression, round] of [[true, 3], [false, 4]] as const) {
      const snapshot = tree({
        round,
        nodes: baseNodes().map((n) => n.id === "B" ? { ...n, ...(digression ? { digression: true } : {}), evidence: ["r1", `r${round}`], evidenceRound: round } : n),
        changes: [{ change: "更新", node: "B", kind: "議題", text: "B", round, at: round }],
      });
      const next = changedSnapshot(current, snapshot);
      expect(next.camera.viewport).toEqual(start.camera.viewport);
      expect(next.viewing).toEqual(start.viewing);
      expect(cameraViewOf(next)).toEqual(cameraViewOf(start));
      expect(next.snapshot).toEqual(snapshot);
      expect(blinkRestartsOf(current, next)).toHaveLength(1);
      current = next;
      for (let repeat = 0; repeat < 2; repeat++) {
        const received = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(JSON.stringify(snapshot));
        expect(received).not.toBe(current.snapshot);
        expect(received).toEqual(snapshot);
        current = changedSnapshot(current, received);
        expect(current.snapshot).toEqual(snapshot);
        expect(current.camera.viewport).toEqual(start.camera.viewport);
        expect(current.viewing).toEqual(start.viewing);
        expect(cameraViewOf(current)).toEqual(cameraViewOf(start));
      }
    }
    const overview = run(current, key("F"));
    expectViewport(overview.camera.viewport, overviewExpected(overview));
    expect(overview.camera.mode).toBe("overview");
    const automatic = update(current, Message.PressedEscapeKey({ ...mods })).model;
    expectViewport(automatic.camera.viewport, focusExpected(automatic));
    expect(automatic.camera.mode).toBe("auto");
  });

  it("印の更新を再受信した後も、同じ round の本文変更を反映して寄せ直す", () => {
    const start = inDiff();
    const snapshot = tree({
      round: 3,
      nodes: baseNodes().map((n) => n.id === "B" ? { ...n, digression: true } : n),
      changes: [{ change: "更新", node: "B", kind: "議題", text: "B", round: 3, at: 3 }],
    });
    const marked = changedSnapshot(start, snapshot);
    const received = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(JSON.stringify(snapshot));
    const repeated = changedSnapshot(marked, received);
    const edited = { ...received, nodes: received.nodes.map((n) => n.id === "B" ? { ...n, text: "研修先の検討" } : n) };
    const next = changedSnapshot(repeated, edited);
    expect(next.snapshot).toEqual(edited);
    expectViewport(next.camera.viewport, changedExpected(next));
    expectDifferent(next.camera.viewport, start.camera.viewport);
  });

  it("F で全体を見る（overview）。目標の位置で全体を収めた viewport になる", () => {
    const m = run(inDiff(), key("F"));
    expect(cameraViewOf(m)).toEqual({ mode: "overview", topic: "A" });
    expectViewport(m.camera.viewport, overviewExpected(m));
  });

  it("Esc で自動に戻り、今の議題へ寄る", () => {
    const m = update(inDiff(), Message.PressedEscapeKey({ ...mods })).model;
    expect(cameraViewOf(m)).toEqual({ mode: "auto" });
    expectViewport(m.camera.viewport, focusExpected(m));
  });

  it("人が動かすと manual になる。スクロールで viewport は動かした分だけ動く", () => {
    const start = inDiff();
    const m = update(start, scroll).model;
    expect(cameraViewOf(m)).toEqual(manualAt("A"));
    expect(m.camera.viewport.zoom).toBe(start.camera.viewport.zoom);
    expect(m.camera.viewport.x).toBeCloseTo(start.camera.viewport.x - 20, 9);
    expect(m.camera.viewport.y).toBeCloseTo(start.camera.viewport.y - 50, 9);
  });

  it("今の議題が同じ反映で変化があれば、新しい反映で変わったノード全部へ寄り直す（diff のまま）", () => {
    const start = inDiff();
    const next = snap(baseNodes(), { round: 3, currentTopic: "A", changes: [change("B1", 2), change("A1", 3), change("B3", 3)], lastChanged: "B3" });
    const m = update(start, changed(next)).model;
    expect(cameraViewOf(m)).toEqual({ mode: "diff", topic: "A" });
    expectViewport(m.camera.viewport, changedExpected(m));
    expectDifferent(m.camera.viewport, start.camera.viewport);
    // 前の反映の変化（B1）ではなく、新しい反映の変化（A1・B3）で決まる
    expect(changedFocus(m.snapshot, (id) => id)!.ids.sort()).toEqual(["A1", "B3"]);
  });

  it("今の議題が同じで変化の無い反映は、動かさない（viewport も見る状態もそのまま）。何度届いても", () => {
    const start = inDiff();
    const quiet = snap(baseNodes(), { round: 3, currentTopic: "A", changes: [change("B1", 2)] });
    const once = update(start, changed(quiet)).model;
    expect(cameraViewOf(once)).toEqual({ mode: "diff", topic: "A" });
    expect(once.camera.viewport).toEqual(start.camera.viewport);
    const twice = update(once, changed({ ...quiet, round: 4 })).model;
    expect(cameraViewOf(twice)).toEqual({ mode: "diff", topic: "A" });
    expect(twice.camera.viewport).toEqual(start.camera.viewport);
  });

  it("今の議題が変わる反映は、自動に戻り、新しい今の議題へ寄る", () => {
    const next = snap(baseNodes(), { round: 3, currentTopic: "B", changes: [change("B2", 3)], lastChanged: "B2" });
    const m = update(inDiff(), changed(next)).model;
    expect(cameraViewOf(m)).toEqual({ mode: "auto" });
    expectViewport(m.camera.viewport, focusExpected(m));
  });

  it("実測（ノードの高さ・画面の大きさ）が届くたびに、変わったノードへ寄せ直す", () => {
    const start = inDiff();
    const m = update(start, measure(SMALL, { B1: 200 })).model;
    expect(cameraViewOf(m)).toEqual({ mode: "diff", topic: "A" });
    expectViewport(m.camera.viewport, changedExpected(m));
    expectDifferent(m.camera.viewport, start.camera.viewport);
  });
});

describe("開閉で位置を保つ: 開閉したノードを同じ画面座標に映し続ける", () => {
  // 開いた A の画面座標。補間中の表示位置で測る
  const anchorOf = (m: MapSurfaceModel) => screenPoint(m.camera.viewport, displayedPositions(m)["A"]!);
  const expectPointAt = (m: MapSurfaceModel, point: { x: number; y: number }) => {
    const at = anchorOf(m);
    expect(at.x).toBeCloseTo(point.x, 6);
    expect(at.y).toBeCloseTo(point.y, 6);
  };
  // 止めている状態で A の丸を押した直後（補間の経過 0）。押す前の A の画面座標も返す
  const opened = (start = run(settle(foldable()), scroll)) => {
    const point = anchorOf(start);
    return { start, point, afterClick: update(start, clickFoldDot("A")).model };
  };

  it("止めている間にまとめを開くと、先頭の議題が補間中も完了後もまとめの画面座標を保つ", () => {
    const snapshot = snap([
      node("root", null, "会議"),
      node("A", "root", "議題", { talkStatus: "済み" }),
      node("A1", "A", "論点"),
      node("A2", "root", "議題", { talkStatus: "済み" }),
      node("B", "root"),
    ], { currentTopic: "B", now: 100 });
    const start = run(settle(snapshot), measure(SIZE, { "run:A": 50 }), tick(500), scroll);
    const point = screenPoint(start.camera.viewport, displayedPositions(start)["run:A"]!);

    story(
      update,
      given(start),
      message(clickFoldDot("run:A")),
      model((m) => {
        expect(m.viewing.selection).toEqual({ id: "A", byKey: false });
        expect(displayedPositions(m)["run:A"]).toBeUndefined();
        expect(Option.isSome(m.motion)).toBe(true);
        expectPointAt(m, point);
      }),
      message(tick(250)),
      model((m) => expectPointAt(m, point)),
      message(tick(250)),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
        expectPointAt(m, point);
        expect(m.camera.viewport.zoom).toBe(start.camera.viewport.zoom);
        expect(m.camera.mode).toBe("manual");
      }),
    );
  });

  it("止めている間に丸を押すと、開いたノードは補間の途中も終わりも、押す前と同じ画面座標に映る（倍率は変えない）", () => {
    const { start, point, afterClick } = opened();
    expect(viewOf(afterClick)!.openness["A"]).toEqual({ state: "open", byHuman: true });
    // この入力は、補間で A が動くものでなければ検証にならない
    expectDifferent({ ...targetsOf(afterClick)["A"]!, zoom: 1 }, { ...displayedPositions(afterClick)["A"]!, zoom: 1 });
    story(
      update,
      given(start),
      message(clickFoldDot("A")),
      model((m) => expectPointAt(m, point)),
      message(tick(100)),
      model((m) => expectPointAt(m, point)),
      message(tick(150)),
      model((m) => expectPointAt(m, point)),
      message(tick(250)),
      model((m) => {
        expect(Option.isNone(m.motion)).toBe(true);
        expectPointAt(m, point);
        expect(m.camera.viewport.zoom).toBe(start.camera.viewport.zoom);
        expect(m.camera.mode).toBe("manual");
      }),
    );
    const mid = run(afterClick, tick(250));
    expectDifferent(mid.camera.viewport, afterClick.camera.viewport);
  });

  it("開いて新しく見えたノードの実寸が届いて配置が動いても、開いたノードを同じ画面座標に合わせ直す", () => {
    const { start, point } = opened();
    story(
      update,
      given(start),
      message(clickFoldDot("A")),
      message(tick(100)),
      message(measure(SIZE, { A1: 160, A2: 90 })),
      model((m) => expectPointAt(m, point)),
      message(tick(500)),
      model((m) => expectPointAt(m, point)),
    );
  });

  it("人が動かすと保持が外れ、以後の補間では viewport を動かさない", () => {
    const { afterClick } = opened();
    const moved = update(afterClick, wheel({ deltaX: 20, deltaY: 20 })).model;
    const after = update(moved, tick(100)).model;
    expectDifferent({ ...displayedPositions(after)["A"]!, zoom: 1 }, { ...displayedPositions(moved)["A"]!, zoom: 1 });
    expect(after.camera.viewport).toEqual(moved.camera.viewport);
  });

  it("次のキーの指示でも保持が外れる", () => {
    const { afterClick } = opened();
    const zoomed = update(afterClick, key("=")).model;
    const after = update(zoomed, tick(100)).model;
    expect(after.camera.viewport).toEqual(zoomed.camera.viewport);
  });

  it("全体を見ている間の開閉も位置を保つ。保っている間は全体を収め直さず、倍率も変えない", () => {
    const start = run(settle(foldable()), key("F"));
    const point = anchorOf(start);
    story(
      update,
      given(start),
      message(clickFoldDot("A")),
      model((m) => {
        expect(m.camera.mode).toBe("overview");
        expectPointAt(m, point);
      }),
      message(tick(100)),
      model((m) => expectPointAt(m, point)),
      message(measure(SIZE, { A1: 160 })),
      message(tick(500)),
      model((m) => {
        expectPointAt(m, point);
        expect(m.camera.viewport.zoom).toBe(start.camera.viewport.zoom);
      }),
    );
  });

  it("自動のときの開閉は位置を保たず、今の議題へ寄せ直す（開いた後の目標の位置で測る）", () => {
    const start = settle(foldable());
    expectViewport(start.camera.viewport, focusExpected(start));
    story(
      update,
      given(start),
      message(clickFoldDot("A")),
      model((m) => {
        expect(m.camera.mode).toBe("auto");
        expectViewport(m.camera.viewport, focusExpected(m));
        expectDifferent(m.camera.viewport, start.camera.viewport);
      }),
    );
  });
});

describe("列を出してずらす: E で保留を立て、画面の幅が変わったとき、今の議題が切れる分だけずらす", () => {
  const WIDE = { width: 600, height: 400 };
  const NARROW = { width: 500, height: 400 };
  // 今の議題 A（A・A1・A2）の箱が、幅 600 では右に収まらない位置。列を隠している状態（E で出す側）
  const hiddenColumn = (mode: "auto" | "manual" = "manual", sideHidden = true): MapSurfaceModel => {
    const initial = settle(tree());
    const base = mode === "manual" ? run(initial, scroll) : initial;
    return { ...withViewport(base, { x: 100, y: 0, zoom: 1 }), viewing: sideHidden ? { sideHidden: true } : {} };
  };
  const side = () => Message.PressedSideKey({ ...mods });
  const focusRects = (m: MapSurfaceModel): Rect[] => {
    const focus = cameraFocus(m.snapshot)!;
    return [...new Set(focus.ids)].map((id) => nodeRect(id, targetsOf(m), dimsOf(m)));
  };

  it("列を出す（E）だけでは動かさない。幅が変わった測定で、列で切れる分だけ横にずれる（倍率・縦は変えない）", () => {
    const start = hiddenColumn();
    const expected = shiftIntoView(start.camera.viewport, focusRects(start), NARROW);
    expectDifferent(expected, start.camera.viewport);
    story(
      update,
      given(start),
      message(side()),
      model((m) => {
        expect(m.viewing.sideHidden).toBeUndefined();
        expect(m.camera.viewport).toEqual(start.camera.viewport);
      }),
      message(measure(NARROW, {})),
      model((m) => {
        expectViewport(m.camera.viewport, expected);
        expect(m.camera.viewport.zoom).toBe(start.camera.viewport.zoom);
        expect(m.camera.viewport.y).toBe(start.camera.viewport.y);
      }),
    );
  });

  it("高さだけが変わった測定（同じ幅）では保留のまま。幅が変わった測定で、そのときの画面の大きさでずらす", () => {
    const start = hiddenColumn();
    const expected = shiftIntoView(start.camera.viewport, focusRects(start), { width: 500, height: 300 });
    expectDifferent(expected, start.camera.viewport);
    story(
      update,
      given(start),
      message(side()),
      message(measure({ width: WIDE.width, height: 300 }, {})),
      model((m) => expect(m.camera.viewport).toEqual(start.camera.viewport)),
      message(measure({ width: 500, height: 300 }, {})),
      model((m) => expectViewport(m.camera.viewport, expected)),
    );
  });

  it("ずらしは 1 回だけ。保留を使い切った後の幅の変化ではずらさない", () => {
    const start = hiddenColumn();
    story(
      update,
      given(start),
      message(side()),
      message(measure(NARROW, {})),
      model((m) => {
        const after = update(m, measure({ width: 480, height: 400 }, {})).model;
        expect(after.camera.viewport).toEqual(m.camera.viewport);
      }),
    );
  });

  it("列を隠したとき（sideHidden になる E）は、幅が変わってもずらさない。保留も残さない", () => {
    const start = hiddenColumn("manual", false);
    story(
      update,
      given(start),
      message(side()),
      model((m) => expect(m.viewing.sideHidden).toBe(true)),
      message(measure({ width: 700, height: 400 }, {})),
      model((m) => expect(m.camera.viewport).toEqual(start.camera.viewport)),
      message(measure(NARROW, {})),
      model((m) => expect(m.camera.viewport).toEqual(start.camera.viewport)),
    );
  });

  const atWidth = (m: MapSurfaceModel, size: { width: number; height: number }): MapSurfaceModel => ({ ...m, size: Option.some(size) });

  it("自動で列を出す（E）後の幅の測定は、寄せ直さず、E の前の viewport を列で切れる分だけずらす（倍率・縦は E の前のまま）", () => {
    const start = hiddenColumn("auto");
    expect(Option.isSome(start.camera.placedRound)).toBe(true);
    const expected = shiftIntoView(start.camera.viewport, focusRects(start), NARROW);
    expectDifferent(expected, start.camera.viewport);
    // 前提: 寄せ直すと別の viewport になる
    expectDifferent(focusExpected(atWidth(start, NARROW)), start.camera.viewport);
    story(
      update,
      given(start),
      message(side()),
      message(measure(NARROW, {})),
      model((m) => {
        expect(m.camera.mode).toBe("auto");
        expectViewport(m.camera.viewport, expected);
        expect(m.camera.viewport.zoom).toBe(start.camera.viewport.zoom);
        expect(m.camera.viewport.y).toBe(start.camera.viewport.y);
      }),
    );
  });

  it("全体を見ている間に列を出す（E）後の幅の測定も、収め直さず、E の前の viewport をずらすだけ（overview のまま）", () => {
    const base = run(settle(tree()), key("F"));
    const start: MapSurfaceModel = { ...withViewport(base, { x: 100, y: 0, zoom: 1 }), viewing: { ...base.viewing, sideHidden: true } };
    const expected = shiftIntoView(start.camera.viewport, focusRects(start), NARROW);
    expectDifferent(expected, start.camera.viewport);
    // 前提: 収め直すと別の viewport になる
    expectDifferent(overviewExpected(atWidth(start, NARROW)), start.camera.viewport);
    story(
      update,
      given(start),
      message(side()),
      message(measure(NARROW, {})),
      model((m) => {
        expect(m.camera.mode).toBe("overview");
        expectViewport(m.camera.viewport, expected);
        expect(m.camera.viewport.zoom).toBe(start.camera.viewport.zoom);
        expect(m.camera.viewport.y).toBe(start.camera.viewport.y);
      }),
    );
  });

  it("自動でも全体を見ていても、列を隠す（E）後の幅の測定は viewport を変えず、保留も残さない", () => {
    const base = run(settle(tree()), key("F"));
    const starts: MapSurfaceModel[] = [hiddenColumn("auto", false), withViewport(base, { x: 100, y: 0, zoom: 1 })];
    const wide = { width: 700, height: 400 };
    expectDifferent(focusExpected(atWidth(starts[0]!, wide)), starts[0]!.camera.viewport);
    expectDifferent(overviewExpected(atWidth(starts[1]!, wide)), starts[1]!.camera.viewport);
    for (const start of starts) {
      story(
        update,
        given(start),
        message(side()),
        message(measure(wide, {})),
        model((m) => {
          expect(m.viewing.sideHidden).toBe(true);
          expect(m.camera.viewport).toEqual(start.camera.viewport);
          expect(m.camera.pendingShift).toBe(false);
        }),
      );
    }
  });

  it("E は寄せ直しも収め直しもしない（自動でも全体を見ていても viewport はそのまま）", () => {
    const auto = withViewport(settle(tree()), { x: 5, y: 7, zoom: 1 });
    expect(update(auto, side()).model.camera.viewport).toEqual({ x: 5, y: 7, zoom: 1 });
    const overview = { ...run(settle(tree()), key("F")) };
    const kept = update(withViewport(overview, { x: 5, y: 7, zoom: 1 }), side()).model;
    expect(kept.camera.viewport).toEqual({ x: 5, y: 7, zoom: 1 });
    expect(kept.camera.mode).toBe("overview");
  });

  it("E の後に別の指示（キーでのズーム）があると保留は消え、幅が変わってもずらさない", () => {
    const start = hiddenColumn();
    story(
      update,
      given(start),
      message(side()),
      message(key("=")),
      model((m) => {
        const after = update(m, measure(NARROW, {})).model;
        expect(after.camera.viewport).toEqual(m.camera.viewport);
      }),
    );
  });

  it("今の議題が無いときは、幅が変わってもずらさない", () => {
    const start = { ...hiddenColumn(), snapshot: snap(baseNodes()) };
    story(
      update,
      given(start),
      message(side()),
      message(measure(NARROW, {})),
      model((m) => expect(m.camera.viewport).toEqual(start.camera.viewport)),
    );
  });
});

describe("キーの指示: その場で適用する（seq を介さない）", () => {
  const start = settle(tree());
  const size = SIZE;

  it("Z: 選んだノードとその子孫が収まる位置へ寄る（fitSubtree）。選んでいなければ何も起きない", () => {
    const shown = shownOf(start);
    const expected = subtreeViewport("A", { ids: shown.map((n) => n.id), parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])) }, targetsOf(start), dimsOf(start), size);
    const selected = update(start, clickNode("A")).model;
    const m = update(selected, key("Z")).model;
    expect(m.camera.mode).toBe("manual");
    expectViewport(m.camera.viewport, expected);
    expectDifferent(m.camera.viewport, selected.camera.viewport);
    const none = update(start, key("Z")).model;
    expect(none.camera.viewport).toEqual(start.camera.viewport);
    expect(cameraViewOf(none)).toEqual({ mode: "auto" });
  });

  it("矢印: 選択を移し、移り先が画面の外なら最小限ずらして入れる（revealNode）", () => {
    const offscreen = withViewport(update(start, clickNode("A")).model, { x: 200, y: 0, zoom: 1 });
    const m = update(offscreen, Message.PressedArrowKey({ dir: "right", ...mods })).model;
    expect(m.viewing.selection).toEqual({ id: "A1", byKey: true });
    expect(m.camera.mode).toBe("manual");
    const expected = revealViewport(zoomAroundCenter(offscreen.camera.viewport, clampUserZoom(offscreen.camera.viewport.zoom), size), nodeRect("A1", targetsOf(start), dimsOf(start)), size);
    expectViewport(m.camera.viewport, expected);
    expectDifferent(m.camera.viewport, offscreen.camera.viewport);
  });

  it("全体を見ていて 0.5 未満の倍率から、キーのパン・矢印に移るときは、人の倍率の範囲（0.5）に収めてから動かす", () => {
    const overview = run(settle(tree(), "live", SMALL), key("F"));
    expect(overview.camera.viewport.zoom).toBeLessThan(0.5);
    const panned = update(overview, key("Shift+ArrowRight")).model;
    expectViewport(panned.camera.viewport, panViewport(zoomAroundCenter(overview.camera.viewport, 0.5, SMALL), { dx: 1, dy: 0 }, SMALL));
    const selected = update(overview, clickNode("A")).model;
    const revealed = update(selected, Message.PressedArrowKey({ dir: "right", ...mods })).model;
    expect(revealed.camera.viewport.zoom).toBeCloseTo(0.5, 9);
  });

  it("Esc: 止めた状態から自動に戻り、今の議題へ寄せ直す（refocus）", () => {
    const moved = update(start, scroll).model;
    const m = update(moved, Message.PressedEscapeKey({ ...mods })).model;
    expect(cameraViewOf(m)).toEqual({ mode: "auto" });
    expectViewport(m.camera.viewport, focusExpected(m));
    expectDifferent(m.camera.viewport, moved.camera.viewport);
  });

  it("修飾キー付き（⌘＋=）は何もしない", () => {
    const m = update(start, key("=", { metaKey: true })).model;
    expect(m.camera.viewport).toEqual(start.camera.viewport);
    expect(cameraViewOf(m)).toEqual({ mode: "auto" });
  });

  it("still ではキーで動かさない", () => {
    const still = settle(tree(), "still");
    for (const input of [key("="), key("F"), key("Shift+ArrowRight"), Message.PressedEscapeKey({ ...mods })]) {
      const m = update(still, input).model;
      expect(m.camera.viewport).toEqual(still.camera.viewport);
      expect(cameraViewOf(m)).toEqual({ mode: "auto" });
    }
  });

  it("画面の大きさを測る前は、キーの指示で viewport を動かさない。E の保留は立ち、次の指示で消える", () => {
    const unmeasured = init(tree(), "live", false);
    for (const input of [key("="), key("0"), key("Shift+ArrowRight"), Message.PressedEscapeKey({ ...mods })]) {
      const m = update(unmeasured, input).model;
      expect(m.camera.viewport).toEqual(unmeasured.camera.viewport);
      expect(m.camera.pendingShift).toBe(false);
      expect(Option.isNone(m.camera.keepAnchor)).toBe(true);
    }
    const shifted = update(unmeasured, Message.PressedSideKey({ ...mods })).model;
    expect(shifted.camera.viewport).toEqual(unmeasured.camera.viewport);
    expect(shifted.camera.pendingShift).toBe(true);
    expect(update(shifted, key("=")).model.camera.pendingShift).toBe(false);
  });

  it("live と見返し（review）のどちらでも同じように動く", () => {
    const review = settle(tree(), "review");
    expectViewport(update(review, key("=")).model.camera.viewport, zoomAroundCenter(review.camera.viewport, clampUserZoom(review.camera.viewport.zoom * 1.25), size));
    expect(cameraViewOf(update(review, key("=")).model)).toEqual(manualAt("A"));
  });
});

describe("縁の点を押したら寄る", () => {
  it("今の倍率のまま、目標の位置と高さで測ったノードの中心が画面の中央に来る（キーでズームした後の倍率を使う）", () => {
    const zoomed = run(settle(tree()), key("="));
    expect(zoomed.camera.viewport.zoom).not.toBe(1);
    story(
      update,
      given(zoomed),
      message(Message.ClickedEdgeDot({ nodeId: "B3" })),
      model((m) => {
        expectViewport(m.camera.viewport, nodeFocusViewport(nodeRect("B3", targetsOf(m), dimsOf(m)), zoomed.camera.viewport.zoom, SIZE));
        expect(cameraViewOf(m)).toEqual(manualAt("A"));
      }),
    );
  });

  it("消えたノードの点では動かさない", () => {
    const zoomed = run(settle(tree()), key("="));
    const m = update(zoomed, Message.ClickedEdgeDot({ nodeId: "gone" })).model;
    expect(m.camera.viewport).toEqual(zoomed.camera.viewport);
  });
});

describe("見返しで触らずに 10 秒たつと自動に戻る", () => {
  const idle = () => Message.ElapsedIdleTime();

  it("見返しの manual で時間が経つと、自動に戻り、今の議題へ寄せ直す", () => {
    const moved = run(settle(tree(), "review"), scroll);
    expect(cameraViewOf(moved)).toEqual(manualAt("A"));
    story(
      update,
      given(moved),
      message(idle()),
      model((m) => {
        expect(cameraViewOf(m)).toEqual({ mode: "auto" });
        expectViewport(m.camera.viewport, focusExpected(m));
        expectDifferent(m.camera.viewport, moved.camera.viewport);
      }),
    );
  });

  it("ライブでは、時間が経っても止めたまま", () => {
    const moved = run(settle(tree(), "live"), scroll);
    const m = update(moved, idle()).model;
    expect(cameraViewOf(m)).toEqual(manualAt("A"));
    expect(m.camera.viewport).toEqual(moved.camera.viewport);
  });

  it("見返しでも、自動のとき・全体を見ているときは変わらない", () => {
    const auto = settle(tree(), "review");
    expect(cameraViewOf(update(auto, idle()).model)).toEqual({ mode: "auto" });
    expect(update(auto, idle()).model.camera.viewport).toEqual(auto.camera.viewport);
    const overview = run(auto, key("F"));
    expect(update(overview, idle()).model.camera.mode).toBe("overview");
    expect(update(overview, idle()).model.camera.viewport).toEqual(overview.camera.viewport);
  });

  it("still は時間では何も起こさない", () => {
    const still = settle(tree(), "still");
    expect(update(still, idle()).model.camera.viewport).toEqual(still.camera.viewport);
  });

  it("見る状態を動かす出来事（スクロール・キー・丸）のたびに idleStamp が変わり（10 秒を計り直す）、E・選択では変わらない", () => {
    const start = settle(foldable(), "review");
    const stamp = (m: MapSurfaceModel) => m.idleStamp;
    const scrolled = update(start, scroll).model;
    expect(stamp(scrolled)).not.toBe(stamp(start));
    const scrolledAgain = update(scrolled, scroll).model;
    expect(stamp(scrolledAgain)).not.toBe(stamp(scrolled));
    const keyed = update(scrolledAgain, key("=")).model;
    expect(stamp(keyed)).not.toBe(stamp(scrolledAgain));
    const folded = update(keyed, clickFoldDot("A")).model;
    expect(stamp(folded)).not.toBe(stamp(keyed));
    expect(stamp(update(folded, Message.PressedSideKey({ ...mods })).model)).toBe(stamp(folded));
    expect(stamp(update(folded, clickNode("B")).model)).toBe(stamp(folded));
  });

  it("見返しの manual で不存在 ID の変更項目を選んでも待機を計り直さず、有効な対象なら寄せて計り直す", () => {
    const before = run(settle(tree(), "review"), scroll);
    expect(before.camera.mode).toBe("manual");
    const selected = update(before, clickNode("B")).model;
    expect(selected.idleStamp).toBe(before.idleStamp);
    for (const nodeId of ["gone", "B"]) {
      const after = update(before, Message.ClickedChangeItem({ nodeId })).model;
      expect(after.viewing.selection).toEqual({ id: nodeId, byKey: false });
      expect(after.camera.mode).toBe("manual");
      if (nodeId === "gone") {
        expect(after.camera.viewport).toEqual(before.camera.viewport);
        expect(after.idleStamp).toBe(selected.idleStamp);
      } else {
        expectViewport(after.camera.viewport, nodeFocusViewport(nodeRect("B", targetsOf(after), dimsOf(after)), before.camera.viewport.zoom, SIZE));
        expectDifferent(after.camera.viewport, before.camera.viewport);
        expect(after.idleStamp).toBe(before.idleStamp + 1);
      }
    }
  });
});

describe("update は時刻を読まない", () => {
  afterEach(() => vi.restoreAllMocks());

  it("反映・パン・キー・時間の Message を流しても、Date.now・performance.now を呼ばない", () => {
    const dateNow = vi.spyOn(Date, "now");
    const perfNow = vi.spyOn(performance, "now");
    run(settle(tree(), "review"), scroll, key("F"), key("F"), changed(tree({ round: 2, currentTopic: "B", lastChanged: "B1" })), Message.ElapsedIdleTime(), tick(100), Message.PressedSideKey({ ...mods }));
    expect(dateNow).not.toHaveBeenCalled();
    expect(perfNow).not.toHaveBeenCalled();
  });
});
