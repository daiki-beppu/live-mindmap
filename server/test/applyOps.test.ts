import { describe, expect, it } from "vitest";
import { applyOps, emptyMap, type MeetingMap, type Op } from "../src/core/index.ts";

const known = new Set(["r1", "r2", "r3", "r4"]);
const stamped = (map: MeetingMap, ops: Op[], stamp = { round: 2, at: 10 }) => applyOps(map, ops, known, stamp);

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
  ], known, { round: 1, at: 0 }).map;

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
