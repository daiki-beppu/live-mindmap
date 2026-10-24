import type { HelperPartial } from "./live.ts";
import { compact, createRemarkGate, overlapEnd, type SettledRemark } from "./remarkGate.ts";
import type { Remark } from "./remark.ts";
import { cutWords, keepWordsBefore, type Word, type WordTime } from "./words.ts";

export const SETTLE_QUIET_MS = 1000;
export const SETTLE_SENTENCE_MS = 50;

const EPSILON = 1e-6;

type SentenceEnd = { pos: number; at: number };
type Utterance = {
  track: Remark["track"];
  start: number;
  end: number;
  text: string;
  words: readonly Word[] | undefined;
  wordTimes: readonly WordTime[] | undefined;
  lastAt: number;
  state: "open" | "emitted" | "consumed";
  ends: SentenceEnd[];
  cut: boolean;
  cutPos: number;
};

const SENTENCE_END = /[。？！?!]/;

const insertionEnd = (text: string, emitted: string): number => {
  const p = compact(text).indexOf(compact(emitted));
  return p <= 0 ? 0 : overlapEnd(text, p);
};

const keyOf = (track: string, start: number) => `${track}\u0000${start}`;
// 途中結果の区間は確定結果の区間と端がずれるので、発話の区間の中央が確定結果の区間に入るかで覆いを決める
const midpoint = (u: Utterance) => (u.start + u.end) / 2;
const toRemark = (u: Utterance): SettledRemark => ({
  track: u.track, start: u.start, end: u.end, text: u.text,
  ...(u.words === undefined ? {} : { words: u.words }),
  ...(u.wordTimes === undefined ? {} : { wordTimes: u.wordTimes }),
});

const sentenceEnds = (text: string): number[] => {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) if (SENTENCE_END.test(text[i]!)) positions.push(i + 1);
  return positions;
};

const commonPrefixLength = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

const updateEnds = (u: Utterance, text: string, now: number): SentenceEnd[] => {
  const prefix = commonPrefixLength(u.text, text);
  const fresh = sentenceEnds(text).filter((pos) => pos > prefix).map((pos) => ({ pos, at: now }));
  return [...u.ends.filter((e) => e.pos <= prefix), ...fresh];
};

const settledPosition = (u: Utterance, now: number): number | undefined => {
  let best: number | undefined;
  for (const e of u.ends) if (e.at + SETTLE_SENTENCE_MS <= now && (best === undefined || e.pos > best)) best = e.pos;
  return best;
};

const cutEnd = (u: Utterance, pos: number, emittedEnd: number): number => {
  const proportional = u.start + ((u.end - u.start) * pos) / u.text.length;
  if (proportional > emittedEnd || u.end <= emittedEnd) return proportional;
  return emittedEnd + ((u.end - emittedEnd) * (pos - u.cutPos)) / (u.text.length - u.cutPos);
};

const toCutRemark = (u: Utterance, pos: number, emittedEnd: number): SettledRemark => ({
  track: u.track,
  start: u.start,
  end: cutEnd(u, pos, emittedEnd),
  text: u.text.slice(0, pos),
  ...(u.words === undefined ? {} : { words: keepWordsBefore(u.words, pos) }),
  ...(u.wordTimes === undefined ? {} : { wordTimes: keepWordsBefore(u.wordTimes, pos) }),
});

const cutHead = <R extends { readonly text: string; readonly words?: readonly Word[]; readonly wordTimes?: readonly WordTime[] }>(r: R, at: number): R => ({
  ...r, text: r.text.slice(at),
  ...(r.words === undefined ? {} : { words: cutWords(r.words, at) }),
  ...(r.wordTimes === undefined ? {} : { wordTimes: cutWords(r.wordTimes, at) }),
});

export function createRemarkSettler(quietMs: number = SETTLE_QUIET_MS) {
  const utterances: Utterance[] = [];
  const latest = new Map<string, Utterance>();
  const gate = createRemarkGate();

  type Emitted = { end: number; text: string };
  const emittedByKey = new Map<string, Emitted>();
  const emittedByTrack = new Map<Remark["track"], Emitted>();

  const afterEmitted = (key: string, r: SettledRemark): SettledRemark | undefined => {
    const sameUtterance = emittedByKey.get(key);
    const prev = sameUtterance ?? emittedByTrack.get(r.track);
    if (prev === undefined) return r;
    const at = sameUtterance === undefined ? 0 : insertionEnd(r.text, sameUtterance.text);
    const carry = createRemarkGate();
    carry.pass({ track: r.track, start: prev.end, end: prev.end, text: prev.text });
    return carry.pass(at === 0 ? r : cutHead(r, at));
  };

  const passCarried = (key: string, r: SettledRemark): SettledRemark[] => {
    const carried = afterEmitted(key, r);
    if (carried === undefined) return [];
    const passed = gate.pass(carried);
    if (passed === undefined) return [];
    const record = { end: passed.end, text: r.text };
    emittedByKey.set(key, record);
    emittedByTrack.set(r.track, record);
    return [passed];
  };

  const finish = (u: Utterance) => {
    u.state = "emitted";
    if (latest.get(keyOf(u.track, u.start)) === u) latest.delete(keyOf(u.track, u.start));
  };

  const release = (u: Utterance): SettledRemark[] => {
    finish(u);
    return passCarried(keyOf(u.track, u.start), toRemark(u));
  };

  const releaseSentence = (u: Utterance, pos: number): SettledRemark[] => {
    u.ends = u.ends.filter((e) => e.pos > pos);
    const key = keyOf(u.track, u.start);
    const out = passCarried(key, toCutRemark(u, pos, emittedByKey.get(key)?.end ?? u.start));
    u.cut = true;
    u.cutPos = pos;
    if (pos === u.text.length) finish(u);
    return out;
  };

  let clock = 0;

  const dueUtterance = (u: Utterance, now: number): SettledRemark[] => {
    if (u.state !== "open") return [];
    if (u.lastAt + quietMs <= now) return release(u);
    const pos = settledPosition(u, now);
    return pos === undefined ? [] : releaseSentence(u, pos);
  };

  const nextDue = (): number | undefined => {
    let min: number | undefined;
    const consider = (t: number) => {
      if (min === undefined || t < min) min = t;
    };
    for (const u of utterances) {
      if (u.state !== "open") continue;
      consider(u.lastAt + quietMs);
      for (const e of u.ends) consider(e.at + SETTLE_SENTENCE_MS);
    }
    return min;
  };

  const advance = (t: number): SettledRemark[] => {
    const out: SettledRemark[] = [];
    for (let d = nextDue(); d !== undefined && d <= t; d = nextDue()) {
      clock = Math.max(clock, d);
      out.push(...utterances.flatMap((u) => dueUtterance(u, clock)));
    }
    clock = Math.max(clock, t);
    return out;
  };

  return {
    partial(p: HelperPartial): SettledRemark[] {
      const out = advance(p.end * 1000);
      if (p.track === "自分") return out;
      const key = keyOf(p.track, p.start);
      const current = latest.get(key);
      const now = clock;
      if (current && current.state === "open") {
        current.ends = updateEnds(current, p.text, now);
        current.end = p.end;
        current.text = p.text;
        current.words = p.words;
        current.wordTimes = p.wordTimes;
        current.lastAt = now;
        return out;
      }
      const next: Utterance = { track: p.track, start: p.start, end: p.end, text: p.text, words: p.words, wordTimes: p.wordTimes, lastAt: now, state: "open", ends: sentenceEnds(p.text).map((pos) => ({ pos, at: now })), cut: false, cutPos: 0 };
      utterances.push(next);
      latest.set(key, next);
      return out;
    },

    unemittedTail(p: HelperPartial): HelperPartial {
      if (p.track === "自分") return p;
      const carried = afterEmitted(keyOf(p.track, p.start), p);
      const tail = carried === undefined ? undefined : gate.preview(carried);
      return tail === undefined ? cutHead(p, p.text.length) : { ...p, ...tail };
    },

    final(r: SettledRemark): SettledRemark[] {
      const due = advance(r.end * 1000);
      if (r.track === "自分") return [...due, r];
      const covered = utterances.filter((u) => u.track === r.track && midpoint(u) >= r.start - EPSILON && midpoint(u) <= r.end + EPSILON);
      const alreadyOut = covered.some((u) => u.state === "emitted" || (u.state === "open" && u.cut));
      const pending = covered.filter((u) => u.state === "open");
      const out = alreadyOut ? pending.flatMap(release) : passCarried(keyOf(r.track, r.start), r);
      for (const u of covered) {
        u.state = "consumed";
        if (latest.get(keyOf(u.track, u.start)) === u) latest.delete(keyOf(u.track, u.start));
      }
      for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i]!.state === "consumed") utterances.splice(i, 1);
      return [...due, ...out];
    },

    drain(): SettledRemark[] {
      return utterances.filter((u) => u.state === "open").flatMap(release);
    },
  };
}
