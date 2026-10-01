import { describe, expect, it } from "vitest";
import type { ChangeEntry, Snapshot } from "../../server/src/core/index.ts";
import { changedNodeIds, formatClock } from "../src/changes.ts";

const entry = (round: number, node: string, change: ChangeEntry["change"] = "追加", at = round * 10): ChangeEntry => ({
  round,
  at,
  change,
  node,
  kind: "議題",
  text: node,
});

const snapshot = (round: number, changes: ChangeEntry[]): Snapshot => ({
  nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }],
  round,
  changes,
  remarks: [],
});

describe("changedNodeIds: 赤い枠を付けるノード", () => {
  it("スナップショットを順に受けると、前回の反映のノードから今回の反映のノードだけに入れ替わる", () => {
    const first = [entry(1, "n1"), entry(1, "n2")];
    const second = [...first, entry(2, "n2", "更新"), entry(2, "n3")];

    expect(changedNodeIds(snapshot(1, first))).toEqual(new Set(["n1", "n2"]));
    // 反映 2 では、n1 の枠は消え、n2（再び変わった）と n3 だけになる。積み上がった履歴の古い記録は枠にならない
    expect(changedNodeIds(snapshot(2, second))).toEqual(new Set(["n2", "n3"]));
  });

  it("何も変わらなかった反映（round だけ進む）では、前回の枠がすべて消える", () => {
    const changes = [entry(1, "n1")];
    expect(changedNodeIds(snapshot(1, changes))).toEqual(new Set(["n1"]));
    expect(changedNodeIds(snapshot(2, changes))).toEqual(new Set());
  });

  it("同じノードに複数の変化があっても 1 つ。記録がなければ空", () => {
    expect(changedNodeIds(snapshot(1, [entry(1, "n3", "更新"), entry(1, "n3", "却下")]))).toEqual(new Set(["n3"]));
    expect(changedNodeIds(snapshot(0, []))).toEqual(new Set());
  });

  it("つなぎ直して届いた同じスナップショットでも、同じ結果になる", () => {
    const s = snapshot(2, [entry(1, "n1"), entry(2, "n2")]);
    expect(changedNodeIds(s)).toEqual(changedNodeIds(JSON.parse(JSON.stringify(s))));
  });
});

describe("formatClock: 会議の中の秒を mm:ss にする", () => {
  it("秒は切り捨てて 2 桁にそろえる", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(19.2)).toBe("00:19");
    expect(formatClock(28)).toBe("00:28");
    expect(formatClock(65)).toBe("01:05");
  });

  it("60 分を超えても、分は 60 以上のまま出す（エクスポートの Markdown と同じ）", () => {
    expect(formatClock(3725)).toBe("62:05");
  });
});
