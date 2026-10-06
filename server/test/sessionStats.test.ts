import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRow, overlapRatio, parseLog, sessionDirs, sessionStats } from "../bench/sessionStats.ts";

const remark = (id: string, track: "相手" | "自分", start: number, end: number) =>
  JSON.stringify({ type: "remark", remark: { id, track, start, end, text: "本文" } });

describe("セッションの数だけの集計", () => {
  it("相手と自分を別々に数える（ロケールによっては uniq -c が 2 つを同じ行にまとめる）", () => {
    const s = sessionStats(parseLog([remark("r1", "相手", 0, 2), remark("r2", "自分", 2, 3), remark("r3", "相手", 3, 6)].join("\n")));
    expect(s.tracks.相手).toMatchObject({ remarks: 2, duration: 5 });
    expect(s.tracks.自分).toMatchObject({ remarks: 1, duration: 1 });
    expect(s.lastEnd).toBe(6);
  });

  it("重なりは、発言のある時間のうち 2 件以上が重なる時間の割合。接しているだけは重ならない", () => {
    expect(overlapRatio([{ start: 0, end: 2 }, { start: 2, end: 4 }])).toBe(0);
    expect(overlapRatio([{ start: 0, end: 4 }, { start: 2, end: 6 }])).toBeCloseTo(2 / 6);
    expect(overlapRatio([])).toBe(0);
  });

  it("差分更新・操作・取り込みの途切れを数え、壊れた行は飛ばす", () => {
    const lines = [
      JSON.stringify({ type: "start", title: "t" }),
      JSON.stringify({ type: "diff", ops: [{}, {}], dropped: [] }),
      JSON.stringify({ type: "diff", ops: [], dropped: [], error: "x" }),
      JSON.stringify({ type: "intake-stopped", code: null, signal: "SIGKILL", stderrTail: [] }),
      JSON.stringify({ type: "intake-restarted", trigger: "auto" }),
      JSON.stringify({ type: "intake-gave-up" }),
      '{"type":"remark","rem',
    ];
    const s = sessionStats(parseLog(lines.join("\n")));
    expect(s).toMatchObject({ diffs: 2, diffErrors: 1, ops: 2, intake: { stopped: 1, restarted: 1, gaveUp: 1 } });
  });

  it("並べたフォルダを渡すと、log.jsonl のあるセッションを全部拾う", () => {
    const root = mkdtempSync(join(tmpdir(), "stats-"));
    for (const name of ["b", "a"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "log.jsonl"), "");
    }
    mkdirSync(join(root, "empty"));
    expect(sessionDirs(root)).toEqual([join(root, "a"), join(root, "b")]);
    expect(sessionDirs(join(root, "a"))).toEqual([join(root, "a")]);
  });

  it("出力に発言の本文を含めない", () => {
    const s = sessionStats(parseLog(remark("r1", "相手", 0, 2)));
    expect(formatRow("s", s, null).join("\n")).not.toContain("本文");
  });
});
