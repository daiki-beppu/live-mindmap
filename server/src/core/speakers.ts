// 相手の発言の話者を決める規則（Issue #1021、ADR 0013、GLOSSARY「発言」「話者」）。
// 規則は時刻を引数に取る純粋な関数（splitBySpeaker）と、時刻を引数に取りタイマーを持たない状態つきの段（createSpeakerAttribution）。
// 時計は呼び出し側が渡す音声の時刻（ミリ秒）だけ。壁時計は使わない。タイマーは持たない（中核は実行環境に依存しない。ADR 0003）。
import type { SpeakerLogEvent } from "./live.ts";
import type { SettledRemark } from "./settle.ts";
import { cutWords, keepWordsBefore } from "./words.ts";

// 確定した区間が発言の終わりまで揃うのを待つ長さ（ミリ秒）。保留に入れた時点の音声の時計から数える
export const SPEAKER_WAIT_MS = 3000;
// これより短い話者の区間（話者分離の確定区間）は、前後の話者に寄せる（秒）
const MIN_RUN_SECONDS = 0.5;
const EPSILON = 1e-6;

type Segment = { readonly start: number; readonly end: number; readonly slot: number };
export type SpeakerCut = { remark: SettledRemark; slot: number | undefined };

// 判定の単位。語の区間（wordTimes）の 1 つ。location は本文の位置
type Unit = { location: number; start: number; end: number; slot: number | undefined };
// 同じ話者が続く単位の並び。first / last は units の添字
type Run = { slot: number; first: number; last: number };

const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

// [start, end] に最も長く重なる枠。同じ枠の区間は合計で比べ、同じ長さなら小さい枠。重なりが無ければ undefined
const longestOverlap = (start: number, end: number, segments: readonly Segment[]): number | undefined => {
  const totals = new Map<number, number>();
  for (const s of segments) {
    const o = overlap(start, end, s.start, s.end);
    if (o > EPSILON) totals.set(s.slot, (totals.get(s.slot) ?? 0) + o);
  }
  let best: number | undefined;
  let bestTotal = 0;
  for (const [slot, total] of totals) {
    if (total > bestTotal || (total === bestTotal && best !== undefined && slot < best)) {
      best = slot;
      bestTotal = total;
    }
  }
  return best;
};

// 誰とも判定されない単位を、直前の話者に寄せる。先頭で前が無ければ直後の話者
const fillSlots = (units: Unit[]): void => {
  let previous: number | undefined;
  for (const u of units) {
    if (u.slot === undefined) u.slot = previous;
    else previous = u.slot;
  }
  let next: number | undefined;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    if (u.slot === undefined) u.slot = next;
    else next = u.slot;
  }
};

const toRuns = (units: readonly Unit[]): Run[] => {
  const runs: Run[] = [];
  units.forEach((u, i) => {
    const last = runs.at(-1);
    if (last !== undefined && last.slot === u.slot) last.last = i;
    else runs.push({ slot: u.slot!, first: i, last: i });
  });
  return runs;
};

const lengthOf = (s: Segment) => s.end - s.start;

// 同じ枠で接する・重なる区間を 1 つにまとめる（start 順の並びを受ける）。間が空いている区間は、空きを重なりに数えないよう別々のまま残す
const joinSameSlot = (sorted: readonly Segment[]): Segment[] => {
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last !== undefined && last.slot === s.slot && s.start <= last.end + EPSILON) out[out.length - 1] = { slot: s.slot, start: last.start, end: Math.max(last.end, s.end) };
    else out.push(s);
  }
  return out;
};

// 短い区間を寄せる先の枠。長い方の隣（同じ長さなら前）
const longerNeighborSlot = (segments: readonly Segment[], at: number): number => {
  const previous = segments[at - 1];
  const next = segments[at + 1];
  if (previous === undefined) return next!.slot;
  if (next === undefined) return previous.slot;
  return lengthOf(next) > lengthOf(previous) ? next.slot : previous.slot;
};

// 短い区間（0.5 秒未満）のうち最も短いものの添字。寄せ先が自分と同じ枠なら寄せる意味が無いので数えない。無ければ -1
const shortestShortSegment = (segments: readonly Segment[]): number => {
  let at = -1;
  if (segments.length < 2) return at;
  for (const [i, s] of segments.entries()) {
    const movable = lengthOf(s) < MIN_RUN_SECONDS - EPSILON && longerNeighborSlot(segments, i) !== s.slot;
    if (movable && (at < 0 || lengthOf(s) < lengthOf(segments[at]!))) at = i;
  }
  return at;
};

// 発言の時刻 [start, end] に重なる話者の区間のうち、0.5 秒未満のものを長い方の隣へ寄せる。
// 長さは発言の端で切り詰める前の値で測る。最も短いものから。寄せる隣が無い区間はそのまま残す
const foldShortSegments = (segments: readonly Segment[], start: number, end: number): Segment[] => {
  const near = segments.filter((s) => overlap(start, end, s.start, s.end) > EPSILON).sort((a, b) => a.start - b.start || a.end - b.end);
  let folded = joinSameSlot(near);
  for (;;) {
    const at = shortestShortSegment(folded);
    if (at < 0) return folded;
    const slot = longerNeighborSlot(folded, at);
    folded = joinSameSlot(folded.map((s, i) => (i === at ? { ...s, slot } : s)));
  }
};

type Piece = { slot: number; textStart: number; timeStart: number };

// 区間の境目で切る。start < end を保ち、隣どうしで時刻が重ならないようにする。退化する区間は前の区間へ寄せる
const piecesOf = (remark: SettledRemark, units: readonly Unit[], runs: readonly Run[]): Piece[] => {
  const pieces: Piece[] = [{ slot: runs[0]!.slot, textStart: 0, timeStart: remark.start }];
  for (const run of runs.slice(1)) {
    const previous = pieces.at(-1)!;
    const unit = units[run.first]!;
    const degenerate = unit.location <= previous.textStart || unit.start <= previous.timeStart || unit.start >= remark.end;
    if (run.slot === previous.slot || degenerate) continue;
    pieces.push({ slot: run.slot, textStart: unit.location, timeStart: unit.start });
  }
  return pieces;
};

const sliceRemark = (r: SettledRemark, from: number, to: number, start: number, end: number): SettledRemark => ({
  ...r,
  start,
  end,
  text: r.text.slice(from, to),
  ...(r.words === undefined ? {} : { words: cutWords(keepWordsBefore(r.words, to), from) }),
  ...(r.wordTimes === undefined ? {} : { wordTimes: cutWords(keepWordsBefore(r.wordTimes, to), from) }),
});

// 発言を、話者が替わる所で切る。確定した区間（segments）だけを渡す。
// 0.5 秒未満の話者の区間を長い方の隣へ寄せてから、語の区間ごとに最も長く重なる枠を採り、誰もいない語は前後に寄せる。
// 発言全体で誰もいなければ話者なし。語の区間が無い発言は、発言全体を 1 つの単位にして切らない
export function splitBySpeaker(remark: SettledRemark, segments: readonly Segment[]): SpeakerCut[] {
  const folded = foldShortSegments(segments, remark.start, remark.end);
  const times = remark.wordTimes === undefined || remark.wordTimes.length === 0 ? undefined : [...remark.wordTimes].sort((a, b) => a.location - b.location);
  if (times === undefined) return [{ remark, slot: longestOverlap(remark.start, remark.end, folded) }];
  const units: Unit[] = times.map((w) => ({ location: w.location, start: w.start, end: w.end, slot: longestOverlap(w.start, w.end, folded) }));
  if (units.every((u) => u.slot === undefined)) return [{ remark, slot: undefined }];
  fillSlots(units);
  const runs = toRuns(units);
  const pieces = piecesOf(remark, units, runs);
  if (pieces.length === 1) return [{ remark, slot: pieces[0]!.slot }];
  return pieces.map((p, i) => {
    const next = pieces[i + 1];
    return { remark: sliceRemark(remark, p.textStart, next?.textStart ?? remark.text.length, p.timeStart, next?.timeStart ?? remark.end), slot: p.slot };
  });
}

// 0 → A、25 → Z、26 → AA…
const letters = (n: number): string => (n < 26 ? "" : letters(Math.floor(n / 26) - 1)) + String.fromCharCode(65 + (n % 26));

type Held = { remark: SettledRemark; heldAt: number };

// 相手の発言に話者を付けて出す段。settler が締めた発言を受け取り、確定した区間が発言の終わりまで揃ってから出す。
// 揃わなければ SPEAKER_WAIT_MS（音声の時計）の後に話者なしで出す。speaker-off の後は待たずに話者なしで出す。
// 出した発言は書き換えない。枠とラベルの対応はこの段が持つ（セッションに 1 つ）。どの戻り値も「いま出す発言」
export function createSpeakerAttribution() {
  const segments: Segment[] = []; // 相手の確定した区間
  // ヘルパーの speaker-settled の最大値。この位置より前の確定区間はすべて届いている。
  // 確定区間の end からは判定しない（FluidAudio は確定区間を枠の番号順に、閉じたものだけ流すので、end の最大値は「揃った」を保証しない）
  let settledTo = Number.NEGATIVE_INFINITY;
  let off = false;
  let clock = 0; // 音声の時計（ミリ秒）。戻らない
  const labels = new Map<number, string>();
  const held: Held[] = [];

  const labelOf = (slot: number): string => {
    const known = labels.get(slot);
    if (known !== undefined) return known;
    const label = `相手 ${letters(labels.size)}`;
    labels.set(slot, label);
    return label;
  };

  const isSettled = (r: SettledRemark) => settledTo >= r.end - EPSILON;

  // 規則を当てて出す。先に話した順にラベルを振る
  const attribute = (r: SettledRemark): SettledRemark[] =>
    splitBySpeaker(r, segments).map(({ remark, slot }) => (slot === undefined ? remark : { ...remark, speaker: labelOf(slot) }));

  // 保留の先頭から、揃った発言か時間切れの発言を出す
  const release = (): SettledRemark[] => {
    const out: SettledRemark[] = [];
    for (let head = held[0]; head !== undefined; head = held[0]) {
      if (isSettled(head.remark)) out.push(...attribute(head.remark));
      else if (head.heldAt + SPEAKER_WAIT_MS <= clock) out.push(head.remark);
      else break;
      held.shift();
    }
    return out;
  };

  return {
    // settler が締めた発言。now は音声の時刻（ミリ秒）。時計を進めて期限の来た保留を出してから、新しい発言を受ける
    remarks(settled: readonly SettledRemark[], now: number): SettledRemark[] {
      clock = Math.max(clock, now);
      const out = release();
      for (const r of settled) {
        if (r.track === "自分") out.push({ ...r, speaker: "自分" });
        else if (off) out.push(r);
        else {
          held.push({ remark: r, heldAt: clock });
          out.push(...release());
        }
      }
      return out;
    },

    // ヘルパーの speaker / speaker-settled / speaker-off。確定した相手の区間は覚えるだけで、保留を出すのは確定済みの位置が進んだとき。
    // speaker-off では保留を話者なしですべて出す
    speaker(event: SpeakerLogEvent): SettledRemark[] {
      if (off) return [];
      if (event.type === "speaker-off") {
        off = true;
        return held.splice(0).map((h) => h.remark);
      }
      if (event.track !== "相手") return [];
      if (event.type === "speaker-settled") {
        settledTo = Math.max(settledTo, event.to);
        return release();
      }
      if (event.final) segments.push({ start: event.start, end: event.end, slot: event.slot });
      return [];
    },

    // 停止時。保留を待たずにすべて出す。揃っていれば規則を当て、揃っていなければ話者なし。状態は捨てない
    drain(): SettledRemark[] {
      return held.splice(0).flatMap((h) => (isSettled(h.remark) ? attribute(h.remark) : [h.remark]));
    },
  };
}
