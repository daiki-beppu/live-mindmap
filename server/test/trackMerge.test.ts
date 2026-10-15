import { describe, expect, it } from "vitest";
import { createTrackMerge } from "../src/core/index.ts";

// Issue #1091: cli recorded --self。トラックごとに end の順に届く発言を、トラックをまたいで end の順の 1 本にまとめる規則（ADR 0003 の純粋な段）。
// 固定の待ち時間は持たない。片方のトラックが黙っている間は、そのトラックの次の要素が届くか drain（終わり）まで、もう一方を出さない。

type Item = { track: "相手" | "自分"; end: number; label: string };
const item = (track: Item["track"], end: number, label = `${track}${end}`): Item => ({ track, end, label });
const merge = () => createTrackMerge<Item>({ tracks: ["相手", "自分"], trackOf: (x) => x.track, timeOf: (x) => x.end });
const labels = (items: readonly Item[]) => items.map((x) => x.label);

describe("createTrackMerge（トラックをまたいで end の順にまとめる）", () => {
  it("片方のトラックだけが届いている間は何も出さない。もう一方の最初の要素が届くと、小さい end の方から出す", () => {
    const m = merge();
    expect(m.offer(item("相手", 2))).toEqual([]);
    expect(m.offer(item("相手", 6))).toEqual([]);

    // 自分 の 4 秒が届く: 相手 の 2 秒、自分 の 4 秒の順に出る。相手 の 6 秒は、自分 の次の要素を待つ
    expect(labels(m.offer(item("自分", 4)))).toEqual(["相手2", "自分4"]);
    expect(m.offer(item("自分", 7))).toEqual([item("相手", 6)]);
    expect(labels(m.drain())).toEqual(["自分7"]);
  });

  it("追い越された形（先の時刻の 相手 が先に届き、自分 が後から届く）でも、届いた順ではなく end の順に出る", () => {
    const m = merge();
    for (const end of [2, 6, 11]) expect(m.offer(item("相手", end))).toEqual([]);

    expect(labels(m.offer(item("自分", 4)))).toEqual(["相手2", "自分4"]);
    expect(labels(m.drain())).toEqual(["相手6", "相手11"]);
  });

  it("end が同じなら、先に届いた方を先に出す", () => {
    const first = merge();
    first.offer(item("相手", 5, "先"));
    expect(labels(first.offer(item("自分", 5, "後")))).toEqual(["先"]);
    expect(labels(first.drain())).toEqual(["後"]);

    const second = merge();
    second.offer(item("自分", 5, "先"));
    expect(labels(second.offer(item("相手", 5, "後")))).toEqual(["先"]);
    expect(labels(second.drain())).toEqual(["後"]);
  });

  it("同じトラックの中の順は変えない（同じ end の要素も届いた順）", () => {
    const m = merge();
    m.offer(item("相手", 3, "一"));
    m.offer(item("相手", 3, "二"));
    m.offer(item("相手", 4, "三"));
    const out = m.offer(item("自分", 10, "自"));

    expect(labels(out)).toEqual(["一", "二", "三"]);
    expect(labels(m.drain())).toEqual(["自"]);
  });

  it("drain は残りをすべて end の順に返し、以後は空。トラックが 1 本しか届いていなくても出し切る", () => {
    const m = merge();
    m.offer(item("自分", 8));
    m.offer(item("自分", 9));
    expect(labels(m.drain())).toEqual(["自分8", "自分9"]);
    expect(m.drain()).toEqual([]);
    expect(createTrackMerge<Item>({ tracks: ["相手", "自分"], trackOf: (x) => x.track, timeOf: (x) => x.end }).drain()).toEqual([]);
  });

  it("drain の後に届いた要素も、また同じ規則で扱う（状態は drain で壊れない）", () => {
    const m = merge();
    m.offer(item("相手", 1));
    m.drain();
    expect(m.offer(item("相手", 9))).toEqual([]);
    expect(labels(m.offer(item("自分", 12)))).toEqual(["相手9"]);
  });

  it("トラックごとに end が昇順であれば、どんな届き方でも、出力の全体（offer の戻り + drain）は end の昇順で、要素を落とさず重ねない", () => {
    const random = seededRandom(20261015);
    for (let trial = 0; trial < 200; trial++) {
      const arrivals = interleave(random, ascendingTrack(random, "相手"), ascendingTrack(random, "自分"));

      const m = merge();
      const out = [...arrivals.flatMap((x) => m.offer(x)), ...m.drain()];

      expect(out.map((x) => x.end)).toEqual(out.map((x) => x.end).toSorted((a, b) => a - b));
      expect(labels(out).toSorted()).toEqual(labels(arrivals).toSorted());
      for (const track of ["相手", "自分"] as const) {
        expect(labels(out.filter((x) => x.track === track))).toEqual(labels(arrivals.filter((x) => x.track === track)));
      }
    }
  });
});

// 決まった種から 0 以上 1 未満の数を順に返す（線形合同法。試すたびに同じ列になる）
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// 1 トラックの、end が昇順（同じ end も含む）の要素の列（0〜7 個）
function ascendingTrack(random: () => number, track: Item["track"]): Item[] {
  let end = 0;
  return Array.from({ length: Math.floor(random() * 8) }, (_, i) => item(track, (end += Math.floor(random() * 4)), `${track}-${i}`));
}

// 2 本の列を、それぞれの中の順を保ったまま、でたらめに混ぜた届き方にする
function interleave(random: () => number, theirs: Item[], mine: Item[]): Item[] {
  const rest: [Item[], Item[]] = [[...theirs], [...mine]];
  const arrivals: Item[] = [];
  for (let next = pickQueue(random, rest); next !== undefined; next = pickQueue(random, rest)) arrivals.push(next.shift()!);
  return arrivals;
}

function pickQueue(random: () => number, queues: readonly [Item[], Item[]]): Item[] | undefined {
  const open = queues.filter((q) => q.length > 0);
  if (open.length < 2) return open[0];
  return random() < 0.5 ? queues[0] : queues[1];
}
