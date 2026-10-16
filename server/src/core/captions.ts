// 字幕（Issue #1022）。いま話している文字を、話し始めの順に 1 列に並ぶ話者つきの吹き出しにして、ブラウザへ送る。マップ（Snapshot）には入れない。
// Node の実行環境に依存しない（ADR 0003）。盤は純粋で、時計もタイマーも持たない。
import { Schema } from "effect";
import type { HelperPartial } from "./live.ts";
import { placeCorrectionForCaptions, type CaptionCorrection, type Replacement } from "./correction.ts";
import { Track } from "./remark.ts";
import type { SettledRemark } from "./settle.ts";
import { longestOverlap, type Segment } from "./speakers.ts";

// ラベルの状態。仮は仮の区間か確定区間から付けた予想、確定は発言で決まった話者（自分を含む）、なしは話者の手がかりが無い
export const CaptionLabel = Schema.Literals(["仮", "確定", "なし"]);
export type CaptionLabel = typeof CaptionLabel["Type"];

// 吹き出し。id はフレームをまたいで同じ吹き出しを指す。start / end は語の区間の最初と最後（秒）
export const CaptionBubble = Schema.Struct({
  id: Schema.String,
  track: Track,
  speaker: Schema.optionalKey(Schema.String),
  label: CaptionLabel,
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
  // text の先頭から何文字までが確定（発言になった文字）か。残りは途中結果。全部確定なら text の長さ
  settledLength: Schema.Int,
  // 区間が届く前に 1 つで送った吹き出しから、話者で分かれて出た吹き出しだけが持つ。分かれる前の吹き出し（id）。表示したかを知っている側（ブラウザ）が、文字を移すかどうかを決める
  splitFrom: Schema.optionalKey(Schema.String),
});
export type CaptionBubble = typeof CaptionBubble["Type"];

// ブラウザへ送る frame。スナップショットの frame とは type で見分ける
export const CaptionsFrame = Schema.Struct({ type: Schema.Literal("captions"), bubbles: Schema.Array(CaptionBubble) });
export type CaptionsFrame = typeof CaptionsFrame["Type"];

export type CaptionBoardInput = {
  // トラックごとの途中結果（まだ発言になっていない文字）
  readonly partials: readonly HelperPartial[];
  // 出た発言（マップに反映前）。話者があれば確定。
  // replacements があるときは、remark の text と wordTimes は補正前の値で、盤が表示済みの吹き出しの境目を見て字幕用の本文と位置を作る
  readonly unreflected: readonly { readonly id: string; readonly remark: SettledRemark; readonly replacements?: readonly Replacement[] }[];
  // 話者が決まるのを待っている発言
  readonly held: readonly SettledRemark[];
  // 相手の確定区間と仮の区間
  readonly intervals: readonly Segment[];
  // 枠のラベルを覗く（振らない）
  readonly previewLabel: (slot: number) => string | undefined;
};

// settled は、語が発言（unreflected・held）から来たか。途中結果の語は false。remarkUnits の引数 settled（話者の決め方の旗）とは別
type Unit = { source: number; start: number; end: number; text: string; speaker: string | undefined; label: CaptionLabel; settled: boolean };
// 送った吹き出しの境目。id は最初に送ったときに振り、動かさない。start / last は、いま属している語の開始時刻の最小と最大。
// open は、属する語に話者が一度も付いていない境目（ラベル「なし」で送ったまま）。区間が届いて話者が分かれたとき、開いた境目だけ語を話者で分け直せる。splitFrom は分け直して生まれた境目の、もとの境目の id
// 盤が覚える境目は「送った吹き出し」の境目。build だけが確定し、preview は確定しない（送らなかった比較で、ブラウザが知らない id や閉じた境目を作らないため）
type Boundary = { id: string; start: number; last: number; open: boolean; splitFrom?: string };
// 吹き出しの最初の語の開始時刻の揺れ（認識のやり直しで少し動く）を許す幅（秒）。後ろは許さない（直後の新しい語を取り込まないため）
const START_TOLERANCE_S = 0.5;
// 保留中の発言の区間と途中結果の語を突き合わせるときの、開始時刻の揺れの幅（秒）
const HELD_OVERLAP_S = 0.05;

// 話者の手がかりが無い語を、直前の語に続ける、直前の語との間の長さ（秒）。この長さ未満なら続け、以上なら新しい吹き出しにする
export const CAPTION_CONTINUE_GAP_S = 0.3;
// 直前の語の終わりから次の語の始まりまでの間が、続ける長さに収まるか（ミリ秒に丸めて比べる）
export const continuesAfter = (previousEnd: number, start: number): boolean => Math.round((start - previousEnd) * 1000) < CAPTION_CONTINUE_GAP_S * 1000;

// 語（開始時刻）が属する、送った吹き出しの境目。先に範囲に入る吹き出し（既存の所属）を探し、無いときだけ最初の語の揺れ（許容）で、直後に始まる吹き出しを探す
const ownerOf = (previous: readonly Boundary[], start: number): Boundary | undefined =>
  [...previous].reverse().find((b) => b.start <= start && start <= b.last) ?? previous.find((b) => b.start - START_TOLERANCE_S <= start && start < b.start);

// 語をつないだ本文と、先頭から続く発言の語の長さ（確定の文字数）。途中結果の語より後ろは、発言の語でも確定に数えない。本文の trim で先頭の空白が落ちた分を引く
const joinUnits = (us: readonly Unit[]): { text: string; settledLength: number } => {
  let raw = "";
  let settledEnd = 0;
  let contiguous = true;
  for (const u of us) {
    raw += (needsSpace(raw, u.text) ? " " : "") + u.text;
    contiguous = contiguous && u.settled;
    if (contiguous) settledEnd = raw.length;
  }
  const text = raw.trim();
  const dropped = raw.length - raw.trimStart().length;
  return { text, settledLength: Math.min(text.length, Math.max(0, settledEnd - dropped)) };
};

const TRACKS: readonly Track[] = ["相手", "自分"];
const needsSpace = (left: string, right: string) => /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);

// 本文を語ごとに分ける。語の区間が無ければ全体を 1 つにする。語の文字は、次の語の位置の手前まで（句読点・空白も含める）
const wordUnits = (
  text: string,
  start: number,
  end: number,
  wordTimes: readonly { readonly location: number; readonly start: number; readonly end: number }[] | undefined,
  unit: (start: number, end: number, text: string) => Unit,
): Unit[] => {
  const times = wordTimes === undefined || wordTimes.length === 0 ? undefined : [...wordTimes].sort((a, b) => a.location - b.location);
  if (times === undefined) return [unit(start, end, text)];
  return times.map((w, i) => unit(w.start, w.end, text.slice(i === 0 ? 0 : w.location, times[i + 1]?.location ?? text.length)));
};

const partialUnits = (p: HelperPartial, source: number, intervals: readonly Segment[], previewLabel: (slot: number) => string | undefined): Unit[] =>
  wordUnits(p.text, p.start, p.end, p.wordTimes, (start, end, text) => {
    if (p.track === "自分") return { source, start, end, text, speaker: "自分", label: "確定", settled: false };
    const slot = longestOverlap(start, end, intervals);
    const speaker = slot === undefined ? undefined : previewLabel(slot);
    return { source, start, end, text, speaker, label: speaker === undefined ? "なし" : "仮", settled: false };
  });

// 発言を語ごとの単位にする（表示済みの吹き出しの境目で文字を分配できるように）。出た発言（unreflected）は発言の話者、保留中の発言（held）は区間から予想した仮の話者
const remarkUnits = (r: SettledRemark, source: number, intervals: readonly Segment[], previewLabel: (slot: number) => string | undefined, settled: boolean): Unit[] =>
  wordUnits(r.text, r.start, r.end, r.wordTimes, (start, end, text) => {
    const base = { source, start, end, text, settled: true };
    if (r.track === "自分") return { ...base, speaker: "自分", label: "確定" };
    if (settled) return { ...base, speaker: r.speaker, label: r.speaker === undefined ? "なし" : "確定" };
    const slot = longestOverlap(start, end, intervals);
    const speaker = slot === undefined ? undefined : previewLabel(slot);
    return { ...base, speaker, label: speaker === undefined ? "なし" : "仮" };
  });

// 1 回の計算が、確定状態を読んで作る次の状態。build が確定し、preview は捨てる
type Draft = { serial: number; corrections: Map<string, CaptionCorrection>; boundariesOf: Map<Track, Boundary[]> };

// 字幕の盤。送った吹き出しの境目と id を覚え、一度出した文字を後から別の吹き出しへ移さない。変わるのはラベルだけ。
// ただしラベル「なし」のまま送った境目（open）は、ブラウザがまだ表示したと限らないので、区間が届いて話者が分かれたら語を分け直し、新しい境目に splitFrom を付ける。表示したかどうかはブラウザが決める
// 境目を作るのは、そのトラックの末尾の新しい語だけ（前の語と話者が違うか、別の発言・途中結果の語、または話者なしの語が前の語から CAPTION_CONTINUE_GAP_S 以上空いたとき）。「なし」も別の話者として扱う
export function createCaptionBoard() {
  const boundariesOf = new Map<Track, Boundary[]>();
  // 未反映の発言ごとの、字幕用の本文と位置。最初に作った値を使い続ける（後のフレームで、同じ文字を別の吹き出しへ移さないため）
  let corrections = new Map<string, CaptionCorrection>();
  let serial = 0;

  const correctionOf = (draft: Draft, id: string, remark: SettledRemark, replacements: readonly Replacement[], previous: readonly Boundary[]): CaptionCorrection | undefined => {
    const made = draft.corrections.get(id);
    if (made !== undefined || remark.wordTimes === undefined) return made;
    const placed = placeCorrectionForCaptions(remark.text, remark.wordTimes, replacements, (w) => ownerOf(previous, w.start)?.id);
    draft.corrections.set(id, placed);
    return placed;
  };

  const unitsOf = (draft: Draft, track: Track, input: CaptionBoardInput, previous: readonly Boundary[]): Unit[] => {
    const out: Unit[] = [];
    let source = 0;
    for (const { id, remark, replacements } of input.unreflected) {
      if (remark.track !== track) continue;
      const placed = replacements === undefined ? undefined : correctionOf(draft, id, remark, replacements, previous);
      out.push(...remarkUnits(placed === undefined ? remark : { ...remark, text: placed.text, wordTimes: placed.wordTimes }, source++, input.intervals, input.previewLabel, true));
    }
    const held = input.held.filter((r) => r.track === track);
    for (const remark of held) out.push(...remarkUnits(remark, source++, input.intervals, input.previewLabel, false));
    // 保留中の発言は、元の途中結果がまだ残っている。同じ語を二重に出さないよう、発言の区間に始まる途中結果の語は除く
    const covered = (u: Unit) => held.some((r) => r.start - HELD_OVERLAP_S <= u.start && u.start <= r.end);
    for (const p of input.partials) if (p.track === track && !p.duplicate) out.push(...partialUnits(p, source++, input.intervals, input.previewLabel).filter((u) => !covered(u)));
    return out.filter((u) => u.text !== "").sort((a, b) => a.start - b.start);
  };

  const trackBubbles = (draft: Draft, track: Track, input: CaptionBoardInput): CaptionBubble[] => {
    const previous = boundariesOf.get(track) ?? [];
    const units = unitsOf(draft, track, input, previous);
    const groups = new Map<Boundary, Unit[]>();
    const boundaries: Boundary[] = [];
    // 開いた境目から話者で分かれて生まれた、最新の境目
    const splits = new Map<Boundary, Boundary>();
    // 送った語の行き先。閉じた境目はそのまま。開いた境目は、この build の最初の語がその境目に残り（id を保つ）、話者が替わる語から新しい境目になる
    const placeInOwner = (owner: Boundary, u: Unit): Boundary => {
      const target = splits.get(owner) ?? owner;
      const last = groups.get(target)?.at(-1);
      if (!owner.open || last === undefined || last.speaker === u.speaker) return target;
      const split: Boundary = { id: `caption-${track}-${draft.serial++}`, start: u.start, last: u.start, open: true, splitFrom: owner.id };
      splits.set(owner, split);
      return split;
    };
    let current: Boundary | undefined;
    let before: Unit | undefined;
    for (const u of units) {
      // 送った語は、開始時刻が送った吹き出しの範囲に入る限り、その吹き出しに属する。範囲の外の語は新しい語で、末尾に境目を作れる
      const owner = ownerOf(previous, u.start);
      if (owner !== undefined) {
        current = placeInOwner(owner, u);
      } else if (current === undefined || before === undefined || before.source !== u.source || before.speaker !== u.speaker || (u.speaker === undefined && !continuesAfter(before.end, u.start))) {
        current = { id: `caption-${track}-${draft.serial++}`, start: u.start, last: u.start, open: true };
      }
      if (!boundaries.includes(current)) boundaries.push(current);
      groups.set(current, [...(groups.get(current) ?? []), u]);
      before = u;
    }
    draft.boundariesOf.set(track, boundaries.map((b) => ({ ...b, last: Math.max(...groups.get(b)!.map((u) => u.start)), open: b.open && groups.get(b)!.every((u) => u.speaker === undefined) })));
    return [...groups].map(([b, us]): CaptionBubble => {
      const named = us.find((u) => u.speaker !== undefined);
      const { text, settledLength } = joinUnits(us);
      return {
        id: b.id,
        track,
        ...(named?.speaker === undefined ? {} : { speaker: named.speaker }),
        label: named?.label ?? "なし",
        start: us[0]!.start,
        end: us.at(-1)!.end,
        text,
        settledLength,
        ...(b.splitFrom === undefined ? {} : { splitFrom: b.splitFrom }),
      };
    });
  };

  // 確定状態を読んで、吹き出しと次の状態を計算する。確定状態は書き換えない
  const compute = (input: CaptionBoardInput): { bubbles: CaptionBubble[]; draft: Draft } => {
    const draft: Draft = { serial, corrections: new Map(corrections), boundariesOf: new Map() };
    const bubbles = TRACKS.flatMap((track) => trackBubbles(draft, track, input)).sort((a, b) => a.start - b.start);
    const unreflected = new Set(input.unreflected.map(({ id }) => id));
    for (const id of draft.corrections.keys()) if (!unreflected.has(id)) draft.corrections.delete(id);
    return { bubbles, draft };
  };

  return {
    // いまの状態の全体から、話し始めの順に並べた吹き出しを作る。送るフレームのために呼び、境目・id・補正を確定する
    build(input: CaptionBoardInput): CaptionBubble[] {
      const { bubbles, draft } = compute(input);
      serial = draft.serial;
      corrections = draft.corrections;
      for (const [track, boundaries] of draft.boundariesOf) boundariesOf.set(track, boundaries);
      return bubbles;
    },
    // build と同じ吹き出しを、状態を確定せずに作る。送るかどうかを決める比較に使う（送らなかった比較が境目を閉じたり id を進めたりしないため）
    preview(input: CaptionBoardInput): CaptionBubble[] {
      return compute(input).bubbles;
    },
    // 覚えている境目を捨てる（セッションの字幕を空にするとき）
    reset(): void {
      boundariesOf.clear();
      corrections = new Map();
    },
  };
}
