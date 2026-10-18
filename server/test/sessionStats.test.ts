import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { formatRow, overlapRatio, parseLog, recordingLog, sessionStats, type LogLine } from "../bench/sessionStats.ts";
import { fakeSpawner } from "./fixtures/fakeSpawner.ts";

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

  // Issue #863: helper が相手のタップに音声が届かないと流した回数（log.jsonl の tap-silent の行）
  it.effect("tap-silent の行を数える。無ければ 0、他の intake の数・発言には混ざらない", () => Effect.gen(function* () {
    const lines = [
      JSON.stringify({ type: "tap-silent", start: 10.5 }),
      remark("r1", "相手", 0, 2),
      JSON.stringify({ type: "intake-restarted", trigger: "auto" }),
      JSON.stringify({ type: "tap-silent", start: 12 }),
    ];
    const s = sessionStats(yield* parseLog(lines.join("\n")));
    expect(s.tapSilent).toBe(2);
    expect(s.intake).toMatchObject({ stopped: 0, restarted: 1, gaveUp: 0 });
    expect(s.tracks.相手.remarks).toBe(1);
    const none = sessionStats(yield* parseLog(remark("r1", "相手", 0, 2)));
    expect(none.tapSilent).toBe(0);
  }));

  it.effect("formatRow の先頭の行に tap-silent の回数が出る。回数が違えば出力も違う", () => Effect.gen(function* () {
    const two = sessionStats(yield* parseLog([JSON.stringify({ type: "tap-silent", start: 1 }), JSON.stringify({ type: "tap-silent", start: 2 })].join("\n")));
    const zero = sessionStats(yield* parseLog(""));
    const headTwo = formatRow("s", two, null)[0]!;
    const headZero = formatRow("s", zero, null)[0]!;
    expect(headTwo).toMatch(/無音\D*2/);
    expect(headZero).toMatch(/無音\D*0/);
    expect(headTwo).not.toBe(headZero);
  }));
});

describe("1 行ずつの数え方（型ごとの集計）", () => {
  it("すべての型を数え、remark の無い remark 行・未知の型は飛ばし、逆向きの区間は長さ 0、end は最大を取る。入力は書き換えない", () => {
    const events: LogLine[] = [
      { type: "remark" },
      { type: "remark", remark: { track: "相手", start: 0, end: 4 } },
      { type: "remark", remark: { track: "相手", start: 2, end: 6 } },
      { type: "remark", remark: { track: "自分", start: 10, end: 9 } },
      { type: "diff" },
      { type: "diff", ops: [{}, {}, {}], error: "boom" },
      { type: "diff", ops: [], error: "" },
      { type: "unknown" },
      { type: "intake-stopped" },
      { type: "intake-stopped" },
      { type: "intake-restarted" },
      { type: "intake-gave-up" },
      { type: "intake-gave-up" },
      { type: "intake-gave-up" },
      { type: "tap-silent" },
      { type: "tap-silent" },
    ];
    const before = JSON.stringify(events);
    const s = sessionStats(events);
    expect(s.tracks.相手.remarks).toBe(2);
    expect(s.tracks.相手.duration).toBe(8);
    expect(s.tracks.相手.overlap).toBeCloseTo(2 / 6);
    expect(s.tracks.自分).toEqual({ remarks: 1, duration: 0, overlap: 0 });
    expect({ lastEnd: s.lastEnd, diffs: s.diffs, diffErrors: s.diffErrors, ops: s.ops, intake: s.intake, tapSilent: s.tapSilent }).toEqual({
      lastEnd: 9, diffs: 3, diffErrors: 1, ops: 3, intake: { stopped: 2, restarted: 1, gaveUp: 3 }, tapSilent: 2,
    });
    expect(JSON.stringify(events)).toBe(before);
  });

  it("ログが空なら、すべて 0 の集計になる", () => {
    expect(sessionStats([])).toEqual({
      tracks: { 相手: { remarks: 0, duration: 0, overlap: 0 }, 自分: { remarks: 0, duration: 0, overlap: 0 } },
      lastEnd: 0, diffs: 0, diffErrors: 0, ops: 0, intake: { stopped: 0, restarted: 0, gaveUp: 0 }, tapSilent: 0,
    });
  });
});

describe("録音の読み取り（偽の ChildProcessSpawner）", () => {
  it.effect("ffmpeg を起動できなければ、失敗にせず空の出力にする", () => Effect.gen(function* () {
    const spawner = fakeSpawner({ spawnFailure: "NotFound" });
    const log = yield* recordingLog("/会議/相手.m4a").pipe(Effect.provide(spawner.layer));
    expect(log).toBe("");
    expect(spawner.commands.map(({ command }) => command)).toEqual(["ffmpeg"]);
  }));

  it.effect("空の出力で音量が取れなかった録音は、録音の列で「読めない」と出す", () => Effect.gen(function* () {
    const s = sessionStats(yield* parseLog(remark("r1", "相手", 0, 2)));
    const audio = { 相手: { files: 1, seconds: 0, meanDb: null }, 自分: { files: 0, seconds: 0, meanDb: null } };
    expect(formatRow("s", s, audio).join("\n")).toContain("録音 1 本・読めない");
  }));
});
