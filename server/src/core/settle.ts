// 途中結果（partial）が一定時間更新されなければ、最後の本文・区間で発言にする規則（Issue #99、調査 #97。
// 参照実装は bench/sttLatency.ts の settleVolatile、lateFinal: "discard"）。
// 時刻は呼び出し側が渡す（ミリ秒）。タイマーは持たない（中核は実行環境に依存しない。ADR 0003）。
// 加えて、文の終わり（。？！ ? !）までの本文が SETTLE_SENTENCE_MS 変わらなければ、そこまでを発言にする（Issue #996）。
// 途中結果から作る発言は、出した分（同じ発話、無ければ同じトラック）の記録と突き合わせ、出した分の後ろだけを次の発言にする。
import type { HelperPartial } from "./live.ts";
import { createRemarkGate } from "./remarkGate.ts";
import type { Remark } from "./remark.ts";
import { cutWords, type Word } from "./words.ts";

export const SETTLE_QUIET_MS = 1000;
export const SETTLE_SENTENCE_MS = 50;

// ID は呼び出し側が push の直前に振る（捨てた確定結果が番号を消費しない）
// words は Remark に入れず、運ぶ型にだけ持つ（スナップショット・差分更新への入力に漏らさない）
export type SettledRemark = Omit<Remark, "id"> & { words?: readonly Word[] };

const EPSILON = 1e-6;

// 文の終わりの文字の直後の位置（UTF-16）と、その位置の文の終わりが現れた時刻
type SentenceEnd = { pos: number; at: number };
type Utterance = {
  track: Remark["track"];
  start: number;
  end: number;
  text: string;
  words: readonly Word[] | undefined;
  lastAt: number;
  state: "open" | "emitted" | "consumed";
  ends: SentenceEnd[]; // まだ出していない文の終わり
  cut: boolean; // 文の終わりまでを出した（残りが open のまま残っている）
  cutPos: number; // 文の終わりの経路で出した本文の長さ
};

const SENTENCE_END = /[。？！?!]/;

// 比較のとき無視する文字。remarkGate.ts の IGNORED と同じ集合（関所は変えないので export を共有できず、ここに複製する。
// 食い違うと、挿入の検出と関所で比べ方がずれる）
const IGNORED = /[、。，．,.!?！？「」\s]/u;

// 出した本文 emitted（句読点・空白を除いた形）が text（同じ形）の途中（先頭以外）に最初に現れるとき、
// その出現の先頭の文字の text 上の位置（UTF-16）を返す。先頭に現れる・現れないときは 0。数え方は remarkGate.ts の compact・overlapEnd と同じ
const insertionEnd = (text: string, emitted: string): number => {
  const compactOf = (t: string) => Array.from(t).filter((c) => !IGNORED.test(c)).join("");
  const p = compactOf(text).indexOf(compactOf(emitted));
  if (p <= 0) return 0;
  let kept = 0;
  let i = 0;
  for (const c of text) {
    const keep = !IGNORED.test(c);
    if (keep && kept === p) break;
    if (keep) kept += c.length;
    i += c.length;
  }
  return i;
};

const keyOf = (track: string, start: number) => `${track}\u0000${start}`;
// 途中結果の区間は確定結果の区間と端がずれるので、発話の区間の中央が確定結果の区間に入るかで覆いを決める
const midpoint = (u: Utterance) => (u.start + u.end) / 2;
const toRemark = (u: Utterance): SettledRemark => ({ track: u.track, start: u.start, end: u.end, text: u.text, ...(u.words === undefined ? {} : { words: u.words }) });

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

// 本文が変わっても変わらない頭にある文の終わりは時刻ごと残し、それより後ろは今の本文で取り直す
const updateEnds = (u: Utterance, text: string, now: number): SentenceEnd[] => {
  const prefix = commonPrefixLength(u.text, text);
  const fresh = sentenceEnds(text).filter((pos) => pos > prefix).map((pos) => ({ pos, at: now }));
  return [...u.ends.filter((e) => e.pos <= prefix), ...fresh];
};

// 落ち着いた文の終わりのうち、最後のものの位置
const settledPosition = (u: Utterance, now: number): number | undefined => {
  let best: number | undefined;
  for (const e of u.ends) if (e.at + SETTLE_SENTENCE_MS <= now && (best === undefined || e.pos > best)) best = e.pos;
  return best;
};

// 文の終わりまでの発言の end。区間を文字の位置で比例配分する（u.end のままだと、後で残りを出すとき関所の r.end <= start で落ちる）。
// 本文が延びて割合が小さくなり、出した end を戻してしまうときは、出した end から u.end までを残りの文字で配分し直す（関所で落ちないよう単調に進める）
const cutEnd = (u: Utterance, pos: number, emittedEnd: number): number => {
  const proportional = u.start + ((u.end - u.start) * pos) / u.text.length;
  if (proportional > emittedEnd || u.end <= emittedEnd) return proportional;
  return emittedEnd + ((u.end - emittedEnd) * (pos - u.cutPos)) / (u.text.length - u.cutPos);
};

// 発話の頭から pos までの発言。words は無ければキーも付けない
const toCutRemark = (u: Utterance, pos: number, emittedEnd: number): SettledRemark => ({
  track: u.track,
  start: u.start,
  end: cutEnd(u, pos, emittedEnd),
  text: u.text.slice(0, pos),
  ...(u.words === undefined ? {} : { words: u.words.filter((w) => w.location + w.length <= pos) }),
});

export function createRemarkSettler(quietMs: number = SETTLE_QUIET_MS) {
  const utterances: Utterance[] = []; // 作った順。覆われて使い終わったもの（consumed）は除く
  const latest = new Map<string, Utterance>(); // 同じトラック・start で、更新を受け付けられる発話
  const gate = createRemarkGate(); // 出す直前の関所（Issue #186）。settler の寿命にわたって「直前に出した発言」を持つ

  // 最後に出した発言の end と、切る前の全文。同じ発話（トラック・start）ごとと、トラックごとに持つ。settler の寿命にわたって持つ。
  // 記録は発言を出したときだけ進める（出す直前の関所が捨てた候補では進めない）
  type Emitted = { end: number; text: string };
  const emittedByKey = new Map<string, Emitted>();
  const emittedByTrack = new Map<Remark["track"], Emitted>();

  // 途中結果・確定結果を、出した分の後ろだけにして返す。比べる相手は同じ発話の記録を優先し、無ければトラックの記録
  const passCarried = (key: string, r: SettledRemark): SettledRemark[] => {
    const sameUtterance = emittedByKey.get(key);
    const prev = sameUtterance ?? emittedByTrack.get(r.track);
    let candidate = r;
    const carry = createRemarkGate();
    if (prev !== undefined) {
      // 出した本文が新しい本文の途中に現れる（頭に挿入が入った）ときは、頭から出した本文の手前までを除く。
      // 関所と同じく句読点・空白を無視して比べる（出した文の句読点が変わっても見落とさない）。
      // 先頭に現れるときは切らず、関所の重なりに任せる（頭だけ書き換わった出した文の後ろまで捨てないため）
      const at = sameUtterance === undefined ? 0 : insertionEnd(r.text, sameUtterance.text);
      if (at > 0) candidate = { ...r, text: r.text.slice(at), ...(r.words === undefined ? {} : { words: cutWords(r.words, at) }) };
      carry.pass({ track: r.track, start: prev.end, end: prev.end, text: prev.text });
    }
    const carried = carry.pass(candidate);
    if (carried === undefined) return [];
    // 出す直前の関所（トラック全体）が最後の判断。関所が捨てた候補では記録を進めない
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

  // 落ち着いた文の終わりまでを出す。本文の最後まで出したら、発話は使い終える
  const releaseSentence = (u: Utterance, pos: number): SettledRemark[] => {
    u.ends = u.ends.filter((e) => e.pos > pos);
    const key = keyOf(u.track, u.start);
    const out = passCarried(key, toCutRemark(u, pos, emittedByKey.get(key)?.end ?? u.start));
    u.cut = true;
    u.cutPos = pos;
    if (pos === u.text.length) finish(u);
    return out;
  };

  const dueUtterance = (u: Utterance, now: number): SettledRemark[] => {
    if (u.state !== "open") return [];
    if (u.lastAt + quietMs <= now) return release(u);
    const pos = settledPosition(u, now);
    return pos === undefined ? [] : releaseSentence(u, pos);
  };

  return {
    // 途中結果。自分は、ヘルパーの重複判定（確定結果にだけ行う）を通らないので、発言にしない
    partial(p: HelperPartial, now: number): void {
      if (p.track === "自分") return;
      const key = keyOf(p.track, p.start);
      const current = latest.get(key);
      if (current && current.state === "open" && now - current.lastAt <= quietMs) {
        current.ends = updateEnds(current, p.text, now);
        current.end = p.end;
        current.text = p.text;
        current.words = p.words; // text と同じ更新で置き換える（undefined でも代入し、古い words を残さない）
        current.lastAt = now;
        return;
      }
      const next: Utterance = { track: p.track, start: p.start, end: p.end, text: p.text, words: p.words, lastAt: now, state: "open", ends: sentenceEnds(p.text).map((pos) => ({ pos, at: now })), cut: false, cutPos: 0 };
      utterances.push(next);
      latest.set(key, next);
    },

    // 確定結果。返すのは、発言として出すもの
    final(r: SettledRemark, now: number): SettledRemark[] {
      if (r.track === "自分") return [r];
      const covered = utterances.filter((u) => u.track === r.track && midpoint(u) >= r.start - EPSILON && midpoint(u) <= r.end + EPSILON);
      const alreadyOut = covered.some((u) => u.state === "emitted" || (u.state === "open" && (u.cut || u.lastAt + quietMs < now)));
      const pending = covered.filter((u) => u.state === "open");
      // 既に出した分（同じ発話、無ければ同じトラック）があれば、確定結果もその後ろだけを出す
      const out = alreadyOut ? pending.flatMap(release) : passCarried(keyOf(r.track, r.start), r);
      for (const u of covered) {
        u.state = "consumed";
        if (latest.get(keyOf(u.track, u.start)) === u) latest.delete(keyOf(u.track, u.start));
      }
      for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i]!.state === "consumed") utterances.splice(i, 1);
      return out;
    },

    // T 経った発話を出す
    due(now: number): SettledRemark[] {
      return utterances.flatMap((u) => dueUtterance(u, now));
    },

    // 次に出す時刻。なければ undefined
    nextDue(): number | undefined {
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
    },

    // 停止時。まだ出ていない発話をすべて出す
    drain(): SettledRemark[] {
      return utterances.filter((u) => u.state === "open").flatMap(release);
    },
  };
}
