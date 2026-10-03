import { describe, expect, it } from "vitest";
import { applyOps, diffMaps, emptyMap, type Change, type MeetingMap, type Op } from "../src/core/index.ts";

const known = new Set(["r1", "r2", "r3", "r4", "r5"]);
const step = (map: MeetingMap, ops: Op[]): MeetingMap => applyOps(map, ops, known).map;

// 前のマップ:
//   n1 議題 採用
//     n2 論点 面接は何回か
//       n3 案 3 回
//   n4 課題 面接官が足りない
//   n5 課題 面接の担当が偏る
//     n6 案 若手も面接に入る
const before = (): MeetingMap =>
  step(emptyMap("定例"), [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r1"] },
    { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: ["r2"] },
    { op: "add", ref: "t4", parent: "root", kind: "課題", text: "面接官が足りない", evidence: ["r2"] },
    { op: "add", ref: "t5", parent: "root", kind: "課題", text: "面接の担当が偏る", evidence: ["r3"] },
    { op: "add", ref: "t6", parent: "t5", kind: "案", text: "若手も面接に入る", evidence: ["r3"] },
  ]);

// 前のマップに ops を反映した後のマップとの比較
const changesOf = (ops: Op[], base: MeetingMap = before()): Change[] => diffMaps(base, step(base, ops));

describe("diffMaps: 反映の前後のマップの比較から変わったことを導く", () => {
  it("何も変わらない反映（noop）では記録がない", () => {
    expect(changesOf([{ op: "noop", reason: "雑談" }])).toEqual([]);
    expect(changesOf([])).toEqual([]);
  });

  it("追加: 新しいノードは「追加」だけを、反映後の種別と本文で出す。ルートの記録は出ない", () => {
    const got = changesOf([{ op: "add", ref: "t7", parent: "n1", kind: "課題", text: "求人票が古い", evidence: ["r4"] }]);
    expect(got).toEqual([{ change: "追加", node: "n7", kind: "課題", text: "求人票が古い" }]);
  });

  it("追加: 新しい論点の下に決定を同時に足しても、決定済み化は出さず追加だけにする", () => {
    const got = changesOf([
      { op: "add", ref: "t7", parent: "root", kind: "論点", text: "予算", evidence: ["r4"] },
      { op: "add", ref: "t8", parent: "t7", kind: "決定", text: "来週決める", evidence: ["r4"] },
    ]);
    expect(got).toEqual([
      { change: "追加", node: "n7", kind: "論点", text: "予算" },
      { change: "追加", node: "n8", kind: "決定", text: "来週決める" },
    ]);
  });

  it("更新: 本文が変わると「更新」を、変わった後の本文で出す", () => {
    const got = changesOf([{ op: "update", node: "n1", text: "中途採用", evidence: ["r1"] }]);
    expect(got).toEqual([{ change: "更新", node: "n1", kind: "議題", text: "中途採用" }]);
  });

  it("更新: 本文が同じでも、根拠が増えれば「更新」になる", () => {
    const got = changesOf([{ op: "update", node: "n4", evidence: ["r4"] }]);
    expect(got).toEqual([{ change: "更新", node: "n4", kind: "課題", text: "面接官が足りない" }]);
  });

  it("更新: 本文も根拠も増えなければ記録しない", () => {
    expect(changesOf([{ op: "update", node: "n4", text: "面接官が足りない", evidence: ["r2"] }])).toEqual([]);
  });

  it("更新: 本文と根拠が両方変わっても、同じノードの「更新」は 1 件だけ", () => {
    const got = changesOf([{ op: "update", node: "n4", text: "面接官が不足", evidence: ["r4", "r5"] }]);
    expect(got).toEqual([{ change: "更新", node: "n4", kind: "課題", text: "面接官が不足" }]);
  });

  it("決定済み化: 論点の下に決定が増えると、その論点に「決定済み化」を出す（決定自身は追加）", () => {
    const got = changesOf([{ op: "add", ref: "t7", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r4"] }]);
    expect(got).toEqual([
      { change: "決定済み化", node: "n2", kind: "論点", text: "面接は何回か" },
      { change: "追加", node: "n7", kind: "決定", text: "2 回にする" },
    ]);
  });

  it("決定済み化: 既存の決定を未決の論点へ移すと、移した先の論点が「決定済み化」、決定は「移動」になる。元の論点には記録がない", () => {
    const base = step(before(), [
      { op: "add", ref: "t7", parent: "root", kind: "論点", text: "予算", evidence: ["r4"] },
      { op: "add", ref: "t8", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r4"] },
    ]);
    const got = changesOf([{ op: "move", node: "n8", parent: "n7" }], base);
    expect(got).toEqual([
      { change: "決定済み化", node: "n7", kind: "論点", text: "予算" },
      { change: "移動", node: "n8", kind: "決定", text: "2 回にする" },
    ]);
  });

  it("決定済み化: すでに決定済みの論点に決定が増えても記録しない（未決 → 決定済みの変化ではない）", () => {
    const base = step(before(), [{ op: "add", ref: "t7", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r4"] }]);
    const got = changesOf([{ op: "add", ref: "t8", parent: "n2", kind: "決定", text: "回数は最大 3 回", evidence: ["r5"] }], base);
    expect(got).toEqual([{ change: "追加", node: "n8", kind: "決定", text: "回数は最大 3 回" }]);
  });

  it("決定済み化: 決定を削除して未決に戻っても記録しない（削除は記録しない）", () => {
    const base = step(before(), [{ op: "add", ref: "t7", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r4"] }]);
    expect(changesOf([{ op: "delete", node: "n7" }], base)).toEqual([]);
  });

  it("却下: 案が検討中から却下に変わると「却下」を出す", () => {
    const got = changesOf([{ op: "update", node: "n3", evidence: ["r2"], planStatus: "却下" }]);
    expect(got).toEqual([{ change: "却下", node: "n3", kind: "案", text: "3 回" }]);
  });

  it("却下: 同じ反映で根拠だけが増えたときは、却下だけにして更新を重ねない", () => {
    const got = changesOf([{ op: "update", node: "n3", evidence: ["r4"], planStatus: "却下" }]);
    expect(got).toEqual([{ change: "却下", node: "n3", kind: "案", text: "3 回" }]);
  });

  it("却下: 同じ反映で本文も変われば「更新」と「却下」の両方を、この順で出す", () => {
    const got = changesOf([{ op: "update", node: "n3", text: "3 回にする", evidence: ["r2"], planStatus: "却下" }]);
    expect(got).toEqual([
      { change: "更新", node: "n3", kind: "案", text: "3 回にする" },
      { change: "却下", node: "n3", kind: "案", text: "3 回にする" },
    ]);
  });

  it("却下: すでに却下の案を却下にしても、記録しない。却下 → 検討中も種類にないので、根拠も本文も変わらなければ記録しない", () => {
    const rejected = step(before(), [{ op: "update", node: "n3", evidence: ["r2"], planStatus: "却下" }]);
    expect(changesOf([{ op: "update", node: "n3", evidence: ["r2"], planStatus: "却下" }], rejected)).toEqual([]);
    expect(changesOf([{ op: "update", node: "n3", evidence: ["r2"], planStatus: "検討中" }], rejected)).toEqual([]);
  });

  it("移動: 親が変わったノードにだけ「移動」を出す。子孫には記録がない", () => {
    // n2（子に n3 を持つ）を root の下へ
    const got = changesOf([{ op: "move", node: "n2", parent: "root" }]);
    expect(got).toEqual([{ change: "移動", node: "n2", kind: "論点", text: "面接は何回か" }]);
  });

  it("移動: 本文も変われば「更新」と「移動」の両方を、この順で出す", () => {
    const got = changesOf([
      { op: "move", node: "n3", parent: "n1" },
      { op: "update", node: "n3", text: "3 回まで", evidence: ["r2"] },
    ]);
    expect(got).toEqual([
      { change: "更新", node: "n3", kind: "案", text: "3 回まで" },
      { change: "移動", node: "n3", kind: "案", text: "3 回まで" },
    ]);
  });

  it("統合: 統合先にだけ「統合」を出す（統合先の種別と本文）。統合元の記録はなく、引き取った子は「移動」にならず、根拠の増加は「更新」にならない", () => {
    // n5 を n4 へ。n5 の根拠 r3 が n4 に入り、n5 の子 n6 が n4 の子になる
    const got = changesOf([{ op: "combine", from: "n5", into: "n4" }]);
    expect(got).toEqual([{ change: "統合", node: "n4", kind: "課題", text: "面接官が足りない" }]);
  });

  it("統合: 統合先の本文も同時に変われば「更新」と「統合」の両方を、この順で出す", () => {
    const got = changesOf([
      { op: "combine", from: "n5", into: "n4" },
      { op: "update", node: "n4", text: "面接官が足りず担当も偏る", evidence: ["r3"] },
    ]);
    expect(got).toEqual([
      { change: "更新", node: "n4", kind: "課題", text: "面接官が足りず担当も偏る" },
      { change: "統合", node: "n4", kind: "課題", text: "面接官が足りず担当も偏る" },
    ]);
  });

  it("統合: 子を持たない統合元でも、根拠を統合先が新しく得れば統合先に「統合」を出す", () => {
    const base = step(before(), [{ op: "add", ref: "t7", parent: "root", kind: "課題", text: "採用の窓口がない", evidence: ["r4"] }]);
    const got = changesOf([{ op: "combine", from: "n7", into: "n4" }], base);
    expect(got).toEqual([{ change: "統合", node: "n4", kind: "課題", text: "面接官が足りない" }]);
  });

  it("統合: 同じ反映で A → B、B → C と続けて統合されても、C の「統合」は 1 件だけ", () => {
    const base = step(before(), [{ op: "add", ref: "t7", parent: "root", kind: "課題", text: "採用の窓口がない", evidence: ["r4"] }]);
    const got = changesOf(
      [
        { op: "combine", from: "n7", into: "n5" },
        { op: "combine", from: "n5", into: "n4" },
      ],
      base,
    );
    expect(got).toEqual([{ change: "統合", node: "n4", kind: "課題", text: "面接官が足りない" }]);
  });

  it("削除: 削除されたノードの記録は出ない（種類にない）", () => {
    expect(changesOf([{ op: "delete", node: "n4" }])).toEqual([]);
    expect(changesOf([{ op: "delete", node: "n6" }])).toEqual([]);
  });

  it("複数のノードが変わると、反映後のマップのノードの並び（作られた順）に出す。同じノードの中は 追加・更新・決定済み化・却下・移動・統合 の順", () => {
    const got = changesOf([
      { op: "update", node: "n3", text: "3 回にする", evidence: ["r2"], planStatus: "却下" }, // n3: 更新・却下
      { op: "add", ref: "t7", parent: "n2", kind: "決定", text: "2 回にする", evidence: ["r4"] }, // n2: 決定済み化、n7: 追加
      { op: "update", node: "n1", text: "中途採用", evidence: ["r1"] }, // n1: 更新
    ]);
    expect(got.map((c) => [c.node, c.change])).toEqual([
      ["n1", "更新"],
      ["n2", "決定済み化"],
      ["n3", "更新"],
      ["n3", "却下"],
      ["n7", "追加"],
    ]);
  });

  it("入力の 2 つのマップを変更しない", () => {
    const b = before();
    const a = step(b, [
      { op: "update", node: "n3", text: "3 回にする", evidence: ["r4"], planStatus: "却下" },
      { op: "combine", from: "n5", into: "n4" },
    ]);
    const bSnapshot = JSON.parse(JSON.stringify(b));
    const aSnapshot = JSON.parse(JSON.stringify(a));
    diffMaps(b, a);
    expect(b).toEqual(bSnapshot);
    expect(a).toEqual(aSnapshot);
  });
});

describe("種別「要点」を applyOps が受け入れる", () => {
  const withPoint = (): MeetingMap =>
    step(emptyMap("共有会"), [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "ふりかえり", evidence: ["r1"] },
      { op: "add", ref: "t2", parent: "t1", kind: "要点", text: "毎週 15 分で回す", evidence: ["r2"] },
      { op: "add", ref: "t3", parent: "t2", kind: "要点", text: "司会は持ち回り", evidence: ["r3"] },
    ]);

  it("議題の下に要点を add でき、要点の下にも要点を add できる（要点は子を持てる）", () => {
    const result = applyOps(emptyMap("共有会"), [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "ふりかえり", evidence: ["r1"] },
      { op: "add", ref: "t2", parent: "t1", kind: "要点", text: "毎週 15 分で回す", evidence: ["r2"] },
      { op: "add", ref: "t3", parent: "t2", kind: "要点", text: "司会は持ち回り", evidence: ["r3"] },
    ], known);

    expect(result.map.order.map((id) => result.map.nodes[id]!.kind)).toEqual(["会議", "議題", "要点", "要点"]);
    expect(result.map.nodes[result.map.order[3]!]!.parent).toBe(result.map.order[2]);
  });

  it("要点の本文を update で置き換えられ、変更の記録は「更新」になる", () => {
    const base = withPoint();
    const id = base.order[2]!;

    expect(changesOf([{ op: "update", node: id, text: "毎週 20 分で回す", evidence: ["r4"] }], base)).toEqual([
      { change: "更新", node: id, kind: "要点", text: "毎週 20 分で回す" },
    ]);
  });
});
