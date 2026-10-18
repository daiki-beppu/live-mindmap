import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { replayLog, replayOffline } from "../bench/speakerReplay.ts";
import {
  fillLog, liveLog, minRunLog, offlineLog, numbered, offlineRestartLog, overlapLog, remarkLine, restartLog, segLine, settledLine, startLine, waitLog,
  type Line,
} from "./speakerReplayFixtures.ts";

// Issue #1030: 締める前の入力と話者のイベントを、届いた順に中核（createRemarkSettling / createSpeakerAttribution）へ流し直す bench。
// 入力は読み込み済みの JSON（log.jsonl は行ごと、オフライン出力は arrival つきの行ごと）。出力に本文は含まれない。
// 規則を外した結果は、このファイルだけで確かめる（speakers.test.ts は規則そのものの観測）。

type Piece = [speaker: string | undefined, start: number, end: number];
const pieces = (result: { remarks: ReadonlyArray<{ speaker?: string; start: number; end: number }> }): Piece[] =>
  result.remarks.map((r) => [r.speaker, r.start, r.end]);

const RULES = { longestOverlap: false, fillUnassigned: false, minRun: false, waitLimit: false } as const;
type RuleName = keyof typeof RULES;
const only = (name: RuleName) => ({ [name]: false });

describe("log.jsonl の流し直し（ライブで決まった話者の再現）", () => {
  it.effect("2 人に切る・時間切れで話者なし・自分・混入・起動し直し後のつなぎ直しを含む log を旗なしで流すと、各 remark 行の話者がライブで決まった話者と同じになる", () => Effect.gen(function* () {
    const { lines, liveSpeakers } = yield* liveLog;
    // fixture が空でないこと（ライブで 2 人・話者なし・自分・つなぎ直しが実際に起きている）
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
    { name: "3 秒の待ちを外す", options: { rules: only("waitLimit") } },
  ])("$name でも失敗せず、相手の発言は話者なし・自分の発言は自分になる（保留が出ないまま終わらない）", ({ options }) => Effect.gen(function* () {
    const result = yield* replayLog(numbered(oldLog), options);

    // 3 秒の待ちを外すと、保留は最後の drain で出るので、出る順は変わる。source で並べて比べる
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
    // r3 [10,14]: 長く重なる枠 0（相手 A）と、短く先に始まる枠 1（相手 B）
    { rule: "longestOverlap", log: overlapLog, on: [[A, 0, 1], [B, 2, 3], [A, 10, 14]], off: [[A, 0, 1], [B, 2, 3], [B, 10, 14]] },
    // 区間の無い語: 前の枠に寄せる / 寄せずにその語だけ話者なし
    { rule: "fillUnassigned", log: fillLog, on: [[A, 0, 3], [B, 3, 4]], off: [[A, 0, 2], [undefined, 2, 3], [B, 3, 4]] },
    // 0.25 秒の枠: 前後の枠に寄せて切らない / 寄せずに切る
    { rule: "minRun", log: minRunLog, on: [[A, 0, 6]], off: [[A, 0, 2.5], [B, 2.5, 2.75], [A, 2.75, 6]] },
    // 時間切れの後に届いた区間: 話者なし / 揃うまで待って相手 A
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
      ["r1", "相手 A"], ["r2", "相手 B"], // 指定した時刻より前は変わらない
      ["r3", undefined], // 枠 2 は照らし合わせ前
      ["r4", "相手 A"], // 近い重心 → つなぐ
      ["r5", "相手 C"], // 遠い重心 → 新しいラベル
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
  it.effect("ファイルでは順不同の行を arrival の順に流し、確定結果が相手 A・相手 B に切れ、残った途中結果は drain で話者なしの発言になる", () => Effect.gen(function* () {
    const result = yield* replayOffline(numbered(offlineLog));

    expect(pieces(result)).toEqual([["相手 A", 0, 2], ["相手 B", 2, 4], [undefined, 10, 11]]);
    expect(result.labels).toEqual(["相手 A", "相手 B"]);
    expect(new Set(result.remarks.map((r) => r.source)).size).toBe(3);
  }));

  it.effect("出力に本文・raw・words を持たない", () => Effect.gen(function* () {
    const result = yield* replayOffline(numbered(offlineLog));

    for (const r of result.remarks) {
      expect(Object.keys(r).filter((key) => !["source", "track", "start", "end", "speaker"].includes(key))).toEqual([]);
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

  // 先頭に読み飛ばす行（origin・知らない種類）がある入力。読み飛ばす行の arrival も時刻の原点に入る（原点 0、残りは offlineRestartLog に 5 を足した値）
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

  it.effect("規則を外す旗はオフラインの経路でも中核に届く（3 秒の待ちを外すと、時間切れの後に揃った発言に話者が付く）", () => Effect.gen(function* () {
    // 確定結果 [0,2] の後、時計が 3 秒進む自分の途中結果で時間切れ → 話者なし。区間と speaker-settled はその後に届く
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

// Issue #1031: 発言への対応付けの規則の効き目。中核の話者の段が「切った」「3 秒で諦めた」を知らせ、流し直しの結果が数を持つ。
// 数は規則を 1 つずつ外した結果と比べるために常に出す（0 でも省かない）。cut と timeout は混入・つなぎ直しの記録（mixed / links）には混ざらない
describe("規則の効き目の数（cuts: 切った数、timeouts: 3 秒で話者なしになった数）", () => {
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

  it.effect("timeouts: 区間が揃わないまま 3 秒の時間切れで話者なしになった発言を数え、3 秒の待ちを外すと 0 になる", () => Effect.gen(function* () {
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

  it.effect("オフラインの経路でも数える（確定結果が 2 人に切れる = cuts 1、3 秒の時間切れ = timeouts 1、3 秒の待ちを外すと 0）", () => Effect.gen(function* () {
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

// 字幕に見えていた仮のラベル（tentativeLabels）。発言が出た更新の 1 つ前の speaker-settled の後の、中核の preview で決める
describe("仮のラベル（replayOffline の tentativeLabels）", () => {
  const seg = (arrival: number, slot: number, start: number, end: number, final: boolean): Line => ({ arrival, type: "speaker", track: "相手", start, end, slot, final });
  const settled = (arrival: number, to: number): Line => ({ arrival, type: "speaker-settled", track: "相手", to });
  const said = (arrival: number, start: number, end: number): Line => ({ arrival, type: "remark", track: "相手", start, end, text: "あい", duplicate: false });
  const tentatives = (result: { remarks: ReadonlyArray<{ speaker?: string; tentative?: string }> }) => result.remarks.map((r) => [r.tentative, r.speaker]);

  // SCN-SA-TENT-P1
  it.effect("1 つ前の更新の仮のラベルと、出た発言のラベルが同じ", () => Effect.gen(function* () {
    const lines = [seg(1, 0, 0, 4, false), settled(1, 0), said(2, 0, 4), seg(3, 0, 0, 4, true), settled(3, 4)];

    const result = yield* replayOffline(numbered(lines), { tentativeLabels: true });

    expect(tentatives(result)).toEqual([["相手 A", "相手 A"]]);
  }));

  // SCN-SA-TENT-N1: 枠で比べると同じ（枠 2）だが、予想は初めて現れた順（枠 1 が先で、枠 2 は 相手 B）、実際は発言の出た順（枠 2 の発言が最初で 相手 A）
  it.effect("枠が同じでも、予想した順と振られた順が違えば、仮のラベルと確定のラベルが違う", () => Effect.gen(function* () {
    const lines = [seg(1, 1, 0, 2, false), seg(1, 2, 3, 5, false), settled(1, 0), said(2, 3, 5), seg(3, 2, 3, 5, true), settled(3, 5)];

    const result = yield* replayOffline(numbered(lines), { tentativeLabels: true });

    expect(tentatives(result)).toEqual([["相手 B", "相手 A"]]);
  }));

  // SCN-SA-TENT-N2
  it.effect("発言が揃った更新の区間では仮のラベルを決めない（それより前に写しが無ければ付けない）", () => Effect.gen(function* () {
    const lines = [said(1, 0, 2), seg(2, 0, 0, 2, true), seg(2, 1, 0, 10, false), settled(2, 2)];

    const result = yield* replayOffline(numbered(lines), { tentativeLabels: true });

    expect(tentatives(result)).toEqual([[undefined, "相手 A"]]);
  }));

  // 未割当の 2 枠の予想順（枠 1 が先）と発言順（枠 2 が先）が逆。最初の発言に 相手 A が振られると、枠 1 の字幕のラベルは 相手 A → 相手 B に変わる（次の発言にも 相手 B が振られ、替わっていない）
  it.effect("発言を出した後に変わった字幕のラベルを、次の発言の仮のラベルにする（変わっていないラベルを替わったに数えない）", () => Effect.gen(function* () {
    const lines = [
      seg(1, 1, 0, 2, false), seg(1, 2, 3, 5, false), settled(1, 0),
      said(2, 3, 5), seg(3, 2, 3, 5, true), seg(3, 1, 6, 8, false), settled(3, 5),
      said(4, 6, 8), seg(5, 1, 6, 8, true), settled(5, 8),
    ];

    const result = yield* replayOffline(numbered(lines), { tentativeLabels: true });

    expect(tentatives(result)).toEqual([["相手 B", "相手 A"], ["相手 B", "相手 B"]]);
  }));

  it.effect("tentativeLabels がなければ、結果に仮のラベルは現れない（CLI の JSON は変わらない）", () => Effect.gen(function* () {
    const lines = [seg(1, 0, 0, 4, false), settled(1, 0), said(2, 0, 4), seg(3, 0, 0, 4, true), settled(3, 4)];

    const result = yield* replayOffline(numbered(lines));

    expect(JSON.stringify(result)).not.toContain("tentative");
  }));
});
