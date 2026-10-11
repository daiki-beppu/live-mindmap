import { HashMap, Option } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { attr, click, expect as expectScene, find, findAll, given, Mount, scene, selector, Subscription, tap, textContent } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import type { ChangeEntry, Remark, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { init, update, view as mapView } from "../src/app/mapSurface/main.ts";
import { Message } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { view as sideView } from "../src/app/sidePanel/main.ts";
import { INITIAL_VIEWING, type ViewingState } from "../src/viewing.ts";

// 右の列（Issue #821）の Scene。描いた view から入り、選んだノードの根拠のパネルと変わったことの列が、今の画面（EvidencePanel.tsx・ChangeList.tsx）と同じ中身・同じ DOM で出ること、
// 選択に連動して同じ画面の上で切り替わること、右の列の出す・隠すが Disclosure の panel として描かれることを見る。
// 選ぶのはマップのノードの click（描いたノードのボタンの Mount を解いて届ける Message）、列の出し入れの引き金（E キー・#825 のボタン）は描いた木の外なので Subscription.emit で流す

type MapSurfaceModel = ReturnType<typeof init>;
type VNode = Parameters<typeof textContent>[0];

// マップの表示面と右の列を、同じ Model から並べて描く（親が h.submodel で並べるのと同じ組み合わせ）
const app = { update, view: (model: MapSurfaceModel, h: HtmlBuilder<Message>) => h.div([], [mapView(model, h), sideView(model, h)]) };

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"], extra: Partial<SnapshotNode> = {}): SnapshotNode => ({ id, parent, kind, text: id, evidence: [], ...extra });
const REMARKS: Remark[] = [
  { id: "r1", track: "自分", start: 65, end: 71.9, text: "<i>二回で</i>いきます" },
  { id: "r2", track: "相手", start: 125, end: 130, text: "了解です" },
];
const NODES: SnapshotNode[] = [
  node("root", null, "会議"),
  node("A", "root", "議題", { talkStatus: "済み", text: "採用", evidence: ["r1"] }),
  // 根拠は積んだ順（r2, r1）で、発言の開始時刻の昇順（r1, r2）に並べ直されて出る
  node("A1", "A", "論点", { text: "面接は何回か", pointStatus: "決定済み", evidence: ["r2", "r1"] }),
  node("A2", "A1", "案", { text: "<b>2 回</b>", planStatus: "却下", evidence: ["r1"] }),
  node("A3", "A1", "課題", { text: "人が足りない", evidence: ["r1"] }),
  node("A4", "A1", "TODO", { text: "発言の無い TODO", evidence: [] }),
  node("B", "root", "議題", { text: "報告" }),
];
const CHANGES: ChangeEntry[] = [
  { round: 1, at: 19.2, change: "追加", node: "A", kind: "議題", text: "採用" },
  { round: 2, at: 65, change: "決定済み化", node: "A1", kind: "論点", text: "面接は何回か" },
  { round: 3, at: 125, change: "追加", node: "gone", kind: "決定", text: "消えたノード" },
];
const snap = (changes: ChangeEntry[] = CHANGES): Snapshot => ({ nodes: NODES, round: 3, changes, remarks: REMARKS, currentTopic: "B", now: 200 });
const HEIGHTS = { root: 40, A: 50, A1: 60, A2: 40, A3: 40, A4: 40, B: 70 };
const SIZE = { width: 800, height: 600 };

const modelOf = (snapshot: Snapshot = snap(), viewing: ViewingState = INITIAL_VIEWING): MapSurfaceModel => ({
  ...init(snapshot, "live", false),
  size: Option.some(SIZE),
  nodeHeights: HashMap.make(...Object.entries(HEIGHTS)),
  viewing,
});
// Mount は 1 度しか解けない。ノードの click を含まない Scene は、大きさだけの測定（目標の位置は変わらない）で解く
const mounted = Mount.resolve(ObserveMapSurface, Message.MeasuredMapSurface({ ...SIZE, nodeHeights: {} }));
// ノードを選ぶ（描いたノードのボタンの Mount が届ける Message。ノードの click を含む Scene はこれで Mount を解く）
const clickedNode = (nodeId: string) => Mount.resolve(ObserveMapSurface, Message.ClickedNodeButton({ nodeId, clientX: 0, clientY: 0 }));
const nodeButton = (nodeId: string) => expectScene(selector(`[data-node-id="${nodeId}"] button.map-node__button`)).toExist();
// 議題 A を開いた見る状態（論点・案・課題・TODO がマップに描かれる）
const OPENED: ViewingState = { mode: "auto", humanOpened: new Set(["A"]) };
const toggleSide = (isOpen: boolean) => Subscription.emit(Message.ToggledSide({ isOpen }));

const EVIDENCE = selector("section.evidence");
const CHANGE_LIST = selector("aside.changes");
const CHANGE_BUTTON = selector("button.changes__button");
const textOf = (vnode: VNode, css: string): string[] => findAll(css)(vnode).map(textContent);
const evidenceOf = (html: VNode): VNode => Option.getOrThrow(find("section.evidence")(html));
const sideOf = (html: VNode): VNode => Option.getOrThrow(find(".side")(html));
const elements = (vnode: VNode): VNode[] => (vnode.children ?? []).filter((c): c is VNode => typeof c !== "string" && c.sel !== undefined);
const classOf = (vnode: VNode): string => Option.getOrElse(attr(vnode, "class"), () => "");
const named = (vnode: VNode): string => `${vnode.sel}.${classOf(vnode).split(" ").join(".")}`;
const EMPTY_NOT_SELECTED = "ノードを選ぶと、根拠の発言が出ます";
const EMPTY_NOT_ON_MAP = "選んだノードは今のマップにありません";
const EMPTY_NO_REMARKS = "根拠の発言はありません";

describe("sidePanel の Scene: 根拠のパネル（選択と連動して今と同じ中身が出る）", () => {
  it("何も選んでいない間は、見出し「根拠」と案内だけで、発言は出さない", () => {
    scene(
      app,
      given(modelOf()),
      mounted,
      expectScene(selector("section.evidence h2")).toHaveText("根拠"),
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NOT_SELECTED),
      expectScene(selector(".evidence__remark")).toBeAbsent(),
      expectScene(selector(".evidence__meta")).toBeAbsent(),
      tap((s) => {
        expect(attr(evidenceOf(s.html), "aria-labelledby")).toEqual(Option.some("evidence-heading"));
        expect(attr(Option.getOrThrow(find("section.evidence h2")(s.html)), "id")).toEqual(Option.some("evidence-heading"));
      }),
    );
  });

  it("論点を選ぶと、種別・状態・本文と、発言を開始時刻の昇順に 時刻・トラック・文 で出す（積んだ順の r2, r1 は r1, r2 になる）", () => {
    scene(
      app,
      given(modelOf(snap(), OPENED)),
      nodeButton("A1"),
      clickedNode("A1"),
      expectScene(selector("section.evidence .evidence__kind")).toHaveText("論点"),
      expectScene(selector("section.evidence .evidence__status")).toHaveText("決定済み"),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("面接は何回か"),
      expectScene(selector("section.evidence p.evidence__empty")).toBeAbsent(),
      tap((s) => {
        const evidence = evidenceOf(s.html);
        expect(textOf(evidence, ".evidence__time")).toEqual(["01:05〜01:11", "02:05〜02:10"]);
        expect(textOf(evidence, ".evidence__track")).toEqual(["自分", "相手"]);
        expect(textOf(evidence, ".evidence__remark-text")).toEqual(["<i>二回で</i>いきます", "了解です"]);
        const remarks = findAll("li.evidence__remark")(evidence);
        expect(remarks.map((r) => elements(r).map(named))).toEqual([
          ["span.evidence__time", "span.evidence__track", "span.evidence__remark-text"],
          ["span.evidence__time", "span.evidence__track", "span.evidence__remark-text"],
        ]);
        expect(findAll("ul")(evidence)).toHaveLength(1);
        // 発言の key は発言の id（表示中の文字から作らない）
        expect(remarks.map((r) => r.key)).toEqual(["r1", "r2"]);
      }),
    );
  });

  it("案の状態は planStatus、本文は HTML としてではなく文字で描く", () => {
    scene(
      app,
      given(modelOf(snap(), OPENED)),
      nodeButton("A2"),
      clickedNode("A2"),
      expectScene(selector("section.evidence .evidence__kind")).toHaveText("案"),
      expectScene(selector("section.evidence .evidence__status")).toHaveText("却下"),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("<b>2 回</b>"),
      tap((s) => expect(findAll("b")(evidenceOf(s.html))).toHaveLength(0)),
    );
  });

  it("状態を持たない種別（課題）に切り替えると、状態の要素を出さない", () => {
    scene(
      app,
      given(modelOf(snap(), { ...OPENED, selection: { id: "A2", byKey: false } })),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("<b>2 回</b>"),
      nodeButton("A3"),
      clickedNode("A3"),
      expectScene(selector("section.evidence .evidence__kind")).toHaveText("課題"),
      expectScene(selector("section.evidence .evidence__status")).toBeAbsent(),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("人が足りない"),
    );
  });

  it("選択に連動する: 未選択から A1 を選ぶと、案内が根拠の中身に切り替わる", () => {
    scene(
      app,
      given(modelOf(snap(), OPENED)),
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NOT_SELECTED),
      nodeButton("A1"),
      clickedNode("A1"),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("面接は何回か"),
      expectScene(selector("section.evidence p.evidence__empty")).toBeAbsent(),
      tap((s) => expect(findAll("li.evidence__remark")(evidenceOf(s.html))).toHaveLength(2)),
    );
  });

  it("選択に連動する: A1 から A2 へ選び直すと、同じ画面の上で中身が切り替わり、前の発言は残らない", () => {
    scene(
      app,
      given(modelOf(snap(), { ...OPENED, selection: { id: "A1", byKey: false } })),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("面接は何回か"),
      tap((s) => expect(findAll("li.evidence__remark")(evidenceOf(s.html))).toHaveLength(2)),
      nodeButton("A2"),
      clickedNode("A2"),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("<b>2 回</b>"),
      expectScene(selector("section.evidence .evidence__status")).toHaveText("却下"),
      tap((s) => expect(findAll("li.evidence__remark")(evidenceOf(s.html))).toHaveLength(1)),
    );
  });

  it("選択に連動する: A2 から A4（発言なし）へ選び直すと、前の発言は残らない", () => {
    scene(
      app,
      given(modelOf(snap(), { ...OPENED, selection: { id: "A2", byKey: false } })),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("<b>2 回</b>"),
      tap((s) => expect(findAll("li.evidence__remark")(evidenceOf(s.html))).toHaveLength(1)),
      nodeButton("A4"),
      clickedNode("A4"),
      expectScene(selector("section.evidence .evidence__kind")).toHaveText("TODO"),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("発言の無い TODO"),
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NO_REMARKS),
      expectScene(selector(".evidence__remark")).toBeAbsent(),
      tap((s) => expect(findAll("ul")(evidenceOf(s.html))).toHaveLength(0)),
    );
  });

  it("選んだ状態で始まる Model（viewing.selection）でも、その選択の根拠が出る", () => {
    scene(
      app,
      given(modelOf(snap(), { mode: "auto", selection: { id: "A1", byKey: false } })),
      mounted,
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("面接は何回か"),
      tap((s) => expect(textOf(evidenceOf(s.html), ".evidence__time")).toEqual(["01:05〜01:11", "02:05〜02:10"])),
    );
  });

  it("選んだノードが今のマップに無いときは「選んだノードは今のマップにありません」（Snapshot が新しくなって消えた場合も、同じ画面の上で切り替わる）", () => {
    const without = snap().nodes.filter((n) => n.id !== "A2");
    scene(
      app,
      given(modelOf(snap(), { mode: "auto", selection: { id: "A2", byKey: false } })),
      mounted,
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("<b>2 回</b>"),
      Subscription.emit(Message.ChangedSnapshot({ snapshot: { ...snap(), nodes: without } })),
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NOT_ON_MAP),
      expectScene(selector("section.evidence p.evidence__text")).toBeAbsent(),
      expectScene(selector("section.evidence h2")).toHaveText("根拠"),
    );
  });

  it("Snapshot が新しくなって、選んだノードの根拠の発言が増えると、同じ画面の上で出る発言も変わる", () => {
    const grown: Snapshot = { ...snap(), remarks: [...REMARKS, { id: "r3", track: "相手", start: 200, end: 205, text: "追加の発言" }], nodes: NODES.map((n) => (n.id === "A4" ? { ...n, evidence: ["r3"] } : n)) };
    scene(
      app,
      given(modelOf(snap(), OPENED)),
      nodeButton("A4"),
      clickedNode("A4"),
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NO_REMARKS),
      Subscription.emit(Message.ChangedSnapshot({ snapshot: grown })),
      expectScene(selector("section.evidence p.evidence__empty")).toBeAbsent(),
      tap((s) => {
        expect(textOf(evidenceOf(s.html), ".evidence__remark-text")).toEqual(["追加の発言"]);
        expect(textOf(evidenceOf(s.html), ".evidence__time")).toEqual(["03:20〜03:25"]);
      }),
    );
  });

  it("まとめのノード（議題 N 件）を指すと、種別・本文は出て、発言は「根拠の発言はありません」", () => {
    // 済みの議題 A・A2' が続くと「議題 2 件」（run:A）にまとめられる。まとめのノードは click では選べないので、選択を持つ Model で始める
    const bundledNodes: SnapshotNode[] = [
      node("root", null, "会議"),
      node("A", "root", "議題", { talkStatus: "済み", evidence: ["r1"] }),
      node("A1", "A", "論点", { pointStatus: "未決", evidence: ["r1"] }),
      node("A5", "root", "議題", { talkStatus: "済み", evidence: ["r1"] }),
      node("B", "root", "議題"),
    ];
    const bundled: Snapshot = { nodes: bundledNodes, round: 3, changes: [], remarks: REMARKS, currentTopic: "B", now: 100 };
    scene(
      app,
      given(modelOf(bundled, { mode: "auto", selection: { id: "run:A", byKey: false } })),
      mounted,
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NO_REMARKS),
      expectScene(selector("section.evidence .evidence__kind")).toHaveText("議題"),
      expectScene(selector("section.evidence .evidence__status")).toBeAbsent(),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("議題 2 件"),
    );
  });
});

describe("sidePanel の Scene: 変わったことの列（今の ChangeList と同じ DOM）", () => {
  it("見出し「変わったこと」と、各記録の 時刻（mm:ss）・変化の種類・種別・本文 を新しい順（積んだ順の逆）に出す", () => {
    scene(
      app,
      given(modelOf()),
      mounted,
      expectScene(selector("aside.changes h2")).toHaveText("変わったこと"),
      tap((s) => {
        const list = Option.getOrThrow(find("aside.changes")(s.html));
        expect(attr(list, "aria-labelledby")).toEqual(Option.some("changes-heading"));
        expect(attr(Option.getOrThrow(find("aside.changes h2")(s.html)), "id")).toEqual(Option.some("changes-heading"));
        expect(textOf(list, ".changes__time")).toEqual(["02:05", "01:05", "00:19"]);
        expect(textOf(list, ".changes__type")).toEqual(["追加", "決定済み化", "追加"]);
        expect(textOf(list, ".changes__kind")).toEqual(["決定", "論点", "議題"]);
        expect(textOf(list, ".changes__text")).toEqual(["消えたノード", "面接は何回か", "採用"]);
        const items = findAll("li.changes__item")(list);
        expect(items).toHaveLength(3);
        expect(items.map((i) => elements(i).map(named))).toEqual(Array(3).fill(["button.changes__button"]));
        expect(findAll("button.changes__button")(list).map((b) => elements(b).map(named))).toEqual(
          Array(3).fill(["time.changes__time", "span.changes__type", "span.changes__kind", "span.changes__text"]),
        );
        expect(findAll("button.changes__button")(list).map((b) => attr(b, "type"))).toEqual(Array(3).fill(Option.some("button")));
        // key は 反映の回・ノード・変化の種類（表示中の文字から作らない）。新しい順
        expect(items.map((i) => i.key)).toEqual(["3-gone-追加", "2-A1-決定済み化", "1-A-追加"]);
      }),
    );
  });

  it("本文は HTML としてではなく文字で描き、描くために Snapshot の記録の並びを書き換えない", () => {
    const changes: ChangeEntry[] = [
      { round: 1, at: 1, change: "追加", node: "A", kind: "議題", text: "<b>強調</b>" },
      { round: 2, at: 2, change: "追加", node: "B", kind: "議題", text: "二つ目" },
    ];
    const snapshot = snap(changes);
    scene(
      app,
      given(modelOf(snapshot)),
      mounted,
      expectScene(selector("aside.changes .changes__text")).toExist(),
      tap((s) => {
        const list = Option.getOrThrow(find("aside.changes")(s.html));
        expect(textOf(list, ".changes__text")).toEqual(["二つ目", "<b>強調</b>"]);
        expect(findAll("b")(list)).toHaveLength(0);
      }),
      tap(() => expect(snapshot.changes.map((c) => c.node)).toEqual(["A", "B"])),
    );
  });

  it("記録が無いときは、見出しだけで項目は無い", () => {
    scene(
      app,
      given(modelOf(snap([]))),
      mounted,
      expectScene(selector("aside.changes h2")).toHaveText("変わったこと"),
      expectScene(selector("li.changes__item")).toBeAbsent(),
    );
  });

  it("Snapshot が新しくなって記録が増えると、同じ画面の上で新しい順の先頭に積まれる", () => {
    scene(
      app,
      given(modelOf(snap([CHANGES[0]!]))),
      mounted,
      tap((s) => expect(textOf(s.html, ".changes__text")).toEqual(["採用"])),
      Subscription.emit(Message.ChangedSnapshot({ snapshot: snap(CHANGES) })),
      tap((s) => expect(textOf(Option.getOrThrow(find("aside.changes")(s.html)), ".changes__text")).toEqual(["消えたノード", "面接は何回か", "採用"])),
    );
  });
});

describe("sidePanel の Scene: 変わったことの項目を押すと、そのノードへ移る（選んだ見た目と根拠が同じ画面の上で切り替わる）", () => {
  const one = (node_: string, kind: ChangeEntry["kind"], text: string): ChangeEntry[] => [{ round: 3, at: 70, change: "追加", node: node_, kind, text }];

  it("項目を押すと、そのノードがマップで選ばれた見た目になり、根拠のパネルがそのノードの中身に切り替わる", () => {
    scene(
      app,
      given(modelOf(snap(one("A1", "論点", "面接は何回か")))),
      mounted,
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NOT_SELECTED),
      expectScene(selector(`[data-node-id="A1"] .map-node`)).toBeAbsent(),
      click(CHANGE_BUTTON),
      expectScene(selector(`[data-node-id="A1"] .map-node`)).toHaveClass("map-node--selected"),
      expectScene(selector(`[data-node-id="A1"] button.map-node__button`)).toHaveAttr("aria-pressed", "true"),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("面接は何回か"),
      expectScene(selector("section.evidence .evidence__status")).toHaveText("決定済み"),
    );
  });

  it("別のノードを選んでいても、項目を押すとそのノードへ移る（前に選んだノードは選ばれた見た目でなくなる）", () => {
    scene(
      app,
      given(modelOf(snap(one("B", "議題", "報告")), { mode: "auto", selection: { id: "A1", byKey: false } })),
      mounted,
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("面接は何回か"),
      click(CHANGE_BUTTON),
      expectScene(selector(`[data-node-id="B"] .map-node`)).toHaveClass("map-node--selected"),
      expectScene(selector(`.map-node--selected`)).toHaveText("報告"),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("報告"),
    );
  });

  it("畳まれた議題の中のノードの項目を押すと、その議題が開いてノードが見え、選ばれた見た目になる", () => {
    scene(
      app,
      given(modelOf(snap(one("A2", "案", "<b>2 回</b>")))),
      mounted,
      expectScene(selector(`[data-node-id="A2"]`)).toBeAbsent(),
      click(CHANGE_BUTTON),
      expectScene(selector(`[data-node-id="A2"] .map-node`)).toHaveClass("map-node--selected"),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("<b>2 回</b>"),
    );
  });

  it("今のマップに無いノードの項目を押すと、選ぶだけ（「選んだノードは今のマップにありません」）。列はそのまま残る", () => {
    scene(
      app,
      given(modelOf(snap(one("gone", "決定", "消えたノード")))),
      mounted,
      click(CHANGE_BUTTON),
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NOT_ON_MAP),
      expectScene(selector(".map-node--selected")).toBeAbsent(),
      expectScene(CHANGE_LIST).toExist(),
      expectScene(CHANGE_BUTTON).toExist(),
    );
  });
});

describe("sidePanel の Scene: 右の列の出す・隠す（Disclosure の panel）", () => {
  it("出している間は .side の中に section.evidence → aside.changes の順で並び、Disclosure の panel の id と data-open が付き、出入りの動き・インラインの style は付かない", () => {
    scene(
      app,
      given(modelOf()),
      mounted,
      tap((s) => {
        const side = sideOf(s.html);
        expect(side.sel).toBe("div");
        expect(classOf(side)).toBe("side");
        expect(Option.isSome(attr(side, "id"))).toBe(true);
        expect(Option.isSome(attr(side, "data-open"))).toBe(true);
        expect(elements(side).map(named)).toEqual(["section.evidence", "aside.changes"]);
        const data = side.data ?? {};
        expect(data.style ?? {}).toEqual({});
        expect(Object.keys(data.on ?? {})).toEqual([]);
        const names = [...Object.keys(data.attrs ?? {}), ...Object.keys(data.props ?? {}), ...Object.keys(data.dataset ?? {})];
        expect(names.filter((n) => n.startsWith("data-enter") || n === "style")).toEqual([]);
      }),
    );
  });

  it("隠すと .side ごと描かず（空の列を残さない）、根拠も変わったことも出ない。出し直すと同じ並びで戻る。同じ画面の上で切り替わる", () => {
    scene(
      app,
      given(modelOf()),
      mounted,
      expectScene(selector(".side")).toExist(),
      toggleSide(false),
      expectScene(selector(".side")).toBeAbsent(),
      expectScene(EVIDENCE).toBeAbsent(),
      expectScene(CHANGE_LIST).toBeAbsent(),
      expectScene(selector("section.evidence h2")).toBeAbsent(),
      toggleSide(true),
      expectScene(selector(".side")).toExist(),
      tap((s) => expect(elements(sideOf(s.html)).map(named)).toEqual(["section.evidence", "aside.changes"])),
      expectScene(EVIDENCE).toExist(),
      expectScene(CHANGE_LIST).toExist(),
    );
  });

  it("隠している間に選んでも、出し直すと選んだノードの根拠が出る（隠す前の選択を持ったまま隠している状態から始める）", () => {
    scene(
      app,
      given(modelOf(snap(), { ...OPENED, selection: { id: "A1", byKey: false }, sideHidden: true })),
      expectScene(selector(".side")).toBeAbsent(),
      nodeButton("A2"),
      clickedNode("A2"),
      toggleSide(true),
      expectScene(selector("section.evidence p.evidence__text")).toHaveText("<b>2 回</b>"),
      expectScene(selector(`[data-node-id="A2"] .map-node`)).toHaveClass("map-node--selected"),
    );
  });

  it("隠した状態の viewing（sideHidden）で始まる Model では、最初から .side を描かない。出すと現れる", () => {
    scene(
      app,
      given(modelOf(snap(), { mode: "auto", sideHidden: true })),
      mounted,
      expectScene(selector(".side")).toBeAbsent(),
      expectScene(EVIDENCE).toBeAbsent(),
      toggleSide(true),
      expectScene(selector(".side")).toExist(),
      expectScene(selector("section.evidence p.evidence__empty")).toHaveText(EMPTY_NOT_SELECTED),
    );
  });

  it("すでに出している状態で「出す」、すでに隠している状態で「隠す」を受けても、状態は変わらない", () => {
    scene(
      app,
      given(modelOf()),
      mounted,
      toggleSide(true),
      expectScene(selector(".side")).toExist(),
      toggleSide(false),
      toggleSide(false),
      expectScene(selector(".side")).toBeAbsent(),
      toggleSide(true),
      expectScene(selector(".side")).toExist(),
    );
  });

  it("出す・隠すの状態は見る状態（viewing.sideHidden）が持つ: 隠した状態のまま変わったことの列も描かない（2 か所に持たない）", () => {
    scene(
      app,
      given(modelOf()),
      mounted,
      toggleSide(false),
      expectScene(CHANGE_BUTTON).toBeAbsent(),
      Subscription.emit(Message.ChangedSnapshot({ snapshot: snap([...CHANGES, { round: 4, at: 130, change: "追加", node: "B", kind: "議題", text: "報告" }]) })),
      expectScene(selector(".side")).toBeAbsent(),
      toggleSide(true),
      tap((s) => expect(textOf(sideOf(s.html), ".changes__text")).toEqual(["報告", "消えたノード", "面接は何回か", "採用"])),
    );
  });
});
