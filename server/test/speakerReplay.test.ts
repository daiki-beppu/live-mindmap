import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { replayLog, replayOffline } from "../bench/speakerReplay.ts";
import {
  fillLog, liveLog, minRunLog, offlineLog, numbered, offlineRestartLog, overlapLog, remarkLine, restartLog, segLine, settledLine, startLine, waitLog,
  type Line,
} from "./speakerReplayFixtures.ts";

type Piece = [speaker: string | undefined, start: number, end: number];
const pieces = (result: { remarks: ReadonlyArray<{ speaker?: string; start: number; end: number }> }): Piece[] =>
  result.remarks.map((r) => [r.speaker, r.start, r.end]);

const RULES = { longestOverlap: false, fillUnassigned: false, minRun: false, waitLimit: false } as const;
type RuleName = keyof typeof RULES;
const only = (name: RuleName) => ({ [name]: false });

describe("log.jsonl の流し直し（ライブで決まった話者の再現）", () => {
  it.effect("2 人に切る・時間切れで話者なし・自分・混入・起動し直し後のつなぎ直しを含む log を旗なしで流すと、各 remark 行の話者がライブで決まった話者と同じになる", () => Effect.gen(function* () {
    const { lines, liveSpeakers } = yield* liveLog;
    expect(new Set(liveSpeakers.map(([, speaker]) => speaker))).toEqual(new Set(["相手 A", "相手 B", undefined, "自分"]));

    const result = yield* replayLog(numbered(lines));

    expect(result.remarks.map((r) => [r.source, r.speaker])).toEqual(liveSpeakers);
  }));

  it.effect("ライブで残った speaker-mixed・intake-restarted・重心の判定を、混入・つなぎ直し・起動し直しの記録として出す", () => Effect.gen(function* () {
    const { lines } = yield* liveLog;

    const result = yield* replayLog(numbered(lines));

    expect(result.labels).toEqual(["相手 A", "相手 B"]);
    expect(result.mixed).toHaveLength(1);
    expect(result.mixed[0]).toMatchObject({ slot: 1, label: "相手 B" });
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({ slot: 2, result: "linked", label: "相手 A" });
    expect(result.restarts).toHaveLength(1);
    expect(result.restarts[0]).toMatchObject({ source: "log" });
  }));

  it.effect("発言の行は元の remark.id を source にし、時刻と話者は持つが本文・raw・words を持たない", () => Effect.gen(function* () {
    const { lines } = yield* liveLog;

    const result = yield* replayLog(numbered(lines));

    for (const r of result.remarks) {
      expect(Object.keys(r).filter((key) => !["source", "track", "start", "end", "speaker"].includes(key))).toEqual([]);
    }
    expect(result.remarks[0]).toMatchObject({ source: "r1", track: "相手", start: 0, end: 2, speaker: "相手 A" });
  }));

  it.effect("remark・話者のイベント・intake-restarted 以外の行（start・diff など）は読み飛ばす", () => Effect.gen(function* () {
    const { lines, liveSpeakers } = yield* liveLog;
    const extra: Line[] = [startLine(0), { at: "2026-01-01T00:00:00.000Z", type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [] }, ...lines];

    const result = yield* replayLog(numbered(extra));

    expect(result.remarks.map((r) => [r.source, r.speaker])).toEqual(liveSpeakers);
  }));

  it.effect("壊れた remark 行は InvalidInputFile で失敗し、理由に行番号を持ち、本文を含まない", () => Effect.gen(function* () {
    const secret = "SECRETBODYTEXT";
    const broken = { at: "2026-01-01T00:00:01.000Z", type: "remark", remark: { id: "r1", track: "invalid", start: 0, end: 1, text: secret } };

    const error = yield* Effect.flip(replayLog(numbered([startLine(0), broken])));

    expect(error).toMatchObject({ _tag: "InvalidInputFile" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String((error as { reason?: string }).reason)).toContain("2 行目");
  }));
});

describe("log.jsonl の流し直しの時計", () => {
  it.effect("log の混入とつなぎ直しには、最初の入力からの経過秒を付ける", () => Effect.gen(function* () {
    const lines: Line[] = [
      ...restartLog,
      { ...startLine(19), type: "speaker-mixed", track: "相手", slot: 2, start: 90 },
    ];

    const result = yield* replayLog(numbered(lines), { restartAt: 10 });

    expect(result.links).toEqual([
      { at: 14, slot: 2, result: "linked", label: "相手 A" },
      { at: 17, slot: 3, result: "new" },
    ]);
    expect(result.mixed).toEqual([{ at: 19, slot: 2, label: "相手 A" }]);
  }));

  it.effect("話者なしで出た発言が続いても、2 件目以降も時間切れで話者なしになる（進めた時計を次の入力に引き継ぐ）", () => Effect.gen(function* () {
    const lines: Line[] = [
      remarkLine(1, "r1", "相手", 0, 1, "あ"), remarkLine(2, "r2", "相手", 1, 2, "い"), remarkLine(3, "r3", "相手", 2, 3, "う"),
      segLine(4, 0, 0, 3), settledLine(5, 3),
    ];

    const result = yield* replayLog(numbered(lines));

    expect(result.remarks.map((r) => [r.source, r.speaker])).toEqual([["r1", undefined], ["r2", undefined], ["r3", undefined]]);
  }));
});

describe("話者を持たない古い log", () => {
  const oldLog: Line[] = [
    startLine(0),
    remarkLine(1, "r1", "相手", 0, 2, "もしもし"),
    remarkLine(2, "r2", "自分", 3, 4, "はい"),
    remarkLine(3, "r3", "相手", 5, 6, "どうも"),
  ];

  it.effect.each([
    { name: "旗なし", options: {} },
    { name: "5 秒の待ちを外す", options: { rules: only("waitLimit") } },
  ])("$name でも失敗せず、相手の発言は話者なし・自分の発言は自分になる（保留が出ないまま終わらない）", ({ options }) => Effect.gen(function* () {
    const result = yield* replayLog(numbered(oldLog), options);

    expect(result.remarks.map((r) => [r.source, r.track, r.speaker] as const).sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["r1", "相手", undefined],
      ["r2", "自分", "自分"],
      ["r3", "相手", undefined],
    ]);
    expect(result.labels).toEqual([]);
  }));
});

describe("規則を外す旗（1 つずつ。旗なしと結果が変わる fixture）", () => {
  const A = "相手 A";
  const B = "相手 B";
  const cases: ReadonlyArray<{ rule: RuleName; log: Line[]; on: Piece[]; off: Piece[] }> = [
    { rule: "longestOverlap", log: overlapLog, on: [[A, 0, 1], [B, 2, 3], [A, 10, 14]], off: [[A, 0, 1], [B, 2, 3], [B, 10, 14]] },
    { rule: "fillUnassigned", log: fillLog, on: [[A, 0, 3], [B, 3, 4]], off: [[A, 0, 2], [undefined, 2, 3], [B, 3, 4]] },
    { rule: "minRun", log: minRunLog, on: [[A, 0, 6]], off: [[A, 0, 2.5], [B, 2.5, 2.75], [A, 2.75, 6]] },
    { rule: "waitLimit", log: waitLog, on: [[undefined, 0, 2]], off: [[A, 0, 2]] },
  ];

  it.effect.each(cases)("$rule: 旗なしと、その規則だけを外した結果が違う", ({ rule, log, on, off }) => Effect.gen(function* () {
    expect(pieces(yield* replayLog(numbered(log)))).toEqual(on);
    expect(pieces(yield* replayLog(numbered(log), { rules: only(rule) }))).toEqual(off);
  }));

  const others = cases.flatMap((c) => cases.filter((o) => o.rule !== c.rule).map((o) => ({ fixture: c, other: o.rule })));
  it.effect.each(others)("$fixture.rule の fixture は、別の規則（$other）を外しても結果が変わらない（旗はほかの規則まで外さない）", ({ fixture, other }) => Effect.gen(function* () {
    expect(pieces(yield* replayLog(numbered(fixture.log), { rules: only(other) }))).toEqual(fixture.on);
  }));

  it.effect("4 つの規則をすべて外しても失敗せず、重なりは先に始まる枠の最も単純な決め方になる", () => Effect.gen(function* () {
    const result = yield* replayLog(numbered(overlapLog), { rules: RULES });

    expect(pieces(result)).toEqual([["相手 A", 0, 1], ["相手 B", 2, 3], ["相手 B", 10, 14]]);
  }));
});

describe("起動し直しの旗（--restart-at。同じ話者の段の上で、前後を一続きに観測する）", () => {
  it.effect("指定した時刻以降の発言は、重心の照らし合わせ前は話者なし、近い重心が届いた後は前のラベルにつながり、遠い重心は新しいラベルになる", () => Effect.gen(function* () {
    const result = yield* replayLog(numbered(restartLog), { restartAt: 10 });

    expect(result.remarks.map((r) => [r.source, r.speaker])).toEqual([
      ["r1", "相手 A"], ["r2", "相手 B"],
      ["r3", undefined],
      ["r4", "相手 A"],
      ["r5", "相手 C"],
    ]);
    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toMatchObject({ slot: 2, result: "linked", label: "相手 A" });
    expect(result.links[1]).toMatchObject({ slot: 3, result: "new" });
    expect(result.restarts).toHaveLength(1);
    expect(result.restarts[0]).toMatchObject({ source: "flag" });
    expect(result.restarts[0]!.at).toBeGreaterThanOrEqual(10);
    expect(result.restarts[0]!.at).toBeLessThanOrEqual(12);
    expect(result.labels).toEqual(["相手 A", "相手 B", "相手 C"]);
  }));

  it.effect("旗なしでは起動し直さず（記録なし）、枠 2・3 に新しいラベルが振られる。指定した時刻より前の発言は旗の有無で変わらない", () => Effect.gen(function* () {
    const plain = yield* replayLog(numbered(restartLog));
    const restarted = yield* replayLog(numbered(restartLog), { restartAt: 10 });

    expect(plain.remarks.map((r) => [r.source, r.speaker])).toEqual([
      ["r1", "相手 A"], ["r2", "相手 B"], ["r3", "相手 C"], ["r4", "相手 C"], ["r5", "相手 D"],
    ]);
    expect(plain.links).toEqual([]);
    expect(plain.restarts).toEqual([]);
    expect(restarted.remarks.slice(0, 2)).toEqual(plain.remarks.slice(0, 2));
  }));

  it.effect("最後の入力より後の時刻を指定すると、起動し直さず旗なしと同じ結果になる", () => Effect.gen(function* () {
    const result = yield* replayLog(numbered(restartLog), { restartAt: 1000 });

    expect(result).toEqual(yield* replayLog(numbered(restartLog)));
  }));
});

describe("オフライン出力の流し直し（arrival の順に settler と話者の段を通す）", () => {
  it.effect("混入とつなぎ直しに、音声時刻や相対秒ではなく発生元入力の arrival を付ける", () => Effect.gen(function* () {
    const lines: Line[] = [
      { arrival: 119, type: "speaker-mixed", track: "相手", slot: 2, start: 99 },
      ...offlineRestartLog.map((line) => ({ ...line, arrival: Number(line.arrival) + 100 })).toSorted((a, b) => b.arrival - a.arrival),
      { arrival: 90, type: "origin", hostTime: "123456" },
      { arrival: 121, type: "speaker-mixed", track: "相手", slot: 3, start: 200 },
    ];

    const result = yield* replayOffline(numbered(lines), { restartAt: 20 });

    expect(result.restarts).toEqual([{ at: 22, source: "flag" }]);
    expect(result.links).toEqual([{ at: 114, slot: 2, result: "linked", label: "相手 A" }]);
    expect(result.mixed).toEqual([{ at: 119, slot: 2, label: "相手 A" }, { at: 121, slot: 3 }]);
  }));

  it.effect("ファイルでは順不同の行を arrival の順に流し、確定結果が相手 A・相手 B に切れ、残った途中結果は drain で話者なしの発言になる", () => Effect.gen(function* () {
    const result = yield* replayOffline(numbered(offlineLog));

    expect(pieces(result)).toEqual([["相手 A", 0, 2], ["相手 B", 2, 4], [undefined, 10, 11]]);
    expect(result.labels).toEqual(["相手 A", "相手 B"]);
    expect(new Set(result.remarks.map((r) => r.source)).size).toBe(3);
  }));

  it.effect("出力に本文・raw・words を持たない", () => Effect.gen(function* () {
    const result = yield* replayOffline(numbered(offlineLog));

    for (const r of result.remarks) {
      expect(Object.keys(r).filter((key) => !["source", "track", "start", "end", "speaker", "emittedAt", "drained"].includes(key))).toEqual([]);
    }
  }));

  it.effect("起動し直しの旗は arrival の軸（最初の arrival からの秒）で効き、指定した時刻以降の枠は照らし合わせ前は話者なし、近い重心の後は前のラベルにつながる", () => Effect.gen(function* () {
    const restarted = yield* replayOffline(numbered(offlineRestartLog), { restartAt: 10 });
    const plain = yield* replayOffline(numbered(offlineRestartLog));

    expect(restarted.remarks.map((r) => r.speaker)).toEqual(["相手 A", "相手 B", undefined, "相手 A"]);
    expect(restarted.links[0]).toMatchObject({ slot: 2, result: "linked", label: "相手 A" });
    expect(restarted.restarts).toHaveLength(1);
    expect(restarted.restarts[0]).toMatchObject({ source: "flag" });
    expect(plain.remarks.map((r) => r.speaker)).toEqual(["相手 A", "相手 B", "相手 C", "相手 C"]);
    expect(plain.restarts).toEqual([]);
  }));

  const shifted = offlineRestartLog.map((line) => ({ ...line, arrival: (line.arrival as number) + 5 }));
  it.effect.each([
    { name: "origin", head: { arrival: 0, type: "origin", hostTime: "123456" } },
    { name: "知らない種類", head: { arrival: 0, type: "not-a-known-event" } },
  ] as const)("先頭が読み飛ばす行（$name）でも、その arrival を原点にして起動し直す（原点より 15 秒以降の最初の入力の直前）", ({ head }) => Effect.gen(function* () {
    const result = yield* replayOffline(numbered([head, ...shifted]), { restartAt: 15 });

    expect(result.restarts).toEqual([{ at: 17, source: "flag" }]);
    expect(result.remarks.map((r) => r.speaker)).toEqual(["相手 A", "相手 B", undefined, "相手 A"]);
    expect(result.links[0]).toMatchObject({ slot: 2, result: "linked", label: "相手 A" });
  }));

  it.effect("規則を外す旗はオフラインの経路でも中核に届く（5 秒の待ちを外すと、時間切れの後に揃った発言に話者が付く）", () => Effect.gen(function* () {
    const events: Line[] = [
      { arrival: 1, type: "remark", track: "相手", start: 0, end: 2, text: "あいう", duplicate: false },
      { arrival: 2, type: "partial", track: "自分", start: 10, end: 11, text: "", duplicate: false },
      { arrival: 3, type: "speaker", track: "相手", start: 0, end: 2, slot: 0, final: true },
      { arrival: 3, type: "speaker-settled", track: "相手", to: 2 },
    ];

    expect(pieces(yield* replayOffline(numbered(events))).slice(0, 1)).toEqual([[undefined, 0, 2]]);
    expect(pieces(yield* replayOffline(numbered(events), { rules: only("waitLimit") })).slice(0, 1)).toEqual([["相手 A", 0, 2]]);
  }));
});

describe("規則の効き目の数（cuts: 切った数、timeouts: 5 秒で話者なしになった数）", () => {
  const counts = (result: { cuts: number; timeouts: number }) => [result.cuts, result.timeouts];

  it.effect.each([
    { name: "誰もいない語を寄せる規則があると 3 断片が 2 断片になる", log: fillLog, on: 1, off: { fillUnassigned: false }, offCuts: 2 },
    { name: "0.5 秒の下限があると 3 断片が 1 断片になる", log: minRunLog, on: 0, off: { minRun: false }, offCuts: 2 },
  ])("cuts: $name（切った数は断片の数 − 1 の合計）", ({ log, on, off, offCuts }) => Effect.gen(function* () {
    expect((yield* replayLog(numbered(log))).cuts).toBe(on);
    expect((yield* replayLog(numbered(log), { rules: off })).cuts).toBe(offCuts);
  }));

  it.effect("cuts: 切れなかった発言（1 断片のまま出た発言）は数えない", () => Effect.gen(function* () {
    const result = yield* replayLog(numbered(overlapLog));

    expect(result.remarks).toHaveLength(3);
    expect(result.cuts).toBe(0);
  }));

  it.effect("timeouts: 区間が揃わないまま 5 秒の時間切れで話者なしになった発言を数え、5 秒の待ちを外すと 0 になる", () => Effect.gen(function* () {
    expect(counts(yield* replayLog(numbered(waitLog)))).toEqual([0, 1]);
    expect(counts(yield* replayLog(numbered(waitLog), { rules: only("waitLimit") }))).toEqual([0, 0]);
  }));

  it.effect("timeouts: 揃っていた発言は時間切れに数えない", () => Effect.gen(function* () {
    expect((yield* replayLog(numbered(fillLog))).timeouts).toBe(0);
  }));

  it.effect("0 のときも cuts・timeouts のキーを出す（常に出す）", () => Effect.gen(function* () {
    const result = yield* replayLog(numbered(overlapLog));

    expect(result).toMatchObject({ cuts: 0, timeouts: 0 });
  }));

  it.effect("切った・時間切れの記録は links・mixed に混ざらない", () => Effect.gen(function* () {
    const cut = yield* replayLog(numbered(fillLog));
    const timedOut = yield* replayLog(numbered(waitLog));

    expect([cut.links, cut.mixed, timedOut.links, timedOut.mixed]).toEqual([[], [], [], []]);
  }));

  it.effect("オフラインの経路でも数える（確定結果が 2 人に切れる = cuts 1、5 秒の時間切れ = timeouts 1、5 秒の待ちを外すと 0）", () => Effect.gen(function* () {
    expect((yield* replayOffline(numbered(offlineLog))).cuts).toBe(1);
    const events: Line[] = [
      { arrival: 1, type: "remark", track: "相手", start: 0, end: 2, text: "あいう", duplicate: false },
      { arrival: 2, type: "partial", track: "自分", start: 10, end: 11, text: "", duplicate: false },
      { arrival: 3, type: "speaker", track: "相手", start: 0, end: 2, slot: 0, final: true },
      { arrival: 3, type: "speaker-settled", track: "相手", to: 2 },
    ];

    expect((yield* replayOffline(numbered(events))).timeouts).toBe(1);
    expect((yield* replayOffline(numbered(events), { rules: only("waitLimit") })).timeouts).toBe(0);
  }));
});

describe("仮のラベル（replayOffline の tentativeLabels）", () => {
  const seg = (arrival: number, slot: number, start: number, end: number, final: boolean): Line => ({ arrival, type: "speaker", track: "相手", start, end, slot, final });
  const settled = (arrival: number, to: number): Line => ({ arrival, type: "speaker-settled", track: "相手", to });
  const said = (arrival: number, start: number, end: number): Line => ({ arrival, type: "remark", track: "相手", start, end, text: "あい", duplicate: false });
  const tentatives = (result: { remarks: ReadonlyArray<{ speaker?: string; tentative?: string }> }) => result.remarks.map((r) => [r.tentative, r.speaker]);

  it.effect("1 つ前の更新の仮のラベルと、出た発言のラベルが同じ", () => Effect.gen(function* () {
    const lines = [seg(1, 0, 0, 4, false), settled(1, 0), said(2, 0, 4), seg(3, 0, 0, 4, true), settled(3, 4)];

    const result = yield* replayOffline(numbered(lines), { tentativeLabels: true });

    expect(tentatives(result)).toEqual([["相手 A", "相手 A"]]);
  }));

  it.effect("枠が同じでも、予想した順と振られた順が違えば、仮のラベルと確定のラベルが違う", () => Effect.gen(function* () {
    const lines = [seg(1, 1, 0, 2, false), seg(1, 2, 3, 5, false), settled(1, 0), said(2, 3, 5), seg(3, 2, 3, 5, true), settled(3, 5)];

    const result = yield* replayOffline(numbered(lines), { tentativeLabels: true });

    expect(tentatives(result)).toEqual([["相手 B", "相手 A"]]);
  }));

  it.effect("発言が揃った更新の区間では仮のラベルを決めない（それより前に写しが無ければ付けない）", () => Effect.gen(function* () {
    const lines = [said(1, 0, 2), seg(2, 0, 0, 2, true), seg(2, 1, 0, 10, false), settled(2, 2)];

    const result = yield* replayOffline(numbered(lines), { tentativeLabels: true });

    expect(tentatives(result)).toEqual([[undefined, "相手 A"]]);
  }));

  it.effect("発言を出した後に変わった字幕のラベルを、次の発言の仮のラベルにする（変わっていないラベルを替わったに数えない）", () => Effect.gen(function* () {
    const lines = [
      seg(1, 1, 0, 2, false), seg(1, 2, 3, 5, false), settled(1, 0),
      said(2, 3, 5), seg(3, 2, 3, 5, true), seg(3, 1, 6, 8, false), settled(3, 5),
      said(4, 6, 8), seg(5, 1, 6, 8, true), settled(5, 8),
    ];

    const result = yield* replayOffline(numbered(lines), { tentativeLabels: true });

    expect(tentatives(result)).toEqual([["相手 B", "相手 A"], ["相手 B", "相手 B"]]);
  }));

  it.effect("起動し直しの旗と併せても、仮のラベルは起動し直しの後の区間で決める（照らし合わせ前の枠は仮も確定も話者なし）", () => Effect.gen(function* () {
    const result = yield* replayOffline(numbered(offlineRestartLog), { tentativeLabels: true, restartAt: 10 });

    expect(tentatives(result)).toEqual([["相手 A", "相手 A"], ["相手 B", "相手 B"], [undefined, undefined], ["相手 A", "相手 A"]]);
  }));

  it.effect("tentativeLabels がなければ、結果に仮のラベルは現れない（CLI の JSON は変わらない）", () => Effect.gen(function* () {
    const lines = [seg(1, 0, 0, 4, false), settled(1, 0), said(2, 0, 4), seg(3, 0, 0, 4, true), settled(3, 4)];

    const result = yield* replayOffline(numbered(lines));

    expect(JSON.stringify(result)).not.toContain("tentative");
  }));
});


describe("オフライン再生の発言出力時刻", () => {
  it.effect("発言が位置の到着で出た元の arrival を記録し、入力の相対秒や STT 到着時刻を使わない", () => Effect.gen(function* () {
    const lines: Line[] = [
      { arrival: 104, type: "speaker-settled", track: "相手", to: 2 },
      { arrival: 101, type: "remark", track: "相手", start: 0, end: 2, text: "あいう", duplicate: false },
      { arrival: 90, type: "origin", hostTime: "123" },
      { arrival: 103, type: "speaker", track: "相手", start: 0, end: 2, slot: 7, final: true },
    ];
    const result = yield* replayOffline(numbered(lines));
    expect(result.remarks).toEqual([{ source: "r1", track: "相手", start: 0, end: 2, speaker: "相手 A", emittedAt: 104 }]);
  }));

  it.effect("時間切れで出た発言には、その解放を引き起こした入力の arrival を付ける", () => Effect.gen(function* () {
    const lines: Line[] = [
      { arrival: 101, type: "remark", track: "相手", start: 0, end: 2, text: "あいう", duplicate: false },
      { arrival: 106, type: "partial", track: "自分", start: 9, end: 10, text: "", duplicate: false },
    ];
    const result = yield* replayOffline(numbered(lines));
    expect(result.remarks).toEqual([{ source: "r1", track: "相手", start: 0, end: 2, emittedAt: 106 }]);
    expect(result.timeouts).toBe(1);
  }));

  it.effect("終了時の強制解放は最後の処理入力の時刻と drained で区別する", () => Effect.gen(function* () {
    const result = yield* replayOffline(numbered([
      { arrival: 101, type: "remark", track: "相手", start: 0, end: 2, text: "あいう", duplicate: false },
    ]));
    expect(result.remarks).toEqual([{ source: "r1", track: "相手", start: 0, end: 2, emittedAt: 101, drained: true }]);
  }));
});
