import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { formatRow, overlapRatio, parseLog, sessionStats } from "../bench/sessionStats.ts";

const remark = (id: string, track: "相手" | "自分", start: number, end: number) =>
  JSON.stringify({ type: "remark", remark: { id, track, start, end, text: "本文" } });

describe("セッションの数だけの集計", () => {
  it.effect("相手と自分を別々に数える（ロケールによっては uniq -c が 2 つを同じ行にまとめる）", () => Effect.gen(function* () {
    const s = sessionStats(yield* parseLog([remark("r1", "相手", 0, 2), remark("r2", "自分", 2, 3), remark("r3", "相手", 3, 6)].join("\n")));
    expect(s.tracks.相手).toMatchObject({ remarks: 2, duration: 5 });
    expect(s.tracks.自分).toMatchObject({ remarks: 1, duration: 1 });
    expect(s.lastEnd).toBe(6);
  }));

  it("重なりは、発言のある時間のうち 2 件以上が重なる時間の割合。接しているだけは重ならない", () => {
    expect(overlapRatio([{ start: 0, end: 2 }, { start: 2, end: 4 }])).toBe(0);
    expect(overlapRatio([{ start: 0, end: 4 }, { start: 2, end: 6 }])).toBeCloseTo(2 / 6);
    expect(overlapRatio([])).toBe(0);
  });

  it.effect("差分更新・操作・取り込みの途切れを数え、壊れた行は飛ばす", () => Effect.gen(function* () {
    const lines = [
      JSON.stringify({ type: "start", title: "t" }),
      JSON.stringify({ type: "diff", ops: [{}, {}], dropped: [] }),
      JSON.stringify({ type: "diff", ops: [], dropped: [], error: "x" }),
      JSON.stringify({ type: "intake-stopped", code: null, signal: "SIGKILL", stderrTail: [] }),
      JSON.stringify({ type: "intake-restarted", trigger: "auto" }),
      JSON.stringify({ type: "intake-gave-up" }),
      '{"type":"remark","rem',
    ];
    const s = sessionStats(yield* parseLog(lines.join("\n")));
    expect(s).toMatchObject({ diffs: 2, diffErrors: 1, ops: 2, intake: { stopped: 1, restarted: 1, gaveUp: 1 } });
  }));

  it.effect("合わない行（JSON だがオブジェクトでない・type が無い・track が相手/自分でない発言）は、壊れた行と同じく数えずに飛ばす", () => Effect.gen(function* () {
    const lines = [
      "42",
      "null",
      JSON.stringify({ remark: { track: "相手", start: 0, end: 1 } }),
      JSON.stringify({ type: "remark", remark: { id: "r9", track: "第三者", start: 0, end: 9, text: "本文" } }),
      remark("r1", "自分", 0, 2),
    ];
    const s = sessionStats(yield* parseLog(lines.join("\n")));
    expect(s.tracks.自分).toMatchObject({ remarks: 1, duration: 2 });
    expect(s.tracks.相手.remarks).toBe(0);
    expect(s.lastEnd).toBe(2);
  }));

  it.effect("出力に発言の本文を含めない", () => Effect.gen(function* () {
    const s = sessionStats(yield* parseLog(remark("r1", "相手", 0, 2)));
    expect(formatRow("s", s, null).join("\n")).not.toContain("本文");
  }));
});
