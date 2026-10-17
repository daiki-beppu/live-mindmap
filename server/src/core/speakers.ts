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

export type Segment = { readonly start: number; readonly end: number; readonly slot: number };
export type SpeakerCut = { remark: SettledRemark; slot: number | undefined };

// 規則を 1 つずつ外して測り直すための切り替え（Issue #1030）。ライブは渡さず、既定はすべて有効。
// longestOverlap: 語（発言）に最も長く重なる枠を採る。外すと、重なる区間のうち start が最も早い枠（同じなら小さい枠）
// fillUnassigned: 誰もいない語を前後の枠に寄せる。外すと、その語は話者なし
// minRun: 0.5 秒未満の区間を長い方の隣へ寄せる。外すと、区間をそのまま使う
// waitLimit: 揃わない保留を SPEAKER_WAIT_MS で諦めて話者なしにする。外すと、揃う・speaker-off・起動し直し・drain まで待つ
export type SpeakerRules = { readonly longestOverlap: boolean; readonly fillUnassigned: boolean; readonly minRun: boolean; readonly waitLimit: boolean };
const DEFAULT_RULES: SpeakerRules = Object.freeze({ longestOverlap: true, fillUnassigned: true, minRun: true, waitLimit: true });

// 判定の単位。語の区間（wordTimes）の 1 つ。location は本文の位置
type Unit = { location: number; start: number; end: number; slot: number | undefined };
// 同じ話者が続く単位の並び。first / last は units の添字
type Run = { slot: number | undefined; first: number; last: number };

const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

// [start, end] に最も長く重なる枠。同じ枠の区間は合計で比べ、同じ長さなら小さい枠。重なりが無ければ undefined
export const longestOverlap = (start: number, end: number, segments: readonly Segment[]): number | undefined => {
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
    else runs.push({ slot: u.slot, first: i, last: i });
  });
  return runs;
};

// longestOverlap の規則を外したときの決め方。重なる区間のうち start が最も早い枠、同じなら小さい枠。重なりが無ければ undefined
const earliestOverlap = (start: number, end: number, segments: readonly Segment[]): number | undefined => {
  let best: Segment | undefined;
  for (const s of segments) {
    if (overlap(start, end, s.start, s.end) <= EPSILON) continue;
    if (best === undefined || s.start < best.start || (s.start === best.start && s.slot < best.slot)) best = s;
  }
  return best?.slot;
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

type Piece = { slot: number | undefined; textStart: number; timeStart: number };

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
export function splitBySpeaker(remark: SettledRemark, segments: readonly Segment[], rules: SpeakerRules = DEFAULT_RULES): SpeakerCut[] {
  const folded = rules.minRun ? foldShortSegments(segments, remark.start, remark.end) : segments;
  const pick = rules.longestOverlap ? longestOverlap : earliestOverlap;
  const times = remark.wordTimes === undefined || remark.wordTimes.length === 0 ? undefined : [...remark.wordTimes].sort((a, b) => a.location - b.location);
  if (times === undefined) return [{ remark, slot: pick(remark.start, remark.end, folded) }];
  const units: Unit[] = times.map((w) => ({ location: w.location, start: w.start, end: w.end, slot: pick(w.start, w.end, folded) }));
  if (units.every((u) => u.slot === undefined)) return [{ remark, slot: undefined }];
  if (rules.fillUnassigned) fillSlots(units);
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

// 起動し直した後の新しい枠を、前のラベルにつなぎ直す cos の基準（Issue #1025）。helper の SlotMixCriteria（混入の判定）とは別の判定
// 1 つのラベルとだけこの値以上で一致する枠は、そのラベルにつなぐ
export const LINK_MIN_SIMILARITY = 0.9;
// どのラベルともこの値未満の枠は、新しいラベルにする。この値以上でつなぐ値未満の間は、話者なしのまま
export const NEW_LABEL_MAX_SIMILARITY = 0.6;

const norm = (v: readonly number[]) => Math.hypot(...v);

// 長さの違うベクトルと、長さ 0 のベクトルは比べられない（undefined）
const cosine = (a: readonly number[], b: readonly number[]): number | undefined => {
  const denominator = norm(a) * norm(b);
  if (a.length !== b.length || !(denominator > 0)) return undefined;
  return a.reduce((sum, x, i) => sum + x * b[i]!, 0) / denominator;
};

// 判定の記録（Issue #1030）。決まらなかった判定は知らせない
export type SpeakerRecord =
  | { type: "mixed"; slot: number; label?: string }
  | { type: "link"; slot: number; result: "linked" | "new" | "reverted"; label?: string }
  // 話者の替わり目で発言を pieces 個の断片に切った（2 以上）
  | { type: "cut"; pieces: number }
  // 区間が揃わないまま SPEAKER_WAIT_MS の時間切れで、話者なしで出した
  | { type: "timeout" };
export type SpeakerAttributionOptions = { rules?: SpeakerRules; observe?: (record: SpeakerRecord) => void };

type Held = { remark: SettledRemark; heldAt: number };
// 起動し直した後の世代の枠の状態。linked: 前のラベルにつないだ。new: どのラベルとも遠い（初めて話したときにラベルを振る）。無ければ照らし合わせが済むまで（話者なし）
type SlotState = "linked" | "new";

// 相手の発言に話者を付けて出す段。settler が締めた発言を受け取り、確定した区間が発言の終わりまで揃ってから出す。
// 揃わなければ SPEAKER_WAIT_MS（音声の時計）の後に話者なしで出す。speaker-off の後は待たずに話者なしで出す。
// 出した発言は書き換えない。枠とラベルの対応はこの段が持つ（セッションに 1 つ）。どの戻り値も「いま出す発言」
// ヘルパーを起動し直すと Sortformer の枠は振り直される。restart() 以降の世代では、枠の重心（speaker-centroid）を、
// セッションの間持つラベルごとの重心と照らし合わせるまで、その枠の発言に話者を付けない（Issue #1025）。
// 状態は 2 つ。ラベル単位（採番した数・ラベルの重心・戻したラベル。起動し直しをまたいで残す）と、世代の枠単位（restart で捨てる）
export function createSpeakerAttribution({ rules = DEFAULT_RULES, observe }: SpeakerAttributionOptions = {}) {
  let off = false;
  let clock = 0; // 音声の時計（ミリ秒）。戻らない
  const held: Held[] = [];

  // ラベル単位。起動し直しをまたいで残す
  let labelCount = 0;
  const labelCentroids = new Map<string, readonly number[]>();
  // 混入で戻したラベル（Issue #1024）。会議の最後まで、どの枠にも付けない（戻した枠のラベルを、つないだ別の枠にも使い回さない）
  const revertedLabels = new Set<string>();
  // 起動し直した後の世代か。最初の世代は照らし合わせをしない（枠の番号がそのままラベルの元）
  let renumbered = false;

  // 世代の枠単位。restart で捨てる
  let segments: Segment[] = []; // 相手の確定した区間
  // ヘルパーの speaker-settled の最大値。この位置より前の確定区間はすべて届いている。
  // 確定区間の end からは判定しない（FluidAudio は確定区間を枠の番号順に、閉じたものだけ流すので、end の最大値は「揃った」を保証しない）
  let settledTo = Number.NEGATIVE_INFINITY;
  let slotLabels = new Map<number, string>();
  let slotStates = new Map<number, SlotState>();
  let slotCentroids = new Map<number, readonly number[]>();
  // 混入で戻した枠。世代の最後まで戻したまま（外さない）
  let revertedSlots = new Set<number>();
  // 字幕のための仮の区間（Issue #1022）。ヘルパーは更新ごとに「確定区間 → 仮の区間 → speaker-settled」の順に流すので、
  // 仮の区間は届いた分をためておき、speaker-settled でその更新ぶんに入れ替える。発言の判定には使わない
  let provisional: Segment[] = [];
  let incoming: Segment[] = [];
  // 区間に現れた枠の、初めて現れた順。まだラベルを振っていない枠の予想に使う
  let seenSlots: number[] = [];
  const see = (slot: number) => {
    if (!seenSlots.includes(slot)) seenSlots.push(slot);
  };

  // 起動し直した後の世代で、照らし合わせが済んでいない枠
  const isPending = (slot: number) => renumbered && !revertedSlots.has(slot) && !slotStates.has(slot);

  // ラベルを付けない枠か。戻した枠、照らし合わせが済んでいない枠、戻したラベルの枠
  const isUnlabeled = (slot: number) => {
    if (revertedSlots.has(slot) || isPending(slot)) return true;
    const label = slotLabels.get(slot);
    return label !== undefined && revertedLabels.has(label);
  };

  const assignLabel = (slot: number): string => {
    const label = `相手 ${letters(labelCount++)}`;
    slotLabels.set(slot, label);
    const centroid = slotCentroids.get(slot);
    if (centroid !== undefined) labelCentroids.set(label, centroid);
    return label;
  };

  const labelOf = (slot: number): string => slotLabels.get(slot) ?? assignLabel(slot);

  // 新しい枠の重心を、ラベルの重心に照らし合わせる。迷えば決めない（次の重心で照らし合わせ直す）。決めたら固定する
  const match = (slot: number, centroid: readonly number[]): void => {
    const similar: string[] = [];
    let farFromAll = true;
    for (const [label, other] of labelCentroids) {
      const value = cosine(centroid, other);
      if (value === undefined) continue;
      if (value >= LINK_MIN_SIMILARITY) similar.push(label);
      if (value >= NEW_LABEL_MAX_SIMILARITY) farFromAll = false;
    }
    if (similar.length > 1) return;
    const linked = similar[0];
    if (linked !== undefined) {
      if (revertedLabels.has(linked)) {
        revertedSlots.add(slot);
        observe?.({ type: "link", slot, result: "reverted", label: linked });
      } else {
        slotLabels.set(slot, linked);
        slotStates.set(slot, "linked");
        observe?.({ type: "link", slot, result: "linked", label: linked });
      }
    } else if (farFromAll) {
      slotStates.set(slot, "new");
      observe?.({ type: "link", slot, result: "new" });
    }
  };

  const onCentroid = (slot: number, centroid: readonly number[]): void => {
    if (!(norm(centroid) > 0)) return;
    slotCentroids.set(slot, centroid);
    if (revertedSlots.has(slot)) return;
    if (isPending(slot)) match(slot, centroid);
    // つないだ枠の重心では、ラベルの重心を動かさない（ラベルの重心は、そのラベルを振った枠のもの。つないだ枠の揺れで、別の枠の照らし合わせが変わらないように）
    const label = slotLabels.get(slot);
    if (label !== undefined && slotStates.get(slot) !== "linked") labelCentroids.set(label, centroid);
  };

  const isSettled = (r: SettledRemark) => settledTo >= r.end - EPSILON;

  // 規則を当てて出す。先に話した順にラベルを振る。ラベルを付けない枠の区間は、切り方には使い（隣の枠に寄せない）、ラベルだけ付けない
  const attribute = (r: SettledRemark): SettledRemark[] => {
    const cuts = splitBySpeaker(r, segments, rules);
    if (cuts.length > 1) observe?.({ type: "cut", pieces: cuts.length });
    return cuts.map(({ remark, slot }) => (slot === undefined || isUnlabeled(slot) ? remark : { ...remark, speaker: labelOf(slot) }));
  };

  // 保留の先頭から、揃った発言か時間切れの発言を出す
  const release = (): SettledRemark[] => {
    const out: SettledRemark[] = [];
    for (let head = held[0]; head !== undefined; head = held[0]) {
      if (isSettled(head.remark)) out.push(...attribute(head.remark));
      else if (rules.waitLimit && head.heldAt + SPEAKER_WAIT_MS <= clock) {
        observe?.({ type: "timeout" });
        out.push(head.remark);
      } else break;
      held.shift();
    }
    return out;
  };

  // 保留を待たずにすべて出す。揃っていれば規則を当て、揃っていなければ話者なし
  const flush = (): SettledRemark[] => held.splice(0).flatMap((h) => (isSettled(h.remark) ? attribute(h.remark) : [h.remark]));

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

    // ヘルパーの speaker / speaker-settled / speaker-mixed / speaker-centroid / speaker-off。確定した相手の区間は覚えるだけで、保留を出すのは確定済みの位置が進んだとき。
    // speaker-off では保留を話者なしですべて出す
    speaker(event: SpeakerLogEvent): SettledRemark[] {
      if (off) return [];
      if (event.type === "speaker-off") {
        off = true;
        provisional = [];
        incoming = [];
        return held.splice(0).map((h) => h.remark);
      }
      if (event.track !== "相手") return [];
      if (event.type === "speaker-mixed") {
        // 以降の発言に付けないだけ。出した発言は書き換えず、保留の発言も出さない（利用者には知らせない）。
        // ラベルも戻す（そのラベルにつないだ別の枠にも付けない）
        revertedSlots.add(event.slot);
        const label = slotLabels.get(event.slot);
        if (label !== undefined) revertedLabels.add(label);
        observe?.({ type: "mixed", slot: event.slot, ...(label === undefined ? {} : { label }) });
        return [];
      }
      if (event.type === "speaker-centroid") {
        // 判定だけ。発言を出すのは speaker-settled と時間切れ
        onCentroid(event.slot, event.centroid);
        return [];
      }
      if (event.type === "speaker-settled") {
        settledTo = Math.max(settledTo, event.to);
        provisional = incoming;
        incoming = [];
        return release();
      }
      see(event.slot);
      if (event.final) segments.push({ start: event.start, end: event.end, slot: event.slot });
      else incoming.push({ start: event.start, end: event.end, slot: event.slot });
      return [];
    },

    // ヘルパーを起動し直した（Sortformer の枠が振り直される）。前の世代の保留を出し切ってから、枠単位の状態を捨てる。
    // ラベル単位の状態と、音声の時計、speaker-off は残す。以降の枠は、重心を照らし合わせるまで話者なし
    restart(): SettledRemark[] {
      const out = flush();
      renumbered = true;
      segments = [];
      settledTo = Number.NEGATIVE_INFINITY;
      slotLabels = new Map();
      slotStates = new Map();
      slotCentroids = new Map();
      revertedSlots = new Set();
      provisional = [];
      incoming = [];
      seenSlots = [];
      return out;
    },

    // 字幕のための覗き。話者が決まるのを待っている発言（出す前なので、読むだけ）
    heldRemarks: (): SettledRemark[] => held.map((h) => h.remark),

    // 字幕のための覗き。確定した区間と、いまの仮の区間
    previewSegments: (): Segment[] => [...segments, ...provisional],

    // 字幕のための覗き。振ったラベルがあればそれを、無ければ「まだ振っていない枠の中で、初めて現れた順」の予想を返す。ラベルは振らない
    // （仮のラベルを発言に使わない。発言のラベルは、初めて話した順に labelOf だけが振る）。
    // 戻した枠・戻したラベル・照らし合わせが済んでいない枠は、以降の発言と同じく undefined（ラベルなし）
    previewLabel(slot: number): string | undefined {
      if (isUnlabeled(slot)) return undefined;
      const known = slotLabels.get(slot);
      if (known !== undefined) return known;
      const unassigned = seenSlots.filter((s) => !slotLabels.has(s) && !isUnlabeled(s));
      const rank = unassigned.indexOf(slot);
      return `相手 ${letters(labelCount + (rank < 0 ? unassigned.length : rank))}`;
    },

    // 発言に振ったラベル（名前を付けられるのはこれだけ。Issue #1026）。振った順。混入で戻したラベルも、起動し直しの後も含む。
    // previewLabel の予想や、区間が届いただけの枠は含めない
    labels: (): string[] => Array.from({ length: labelCount }, (_, n) => `相手 ${letters(n)}`),

    // 停止時。保留を待たずにすべて出す。揃っていれば規則を当て、揃っていなければ話者なし。状態は捨てない
    drain: flush,
  };
}
