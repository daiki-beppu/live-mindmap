import { describe, expect, it } from "vitest";
import { applyOps, emptyMap, type MeetingMap, type Op, type Remark } from "../src/core/index.ts";

const known = new Set(["r1", "r2", "r3", "r4"]);
// 発言の表。r4 は ID が最後でも開始がいちばん早い（統合で比べるのは ID の順ではなく開始時刻）
const remarkAt = (id: string, start: number): Remark => ({ id, track: "相手", start, end: start + 1, text: "発言" });
const remarks: ReadonlyMap<string, Remark> = new Map([remarkAt("r1", 10), remarkAt("r2", 20), remarkAt("r3", 30), remarkAt("r4", 5)].map((r) => [r.id, r]));
const stamped = (map: MeetingMap, ops: Op[], stamp = { round: 2, at: 10 }) => applyOps(map, ops, known, stamp, remarks);

// 基準のマップ（反映 1 回目、時刻 0）:
//   n1 議題 採用
//     n2 論点 回数
//       n3 案 3 回
//       n4 決定 3 回にする
//       n5 TODO 日程を決める
//   n6 課題 人が足りない
const base = (): MeetingMap =>
  applyOps(emptyMap("定例"), [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "回数", evidence: ["r1"] },
    { op: "add", ref: "t3", parent: "t2", kind: "案", text: "3 回", evidence: ["r1"] },
    { op: "add", ref: "t4", parent: "t2", kind: "決定", text: "3 回にする", evidence: ["r1"] },
    { op: "add", ref: "t5", parent: "t2", kind: "TODO", text: "日程を決める", evidence: ["r1"] },
    { op: "add", ref: "t6", parent: "root", kind: "課題", text: "人が足りない", evidence: ["r1"] },
  ], known, { round: 1, at: 0 }, remarks).map;

const node = (map: MeetingMap, id: string) => map.nodes[id]!;
const reasons = (ops: Op[], map: MeetingMap = base(), stamp?: { round: number; at: number }) => stamped(map, ops, stamp).dropped.map((d) => d.reason);

describe("applyOps: 入力のマップ", () => {
  it("どの操作を当てても、渡したマップは書き換えない", () => {
    const input = base();
    stamped(input, [
      { op: "add", ref: "t7", parent: "root", kind: "課題", text: "新しい課題", evidence: ["r2"] },
      { op: "combine", from: "t7", into: "n6" },
      { op: "update", node: "n3", text: "4 回", planStatus: "却下", evidence: ["r2"] },
      { op: "move", node: "n5", parent: "root" },
      { op: "delete", node: "n4" },
      { op: "close", node: "n1" },
    ], { round: 9, at: 99 });
    expect(input).toEqual(base());
  });

  it("捨てた操作は、仮 ID を解決する前の元の形で dropped に入る", () => {
    const op: Op = { op: "update", node: "t7", planStatus: "却下", evidence: ["r2"] };
    const got = stamped(base(), [
      { op: "add", ref: "t7", parent: "root", kind: "課題", text: "新しい課題", evidence: ["r2"] },
      op,
    ]);
    expect(got.dropped).toEqual([{ op, reason: "状態を持つのは案だけ" }]);
  });
});

describe("applyOps: add", () => {
  it("n1〜n6 があるマップに足すと n7 が振られる", () => {
    const got = stamped(base(), [{ op: "add", ref: "t7", parent: "root", kind: "課題", text: "新しい課題", evidence: ["r2"] }]);
    expect(got.dropped).toEqual([]);
    expect(node(got.map, "n7").text).toBe("新しい課題");
    expect(got.map.nextId).toBe(8);
  });

  it("既存の ID と同じ仮 ID は捨て、捨てた追加は番号を使わない", () => {
    const got = stamped(base(), [
      { op: "add", ref: "n1", parent: "root", kind: "課題", text: "重なる", evidence: ["r2"] },
      { op: "add", ref: "t7", parent: "root", kind: "課題", text: "次の追加", evidence: ["r2"] },
    ]);
    expect(got.dropped.map((d) => d.reason)).toEqual(["仮 ID が既存の ID と重なる"]);
    expect(node(got.map, "n7").text).toBe("次の追加");
    expect(got.map.nextId).toBe(8);
  });

  it("同じ応答の中で使った仮 ID をもう一度使う追加は捨てる", () => {
    const got = stamped(base(), [
      { op: "add", ref: "t7", parent: "root", kind: "課題", text: "最初", evidence: ["r2"] },
      { op: "add", ref: "t7", parent: "root", kind: "課題", text: "二度目", evidence: ["r2"] },
      { op: "add", ref: "t8", parent: "t7", kind: "案", text: "続き", evidence: ["r2"] },
    ]);
    expect(got.dropped.map((d) => d.reason)).toEqual(["仮 ID が既存の ID と重なる"]);
    expect(node(got.map, "n7").text).toBe("最初");
    expect(node(got.map, "n8")).toMatchObject({ text: "続き", parent: "n7" });
    expect(got.map.nextId).toBe(9);
  });

  it("決定の親が論点以外なら捨てる", () => {
    expect(reasons([{ op: "add", ref: "t7", parent: "n6", kind: "決定", text: "決める", evidence: ["r2"] }])).toEqual(["決定の親は論点に限る"]);
  });

  it("案だけ planStatus: 検討中 で作られる", () => {
    const { map } = stamped(base(), [
      { op: "add", ref: "t7", parent: "n2", kind: "案", text: "案", evidence: ["r2"] },
      { op: "add", ref: "t8", parent: "n2", kind: "課題", text: "課題", evidence: ["r2"] },
    ]);
    expect(node(map, "n7").planStatus).toBe("検討中");
    expect(node(map, "n8")).not.toHaveProperty("planStatus");
  });

  it("assignee と due は TODO で値があるときだけ写す", () => {
    const { map } = stamped(base(), [
      { op: "add", ref: "t7", parent: "n2", kind: "TODO", text: "担当あり", evidence: ["r2"], assignee: "田中", due: "来週" },
      { op: "add", ref: "t8", parent: "n2", kind: "TODO", text: "担当なし", evidence: ["r2"] },
      { op: "add", ref: "t9", parent: "n2", kind: "TODO", text: "空文字", evidence: ["r2"], assignee: "", due: "" },
      { op: "add", ref: "t10", parent: "n2", kind: "課題", text: "TODO 以外", evidence: ["r2"], assignee: "田中", due: "来週" },
    ]);
    expect(node(map, "n7")).toMatchObject({ assignee: "田中", due: "来週" });
    for (const id of ["n8", "n9", "n10"]) {
      expect(node(map, id)).not.toHaveProperty("assignee");
      expect(node(map, id)).not.toHaveProperty("due");
    }
  });
});

describe("applyOps: update", () => {
  it("案には planStatus を付けられ、案以外に付けると捨てる", () => {
    const got = stamped(base(), [
      { op: "update", node: "n3", planStatus: "却下", evidence: ["r2"] },
      { op: "update", node: "n6", planStatus: "却下", evidence: ["r2"] },
    ]);
    expect(got.dropped.map((d) => d.reason)).toEqual(["状態を持つのは案だけ"]);
    expect(node(got.map, "n3").planStatus).toBe("却下");
    expect(node(got.map, "n6")).not.toHaveProperty("planStatus");
  });

  it("ルートと存在しないノードは対象が無い", () => {
    expect(reasons([
      { op: "update", node: "root", text: "x", evidence: ["r2"] },
      { op: "update", node: "n99", text: "x", evidence: ["r2"] },
    ])).toEqual(["対象が無い", "対象が無い"]);
  });
});

describe("applyOps: move", () => {
  it("存在しないノードとルートは対象が無い", () => {
    expect(reasons([{ op: "move", node: "n99", parent: "root" }, { op: "move", node: "root", parent: "n1" }])).toEqual(["対象が無い", "対象が無い"]);
  });

  it("親が無い・決定や TODO の下・論点以外の下の決定を捨てる", () => {
    expect(reasons([
      { op: "move", node: "n6", parent: "n99" },
      { op: "move", node: "n6", parent: "n4" },
      { op: "move", node: "n6", parent: "n5" },
      { op: "move", node: "n4", parent: "n6" },
    ])).toEqual(["親が存在しない", "決定 は子を持てない", "TODO は子を持てない", "決定の親は論点に限る"]);
  });

  it("自分の子孫の下へは移せない", () => {
    expect(reasons([{ op: "move", node: "n1", parent: "n3" }])).toEqual(["自分の子孫の下へは移せない"]);
  });

  it("親が変わると changeOrder に入り、旧い親と自分の祖先に触れた時刻が付く", () => {
    const got = stamped(base(), [{ op: "move", node: "n5", parent: "root" }]);
    expect(got.dropped).toEqual([]);
    expect(got.changeOrder).toEqual(["n5"]);
    expect(node(got.map, "n5").parent).toBe("root");
    expect(node(got.map, "n5").touchedAt).toBe(10);
    expect(node(got.map, "n2").touchedAt).toBe(10);
    expect(node(got.map, "n1").touchedAt).toBe(10);
    expect(node(got.map, "n4").touchedAt).toBe(0);
    expect(node(got.map, "n6").touchedAt).toBe(0);
  });

  it("同じ親への移動は changeOrder にも touchedAt にも入らない", () => {
    const got = stamped(base(), [{ op: "move", node: "n5", parent: "n2" }]);
    expect(got.dropped).toEqual([]);
    expect(got.changeOrder).toEqual([]);
    for (const id of ["n1", "n2", "n3", "n4", "n5", "n6"]) expect(node(got.map, id).touchedAt).toBe(0);
  });
});

describe("applyOps: combine", () => {
  const withTwoIssues = (round: number) => stamped(base(), [{ op: "add", ref: "t7", parent: "root", kind: "課題", text: "人が足りない（別の言い方）", evidence: ["r2"] }], { round, at: 5 }).map;

  it("存在しない・ルート・自分自身は対象が無い", () => {
    expect(reasons([
      { op: "combine", from: "n99", into: "n6" },
      { op: "combine", from: "n6", into: "n99" },
      { op: "combine", from: "root", into: "n6" },
      { op: "combine", from: "n6", into: "root" },
      { op: "combine", from: "n6", into: "n6" },
    ])).toEqual(["対象が無い", "対象が無い", "対象が無い", "対象が無い", "対象が無い"]);
  });

  it("種別が違うと捨てる", () => {
    expect(reasons([{ op: "combine", from: "n6", into: "n3" }])).toEqual(["統合は同じ種別どうしに限る"]);
  });

  it("子孫へは統合できない", () => {
    const map = stamped(base(), [{ op: "add", ref: "t7", parent: "n2", kind: "論点", text: "子の論点", evidence: ["r2"] }]).map;
    expect(reasons([{ op: "combine", from: "n2", into: "n7" }], map)).toEqual(["子孫へは統合できない"]);
  });

  it("子を持つノードを決定・TODO へは統合できない", () => {
    // 木の制約を破った状態（決定の下に案がある）を直接作り、検証の分岐だけを確かめる
    const withKids = base();
    node(withKids, "n3").parent = "n4";
    const map = stamped(withKids, [{ op: "add", ref: "t7", parent: "n2", kind: "決定", text: "もう一つの決定", evidence: ["r2"] }]).map;
    node(map, "n5").parent = "n7";
    expect(reasons([{ op: "combine", from: "n4", into: "n7" }], map)).toEqual(["決定 は子を持てない"]);
  });

  it("統合先が changeOrder に入り、統合元は消えて子と根拠が統合先に移る", () => {
    const map = withTwoIssues(3);
    const got = stamped(map, [{ op: "combine", from: "n6", into: "n7" }]);
    expect(got.dropped).toEqual([]);
    expect(got.changeOrder).toEqual(["n7"]);
    expect(got.map.nodes).not.toHaveProperty("n6");
    expect(got.map.order).not.toContain("n6");
    expect(node(got.map, "n7").evidence).toEqual(["r2", "r1"]);
    expect(node(got.map, "n7").touchedAt).toBe(10);
  });

  it("evidenceRound は統合元と統合先の大きい方を引き継ぐ", () => {
    // n6 は 1 回目、n7 は 3 回目
    expect(node(stamped(withTwoIssues(3), [{ op: "combine", from: "n6", into: "n7" }], { round: 5, at: 10 }).map, "n7").evidenceRound).toBe(3);
    expect(node(stamped(withTwoIssues(3), [{ op: "combine", from: "n7", into: "n6" }], { round: 5, at: 10 }).map, "n6").evidenceRound).toBe(3);
  });

  it("evidenceRound は片方が無ければもう片方、両方無ければ付けない", () => {
    const noFrom = withTwoIssues(3);
    delete node(noFrom, "n6").evidenceRound;
    expect(node(stamped(noFrom, [{ op: "combine", from: "n6", into: "n7" }], { round: 5, at: 10 }).map, "n7").evidenceRound).toBe(3);

    const noInto = withTwoIssues(3);
    delete node(noInto, "n7").evidenceRound;
    expect(node(stamped(noInto, [{ op: "combine", from: "n6", into: "n7" }], { round: 5, at: 10 }).map, "n7").evidenceRound).toBe(1);
    expect(node(stamped(noInto, [{ op: "combine", from: "n7", into: "n6" }], { round: 5, at: 10 }).map, "n6").evidenceRound).toBe(1);

    const neither = withTwoIssues(3);
    delete node(neither, "n6").evidenceRound;
    delete node(neither, "n7").evidenceRound;
    expect(node(stamped(neither, [{ op: "combine", from: "n6", into: "n7" }], { round: 5, at: 10 }).map, "n7")).not.toHaveProperty("evidenceRound");
  });
});

describe("applyOps: delete", () => {
  it("存在しないノードとルートは対象が無い", () => {
    expect(reasons([{ op: "delete", node: "n99" }, { op: "delete", node: "root" }])).toEqual(["対象が無い", "対象が無い"]);
  });

  it("子を持つノードは削除できない", () => {
    expect(reasons([{ op: "delete", node: "n2" }])).toEqual(["子を持つノードは削除できない"]);
  });

  it("削除は changeOrder に入らず、親の touchedAt だけ進める", () => {
    const got = stamped(base(), [{ op: "delete", node: "n5" }]);
    expect(got.dropped).toEqual([]);
    expect(got.changeOrder).toEqual([]);
    expect(got.map.nodes).not.toHaveProperty("n5");
    expect(node(got.map, "n2").touchedAt).toBe(10);
    expect(node(got.map, "n1").touchedAt).toBe(10);
    expect(node(got.map, "n6").touchedAt).toBe(0);
  });
});

describe("applyOps: close", () => {
  const later = { round: 5, at: 10 };

  it("存在しないノードとルートは対象が無い", () => {
    expect(reasons([{ op: "close", node: "n99" }, { op: "close", node: "root" }], base(), later)).toEqual(["対象が無い", "対象が無い"]);
  });

  it("議題・論点以外は閉じられない", () => {
    expect(reasons([{ op: "close", node: "n6" }, { op: "close", node: "n3" }], base(), later)).toEqual(["閉じられるのは議題・論点だけ", "閉じられるのは議題・論点だけ"]);
  });

  it("すでに済みなら捨てる", () => {
    expect(reasons([{ op: "close", node: "n1" }, { op: "close", node: "n1" }], base(), later)).toEqual(["すでに済み"]);
  });

  it("対象の子孫に直前の反映で根拠が足されていれば捨てる", () => {
    expect(reasons([{ op: "close", node: "n2" }], base(), { round: 2, at: 10 })).toEqual(["同じ応答か直前の差分更新で根拠が足されている"]);
  });

  it("閉じると済みになるが、changeOrder と touchedAt は変えない", () => {
    const got = stamped(base(), [{ op: "close", node: "n2" }], later);
    expect(got.dropped).toEqual([]);
    expect(got.changeOrder).toEqual([]);
    expect(node(got.map, "n2").talkStatus).toBe("済み");
    for (const id of ["n1", "n2", "n3", "n4", "n5", "n6"]) expect(node(got.map, id).touchedAt).toBe(0);
  });
});

describe("applyOps: 仮 ID の対応 refs", () => {
  it("適用できた add の仮 ID → n の ID だけを返す。捨てた add（親が無い・既存 ID と重なる）は含まない", () => {
    const got = stamped(base(), [
      { op: "add", ref: "a1", parent: "root", kind: "課題", text: "成功", evidence: ["r2"] },
      { op: "add", ref: "a2", parent: "zzz", kind: "課題", text: "親が無い", evidence: ["r2"] },
      { op: "add", ref: "a3", parent: "a1", kind: "案", text: "a1 を親にする", evidence: ["r2"] },
      { op: "add", ref: "n1", parent: "root", kind: "課題", text: "既存と重なる", evidence: ["r2"] },
    ]);
    expect(got.dropped.map((d) => d.reason)).toEqual(["親が存在しない", "仮 ID が既存の ID と重なる"]);
    expect(got.refs).toEqual({ a1: "n7", a3: "n8" });
  });

  it("add が無い、または全部捨てた応答では、空の対応を返す", () => {
    expect(stamped(base(), [{ op: "update", node: "n3", text: "4 回", evidence: ["r2"] }]).refs).toEqual({});
    expect(stamped(base(), [{ op: "add", ref: "a1", parent: "zzz", kind: "課題", text: "x", evidence: ["r2"] }]).refs).toEqual({});
  });
});

// 案の出した人（Issue #1023）。サーバーが決めて add の proposer に載せた値を、ノードに持たせる。更新では変えず、統合では根拠の最も早い発言が早いほうを残す
describe("applyOps: 案の出した人", () => {
  const plans = (): MeetingMap => stamped(base(), [
    { op: "add", ref: "p1", parent: "n2", kind: "案", text: "月 1", evidence: ["r1"], proposer: "相手 A" }, // n7
    { op: "add", ref: "p2", parent: "n2", kind: "案", text: "週 1", evidence: ["r2"], proposer: "相手 B" }, // n8
    { op: "add", ref: "p3", parent: "n2", kind: "案", text: "隔週", evidence: ["r4"], proposer: "相手 C" }, // n9（r4 は r1 より早い）
    { op: "add", ref: "p4", parent: "n2", kind: "案", text: "旧ログの案", evidence: ["r3"] }, // n10: 出した人を持たない
  ], { round: 1, at: 0 }).map;

  it("案の add の proposer をノードに持たせる。無ければキーごと持たない", () => {
    const map = plans();
    expect(node(map, "n7").proposer).toBe("相手 A");
    expect(node(map, "n8").proposer).toBe("相手 B");
    expect(node(map, "n10")).not.toHaveProperty("proposer");
  });

  it("話者なしの相手は「相手」をそのまま持つ", () => {
    const { map } = stamped(base(), [{ op: "add", ref: "p1", parent: "n2", kind: "案", text: "案", evidence: ["r1"], proposer: "相手" }]);
    expect(node(map, "n7").proposer).toBe("相手");
  });

  it("案以外には proposer が付いても持たせない（捨てもしない）", () => {
    const got = stamped(base(), [
      { op: "add", ref: "a", parent: "root", kind: "議題", text: "議題", evidence: ["r1"], proposer: "相手 A" },
      { op: "add", ref: "b", parent: "n1", kind: "論点", text: "論点", evidence: ["r1"], proposer: "相手 A" },
      { op: "add", ref: "c", parent: "n2", kind: "決定", text: "決定", evidence: ["r1"], proposer: "相手 A" },
      { op: "add", ref: "d", parent: "root", kind: "課題", text: "課題", evidence: ["r1"], proposer: "相手 A" },
      { op: "add", ref: "e", parent: "n2", kind: "TODO", text: "TODO", evidence: ["r1"], proposer: "相手 A" },
      { op: "add", ref: "f", parent: "root", kind: "要点", text: "要点", evidence: ["r1"], proposer: "相手 A" },
    ]);
    expect(got.dropped).toEqual([]);
    for (const id of ["n7", "n8", "n9", "n10", "n11", "n12"]) expect(node(got.map, id), id).not.toHaveProperty("proposer");
  });

  it("更新で、より早い発言が根拠に足されても出した人は変わらない", () => {
    const got = stamped(plans(), [
      { op: "update", node: "n7", text: "月 2", evidence: ["r4"], planStatus: "却下" }, // r4 は n7 の根拠 r1 より早い
      { op: "update", node: "n10", text: "言い換え", evidence: ["r4"] }, // 出した人が無い案に足しても、計算して付けない
    ]);
    expect(got.dropped).toEqual([]);
    expect(node(got.map, "n7")).toMatchObject({ text: "月 2", evidence: ["r1", "r4"], proposer: "相手 A" });
    expect(node(got.map, "n10")).not.toHaveProperty("proposer");
  });

  it("統合では、根拠の最も早い発言が早いほうの出した人が統合先に残る（統合元が早い）", () => {
    const got = stamped(plans(), [{ op: "combine", from: "n9", into: "n7" }]); // n9 は r4（開始 5）、n7 は r1（開始 10）
    expect(got.dropped).toEqual([]);
    expect(node(got.map, "n7")).toMatchObject({ proposer: "相手 C", evidence: ["r1", "r4"] });
    expect(got.map.nodes).not.toHaveProperty("n9");
  });

  it("統合では、統合先が早ければ統合先の出した人のまま", () => {
    const got = stamped(plans(), [{ op: "combine", from: "n7", into: "n9" }]);
    expect(node(got.map, "n9").proposer).toBe("相手 C");
  });

  it("統合で比べるのは発言の開始時刻で、ID の順や根拠の並びではない", () => {
    const got = stamped(plans(), [{ op: "combine", from: "n8", into: "n7" }]); // r2（開始 20）は r1（開始 10）より遅い
    expect(node(got.map, "n7").proposer).toBe("相手 A");
    const reverse = stamped(plans(), [{ op: "combine", from: "n7", into: "n8" }]);
    expect(node(reverse.map, "n8").proposer).toBe("相手 A");
  });

  it("統合で最も早い発言の開始が同じなら、統合先の出した人を残す", () => {
    const { map } = stamped(base(), [
      { op: "add", ref: "p1", parent: "n2", kind: "案", text: "先", evidence: ["r1"], proposer: "相手 A" }, // n7
      { op: "add", ref: "p2", parent: "n2", kind: "案", text: "後", evidence: ["r1"], proposer: "相手 B" }, // n8
    ], { round: 1, at: 0 });
    expect(node(stamped(map, [{ op: "combine", from: "n7", into: "n8" }]).map, "n8").proposer).toBe("相手 B");
  });

  it("統合元が早く出した人を持たないとき、統合先の出した人は消える（古いログの案が早いなら、後の人を残さない）", () => {
    const { map } = stamped(base(), [
      { op: "add", ref: "p1", parent: "n2", kind: "案", text: "旧", evidence: ["r4"] }, // n7: 出した人なし、r4 は開始 5
      { op: "add", ref: "p2", parent: "n2", kind: "案", text: "新", evidence: ["r2"], proposer: "相手 B" }, // n8
    ], { round: 1, at: 0 });
    expect(node(stamped(map, [{ op: "combine", from: "n7", into: "n8" }]).map, "n8")).not.toHaveProperty("proposer");
  });

  it("統合元が遅く出した人を持たないとき、統合先の出した人は残る", () => {
    const { map } = stamped(base(), [
      { op: "add", ref: "p1", parent: "n2", kind: "案", text: "旧", evidence: ["r3"] }, // n7: 出した人なし、r3 は開始 30
      { op: "add", ref: "p2", parent: "n2", kind: "案", text: "新", evidence: ["r2"], proposer: "相手 B" }, // n8
    ], { round: 1, at: 0 });
    expect(node(stamped(map, [{ op: "combine", from: "n7", into: "n8" }]).map, "n8").proposer).toBe("相手 B");
  });

  it("発言の表に根拠が無い統合では、統合先の出した人を変えない（落ちない）", () => {
    const got = applyOps(plans(), [{ op: "combine", from: "n9", into: "n7" }], known, { round: 2, at: 10 }, new Map());
    expect(got.dropped).toEqual([]);
    expect(node(got.map, "n7").proposer).toBe("相手 A");
  });

  it("出した人は、いつもその案の根拠の発言のどれかの話者（更新・統合をしても）", () => {
    const speakerOf: Record<string, string> = { r1: "相手 A", r2: "相手 B", r4: "相手 C" };
    const evidenceSpeakers = (map: MeetingMap, id: string) => node(map, id).evidence.map((u) => speakerOf[u]);
    const afterUpdate = stamped(plans(), [{ op: "update", node: "n8", evidence: ["r1", "r4"] }]).map;
    expect(evidenceSpeakers(afterUpdate, "n8")).toContain(node(afterUpdate, "n8").proposer);
    const afterCombine = stamped(afterUpdate, [{ op: "combine", from: "n9", into: "n8" }]).map;
    expect(evidenceSpeakers(afterCombine, "n8")).toContain(node(afterCombine, "n8").proposer);
  });
});

// TODO の担当者（Issue #1023）。名前の assignee が優先で、名前が無いときだけ担当の話者を持つ。更新で埋めたり替えたりできる
describe("applyOps: TODO の担当者", () => {
  it("名前だけ・話者だけ・どちらも無いは、あるほうだけを持つ", () => {
    const { map } = stamped(base(), [
      { op: "add", ref: "a", parent: "n2", kind: "TODO", text: "名前", evidence: ["r2"], assignee: "田中" }, // n7
      { op: "add", ref: "b", parent: "n2", kind: "TODO", text: "話者", evidence: ["r2"], assigneeSpeaker: "相手 A" }, // n8
      { op: "add", ref: "c", parent: "n2", kind: "TODO", text: "無し", evidence: ["r2"] }, // n9
    ]);
    expect(node(map, "n7")).toMatchObject({ assignee: "田中" });
    expect(node(map, "n7")).not.toHaveProperty("assigneeSpeaker");
    expect(node(map, "n8")).toMatchObject({ assigneeSpeaker: "相手 A" });
    expect(node(map, "n8")).not.toHaveProperty("assignee");
    expect(node(map, "n9")).not.toHaveProperty("assignee");
    expect(node(map, "n9")).not.toHaveProperty("assigneeSpeaker");
  });

  it("名前と話者が両方あれば名前を優先し、話者は持たない", () => {
    const { map } = stamped(base(), [{ op: "add", ref: "a", parent: "n2", kind: "TODO", text: "両方", evidence: ["r2"], assignee: "田中", assigneeSpeaker: "相手 A", due: "来週" }]);
    expect(node(map, "n7")).toMatchObject({ assignee: "田中", due: "来週" });
    expect(node(map, "n7")).not.toHaveProperty("assigneeSpeaker");
  });

  it("名前が空文字なら話者を持つ", () => {
    const { map } = stamped(base(), [{ op: "add", ref: "a", parent: "n2", kind: "TODO", text: "空の名前", evidence: ["r2"], assignee: "", assigneeSpeaker: "自分" }]);
    expect(node(map, "n7")).toMatchObject({ assigneeSpeaker: "自分" });
    expect(node(map, "n7")).not.toHaveProperty("assignee");
  });

  it("TODO 以外の add の assigneeSpeaker は、操作を捨てずに無視する", () => {
    const got = stamped(base(), [
      { op: "add", ref: "a", parent: "n2", kind: "案", text: "案", evidence: ["r2"], assigneeSpeaker: "相手 A" },
      { op: "add", ref: "b", parent: "root", kind: "課題", text: "課題", evidence: ["r2"], assigneeSpeaker: "相手 A" },
      { op: "add", ref: "c", parent: "n2", kind: "決定", text: "決定", evidence: ["r2"], assigneeSpeaker: "相手 A" },
    ]);
    expect(got.dropped).toEqual([]);
    for (const id of ["n7", "n8", "n9"]) expect(node(got.map, id), id).not.toHaveProperty("assigneeSpeaker");
  });

  const todos = (): MeetingMap => stamped(base(), [
    { op: "add", ref: "a", parent: "n2", kind: "TODO", text: "話者の担当", evidence: ["r1"], assigneeSpeaker: "相手 A" }, // n7
    { op: "add", ref: "b", parent: "n2", kind: "TODO", text: "名前の担当", evidence: ["r1"], assignee: "田中" }, // n8
    { op: "add", ref: "c", parent: "n2", kind: "TODO", text: "担当なし", evidence: ["r1"] }, // n9
  ], { round: 1, at: 0 }).map;

  it("更新で名前が来たら名前を置き、担当の話者は消す", () => {
    const got = stamped(todos(), [{ op: "update", node: "n7", evidence: ["r2"], assignee: "鈴木" }]);
    expect(node(got.map, "n7")).toMatchObject({ assignee: "鈴木" });
    expect(node(got.map, "n7")).not.toHaveProperty("assigneeSpeaker");
  });

  it("更新で名前を替えられる。話者のあった TODO でなくても名前は置き換わる", () => {
    const got = stamped(todos(), [{ op: "update", node: "n8", evidence: ["r2"], assignee: "鈴木" }]);
    expect(node(got.map, "n8").assignee).toBe("鈴木");
  });

  it("名前の無い TODO には、更新で担当の話者を埋められ、替えられる", () => {
    const filled = stamped(todos(), [{ op: "update", node: "n9", evidence: ["r2"], assigneeSpeaker: "相手 B" }]).map;
    expect(node(filled, "n9").assigneeSpeaker).toBe("相手 B");
    const replaced = stamped(todos(), [{ op: "update", node: "n7", evidence: ["r2"], assigneeSpeaker: "相手 B" }]).map;
    expect(node(replaced, "n7").assigneeSpeaker).toBe("相手 B");
  });

  it("名前のある TODO への assigneeSpeaker の更新は無視する（名前を優先）", () => {
    const got = stamped(todos(), [{ op: "update", node: "n8", evidence: ["r2"], assigneeSpeaker: "相手 B" }]);
    expect(got.dropped).toEqual([]);
    expect(node(got.map, "n8")).toMatchObject({ assignee: "田中" });
    expect(node(got.map, "n8")).not.toHaveProperty("assigneeSpeaker");
  });

  it("同じ更新に名前と話者があれば、名前を置いて話者は持たない", () => {
    const got = stamped(todos(), [{ op: "update", node: "n9", evidence: ["r2"], assignee: "鈴木", assigneeSpeaker: "相手 B" }]);
    expect(node(got.map, "n9")).toMatchObject({ assignee: "鈴木" });
    expect(node(got.map, "n9")).not.toHaveProperty("assigneeSpeaker");
  });

  it("TODO 以外への assignee・assigneeSpeaker の更新は、操作を捨てずに担当者を持たせない", () => {
    const got = stamped(todos(), [
      { op: "update", node: "n3", evidence: ["r2"], assignee: "鈴木" },
      { op: "update", node: "n6", evidence: ["r2"], assigneeSpeaker: "相手 B" },
    ]);
    expect(got.dropped).toEqual([]);
    for (const id of ["n3", "n6"]) {
      expect(node(got.map, id)).not.toHaveProperty("assignee");
      expect(node(got.map, id)).not.toHaveProperty("assigneeSpeaker");
    }
  });

  it("更新で担当者が実際に変わったら、値の変わったノードとして changeOrder と touchedAt に載る", () => {
    const got = stamped(todos(), [{ op: "update", node: "n9", evidence: ["r1"], assigneeSpeaker: "相手 B" }], { round: 2, at: 77 }); // 根拠は既存、変わるのは担当者だけ
    expect(got.changeOrder).toEqual(["n9"]);
    expect(node(got.map, "n9").touchedAt).toBe(77);
    const named = stamped(todos(), [{ op: "update", node: "n7", evidence: ["r1"], assignee: "鈴木" }]);
    expect(named.changeOrder).toEqual(["n7"]);
  });

  it("担当者が変わらない更新は、changeOrder に載らない", () => {
    const same = stamped(todos(), [
      { op: "update", node: "n8", evidence: ["r1"], assignee: "田中" },
      { op: "update", node: "n7", evidence: ["r1"], assigneeSpeaker: "相手 A" },
      { op: "update", node: "n8", evidence: ["r1"], assigneeSpeaker: "相手 B" }, // 名前があるので無視される
    ]);
    expect(same.changeOrder).toEqual([]);
  });

  it("更新は出した人にも担当者にも関係のない欄（due・出した人）を変えない", () => {
    const { map } = stamped(base(), [{ op: "add", ref: "a", parent: "n2", kind: "TODO", text: "期限つき", evidence: ["r1"], due: "来週" }]); // n7
    const got = stamped(map, [{ op: "update", node: "n7", evidence: ["r2"], assigneeSpeaker: "相手 B" }]);
    expect(node(got.map, "n7")).toMatchObject({ due: "来週", assigneeSpeaker: "相手 B" });
  });
});

describe("applyOps: 人の欄を持たない種別", () => {
  it("議題・論点・課題・決定・要点には、proposer も assigneeSpeaker も付かない（add でも update でも）", () => {
    const got = stamped(base(), [
      { op: "add", ref: "a", parent: "n2", kind: "要点", text: "要点", evidence: ["r2"], proposer: "相手 A", assigneeSpeaker: "相手 A", assignee: "田中" },
      { op: "update", node: "n1", evidence: ["r2"], assigneeSpeaker: "相手 A", assignee: "田中" },
      { op: "update", node: "n2", evidence: ["r2"], assigneeSpeaker: "相手 A", assignee: "田中" },
      { op: "update", node: "n4", evidence: ["r2"], assigneeSpeaker: "相手 A", assignee: "田中" },
      { op: "update", node: "n6", evidence: ["r2"], assigneeSpeaker: "相手 A", assignee: "田中" },
    ]);
    expect(got.dropped).toEqual([]);
    for (const n of Object.values(got.map.nodes)) {
      if (n.kind === "案" || n.kind === "TODO") continue;
      expect(n, n.id).not.toHaveProperty("proposer");
      expect(n, n.id).not.toHaveProperty("assigneeSpeaker");
      expect(n, n.id).not.toHaveProperty("assignee");
    }
  });
});
