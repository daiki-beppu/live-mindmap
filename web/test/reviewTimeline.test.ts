import { describe, expect, it } from "vitest";
import { reviewSnapshot } from "../../server/src/core/index.ts";
import { buildReviewTimeline, formatHms, snapshotAt, speakingAt, topicNameOf } from "../src/reviewTimeline.ts";

// 見返しの時間軸（純粋なモジュール）。ログ（log.jsonl の行）の配列だけを入れて確かめる。
// 時刻の軸は発言の end（会議の中の秒）で、ログの at は使わない（at はわざと逆順・無関係な値にしてある）。

const remark = (id: string, track: "自分" | "相手", start: number, end: number, text: string) => ({
  at: `2099-01-01T00:00:${String(90 - end).padStart(2, "0")}.000Z`,
  type: "remark",
  remark: { id, track, start, end, text },
});
const add = (ref: string, text: string, evidence: string[]) => ({ op: "add", ref, parent: "root", kind: "議題", text, evidence });
const diff = (fresh: string[], ops: unknown[], error?: string) => ({
  at: "2000-01-01T00:00:00.000Z",
  type: "diff",
  input: { recent: [], fresh, nodeCount: 0 },
  ops,
  dropped: [],
  ...(error !== undefined ? { error } : {}),
});

// 反映 1: 時刻 10（r1・r2）、反映 2: 時刻 30（r3・r4）。r5（end 40）は未反映。取り込みの行は知らない種類
const events = [
  { at: "a", type: "start", title: "定例" },
  remark("r1", "相手", 0, 5, "採用の話をします。"),
  remark("r2", "自分", 5, 10, "はい。"),
  diff(["r1", "r2"], [add("t1", "採用", ["r1"])]),
  { at: "b", type: "intake", note: "途切れ" },
  remark("r3", "相手", 12, 20, "予算です。"),
  remark("r4", "自分", 20, 30, "了解。"),
  diff(["r3", "r4"], [add("t2", "予算", ["r3"])]),
  remark("r5", "相手", 32, 40, "最後の発言。"),
];

describe("buildReviewTimeline（反映の一覧・会議の長さ）", () => {
  it("反映は 1 からの通し番号と、fresh の発言の end の最大。会議の長さは発言の end の最大（未反映の発言も数える）", () => {
    const tl = buildReviewTimeline(events);
    expect(tl.reflections).toMatchObject([{ round: 1, at: 10 }, { round: 2, at: 30 }]);
    expect(tl.duration).toBe(40);
    expect(tl.reflectionTimes).toEqual([10, 30]);
  });

  it("error のある diff と、知らない種類の行は反映に数えない。番号も進めない", () => {
    const log = [
      { at: "a", type: "start", title: "定例" },
      remark("r1", "相手", 0, 5, "あ。"),
      diff(["r1"], [], "失敗"),
      { at: "b", type: "intake", note: "x" },
      remark("r2", "自分", 5, 8, "い。"),
      diff(["r2"], [add("t1", "採用", ["r2"])]),
    ];
    const tl = buildReviewTimeline(log);
    expect(tl.reflections).toMatchObject([{ round: 1, at: 8 }]);
    expect(tl.reflectionTimes).toEqual([8]);
  });

  it("会議の長さは、反映の時刻より後ろの発言（end が小さい発言を含む並び）でも、発言の end の最大", () => {
    const log = [
      { at: "a", type: "start", title: "定例" },
      remark("r1", "相手", 0, 50, "長い。"),
      diff(["r1"], [add("t1", "採用", ["r1"])]),
      remark("r2", "自分", 50, 20, "短い。"),
    ];
    expect(buildReviewTimeline(log).duration).toBe(50);
  });

  it("ログの at は使わない（発言が無く反映もなければ長さは 0）", () => {
    expect(buildReviewTimeline([{ at: "2099-12-31T23:59:59.000Z", type: "start", title: "定例" }]).duration).toBe(0);
  });

  it("反映の時刻は重複を除いて昇順（反映の時刻が逆転するログでも）", () => {
    const log = [
      { at: "a", type: "start", title: "定例" },
      remark("r1", "相手", 0, 10, "a。"),
      remark("r2", "自分", 10, 30, "b。"),
      remark("r3", "相手", 30, 30, "c。"),
      diff(["r2"], [add("t1", "採用", ["r2"])]),
      diff(["r1"], [add("t2", "予算", ["r1"])]),
      diff(["r3"], [add("t3", "人事", ["r3"])]),
    ];
    const tl = buildReviewTimeline(log);
    expect(tl.reflections.map((r) => r.at)).toEqual([30, 10, 30]);
    expect(tl.reflectionTimes).toEqual([10, 30]);
  });
});

describe("snapshotAt（時刻 t のスナップショット）", () => {
  const tl = buildReviewTimeline(events);

  it("t が反映の時刻のちょうど手前では、その反映を含めず、end が t より後の発言も含めない", () => {
    const s = snapshotAt(tl, 9.9);
    expect(s.round).toBe(0);
    expect(s.nodes.map((n) => n.text)).toEqual(["定例"]);
    expect(s.changes).toEqual([]);
    expect(s.currentTopic).toBeUndefined();
    expect(s.now).toBe(5); // r2（end 10）は含めない
  });

  it("t が反映の時刻ちょうどなら、その反映を含む。変わったことは t までの反映の分だけ", () => {
    const s = snapshotAt(tl, 10);
    expect(s.round).toBe(1);
    expect(s.nodes.map((n) => n.text)).toEqual(["定例", "採用"]);
    expect(s.changes.length).toBeGreaterThan(0);
    expect(s.changes.every((c) => c.round === 1 && c.at === 10)).toBe(true);
    expect(topicNameOf(s)).toBe("採用");
    expect(s.remarks.map((r) => r.id)).toEqual(["r1"]);
    expect(s.now).toBe(10);
  });

  it("反映の間の t では、前の反映までの状態で、end が t 以下の発言だけが now・根拠に出る", () => {
    const s = snapshotAt(tl, 25);
    expect(s.round).toBe(1);
    expect(s.nodes.map((n) => n.text)).toEqual(["定例", "採用"]);
    expect(s.now).toBe(20); // r3 は含む、r4（end 30）は含めない
    expect(s.remarks.map((r) => r.id)).toEqual(["r1"]);
  });

  it("t が次の反映の時刻に着くと、今の議題とマップがその反映のものになる", () => {
    const s = snapshotAt(tl, 30);
    expect(s.round).toBe(2);
    expect(s.nodes.map((n) => n.text)).toEqual(["定例", "採用", "予算"]);
    expect(topicNameOf(s)).toBe("予算");
    expect(s.changes.map((c) => c.round)).toContain(1);
    expect(s.changes.map((c) => c.round)).toContain(2);
  });

  it("t ＝ 会議の長さでは、reviewSnapshot と同じになる", () => {
    expect(snapshotAt(tl, tl.duration)).toEqual(reviewSnapshot(events));
  });

  it("元のログの出来事を書き換えない", () => {
    const before = JSON.stringify(events);
    snapshotAt(tl, 0);
    snapshotAt(tl, 10);
    snapshotAt(tl, tl.duration);
    expect(JSON.stringify(events)).toBe(before);
  });

  it("同じ時間軸で t を 後ろ → 前 → 後ろ と動かしても、それぞれその時点の内容になり、旧状態が残らない", () => {
    const first = snapshotAt(tl, 30);
    const back = snapshotAt(tl, 10);
    const again = snapshotAt(tl, 30);
    expect(back.nodes.map((n) => n.text)).toEqual(["定例", "採用"]);
    expect(back.changes.some((c) => c.round === 2)).toBe(false);
    expect(again).toEqual(first);
    expect(again.round).toBe(2);
  });

  it("同じ区間（同じ反映・同じ発言の集合）の t では同じオブジェクトを返し、区間が変わると別のオブジェクトを返す", () => {
    expect(snapshotAt(tl, 10)).toBe(snapshotAt(tl, 15));
    expect(snapshotAt(tl, 10)).not.toBe(snapshotAt(tl, 20)); // r3 が入る
    expect(snapshotAt(tl, 20)).toBe(snapshotAt(tl, 21));
    expect(snapshotAt(tl, 21)).not.toBe(snapshotAt(tl, 30)); // 反映 2
  });

  it("反映の時刻が番号の順に並ばないログでも、t より後の反映と、それより後ろの反映は出さない", () => {
    // 反映 1 は時刻 30、反映 2 は時刻 10（逆転）。t = 20 では、反映 1 が t より後なので、反映 2 も出さない
    const log = [
      { at: "a", type: "start", title: "定例" },
      remark("r1", "相手", 0, 10, "a。"),
      remark("r2", "自分", 10, 30, "b。"),
      diff(["r2"], [add("t1", "採用", ["r2"])]),
      diff(["r1"], [add("t2", "予算", ["r1"])]),
    ];
    const rev = buildReviewTimeline(log);
    const mid = snapshotAt(rev, 20);
    expect(mid.round).toBe(0);
    expect(mid.nodes.map((n) => n.text)).toEqual(["定例"]);
    expect(mid.changes).toEqual([]);
    const end = snapshotAt(rev, 30);
    expect(end.round).toBe(2);
    expect(end).toEqual(reviewSnapshot(log));
  });

  it("error のある diff の fresh に、end が t より後の発言が入っていても throw せず、マップを変えない", () => {
    const log = [
      { at: "a", type: "start", title: "定例" },
      remark("r1", "相手", 0, 5, "あ。"),
      diff(["r1"], [add("t1", "採用", ["r1"])]),
      remark("r2", "自分", 5, 10, "い。"),
      remark("r3", "相手", 10, 20, "う。"),
      diff(["r2", "r3"], [], "失敗"),
    ];
    const t = buildReviewTimeline(log);
    const s = snapshotAt(t, 7);
    expect(s.round).toBe(1);
    expect(s.nodes.map((n) => n.text)).toEqual(["定例", "採用"]);
    expect(snapshotAt(t, t.duration)).toEqual(reviewSnapshot(log));
  });
});

describe("speakingAt（字幕）", () => {
  const tl = buildReviewTimeline(events);

  it("トラックごとに、end が t 以下で最も遅い発言の本文を、end から 8 秒未満の間だけ出す（end ちょうどは出す）", () => {
    expect(speakingAt(tl, 5)).toEqual({ 相手: "採用の話をします。", 自分: "" });
    expect(speakingAt(tl, 12.9)).toEqual({ 相手: "採用の話をします。", 自分: "はい。" }); // 相手 +7.9、自分 +2.9
  });

  it("t − end が 8 秒ちょうどなら空文字（消える）", () => {
    expect(speakingAt(tl, 13)).toEqual({ 相手: "", 自分: "はい。" });
    expect(speakingAt(tl, 18)).toEqual({ 相手: "", 自分: "" });
  });

  it("end が t より後の発言は選ばない。t に着く前は両方空", () => {
    expect(speakingAt(tl, 4.9)).toEqual({ 相手: "", 自分: "" });
    expect(speakingAt(tl, 19.9)).toEqual({ 相手: "", 自分: "" }); // r3（end 20）はまだ選ばない
  });

  it("トラックごとに独立していて、新しい発言に切り替わる。直近の発言が古ければ、さらに前の発言へは戻らない", () => {
    expect(speakingAt(tl, 20)).toEqual({ 相手: "予算です。", 自分: "" }); // 自分 r2 は +10 で消えている、r4 は未到達
    expect(speakingAt(tl, 30)).toEqual({ 相手: "", 自分: "了解。" }); // 相手 r3 は +10
    expect(speakingAt(tl, 40)).toEqual({ 相手: "最後の発言。", 自分: "" });
  });
});

describe("formatHms", () => {
  it("秒を切り捨てて h:mm:ss にする", () => {
    expect(formatHms(0)).toBe("0:00:00");
    expect(formatHms(65)).toBe("0:01:05");
    expect(formatHms(3725.9)).toBe("1:02:05");
  });
});
