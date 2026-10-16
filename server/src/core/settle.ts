// 途中結果（partial）が一定時間更新されなければ、最後の本文・区間で発言にする規則（Issue #99、調査 #97）。
// bench/sttLatency.ts は、この規則をそのまま通して発言の遅れを測る。
// 時計は届いた結果の end の最大値（会議の音声の時刻、ミリ秒）。壁時計は使わない。タイマーは持たない（中核は実行環境に依存しない。ADR 0003）。
// 結果が届くたびに「時計を進める（期限の順に、来た発話を出す）→ 入力を当てはめる」の順で処理するので、結果が届く間隔に出力が依らない。
// 加えて、文の終わり（。？！ ? !）までの本文が SETTLE_SENTENCE_MS 変わらなければ、そこまでを発言にする（Issue #996）。
// 途中結果から作る発言は、出した分（同じ発話、無ければ同じトラック）の記録と突き合わせ、出した分の後ろだけを次の発言にする。
import type { HelperPartial } from "./live.ts";
import { createRemarkGate } from "./remarkGate.ts";
import type { Remark } from "./remark.ts";
import { cutWords, keepWordsBefore, type Word, type WordTime } from "./words.ts";

export const SETTLE_QUIET_MS = 1000;
export const SETTLE_SENTENCE_MS = 50;

// ID は呼び出し側が push の直前に振る（捨てた確定結果が番号を消費しない）
// words と wordTimes は Remark に入れず、運ぶ型にだけ持つ（スナップショット・差分更新への入力に漏らさない）
export type SettledRemark = Omit<Remark, "id"> & { words?: readonly Word[]; wordTimes?: readonly WordTime[] };

const EPSILON = 1e-6;

// 文の終わりの文字の直後の位置（UTF-16）と、その位置の文の終わりが現れた時刻
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

// 発話の頭から pos までの発言。words・wordTimes は無ければキーも付けない
const toCutRemark = (u: Utterance, pos: number, emittedEnd: number): SettledRemark => ({
  track: u.track,
  start: u.start,
  end: cutEnd(u, pos, emittedEnd),
  text: u.text.slice(0, pos),
  ...(u.words === undefined ? {} : { words: keepWordsBefore(u.words, pos) }),
  ...(u.wordTimes === undefined ? {} : { wordTimes: keepWordsBefore(u.wordTimes, pos) }),
});

// 本文の頭 at コード単位を除いた結果。words・wordTimes も同じ位置で切る（無ければキーも付けない）
const cutHead = <R extends { readonly text: string; readonly words?: readonly Word[]; readonly wordTimes?: readonly WordTime[] }>(r: R, at: number): R => ({
  ...r, text: r.text.slice(at),
  ...(r.words === undefined ? {} : { words: cutWords(r.words, at) }),
  ...(r.wordTimes === undefined ? {} : { wordTimes: cutWords(r.wordTimes, at) }),
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

  // 出した分（同じ発話の記録を優先し、無ければトラックの記録）の後ろだけを返す。後ろが無ければ undefined。
  // 発言を出す経路（passCarried）と、字幕へ渡す途中結果（unemittedTail）が同じ規則で切るよう、ここ 1 か所に置く（Issue #1222）。
  // どちらも、この後にトラック全体の関所を通す（発言は gate.pass、字幕は gate.preview）。記録は進めない
  const afterEmitted = (key: string, r: SettledRemark): SettledRemark | undefined => {
    const sameUtterance = emittedByKey.get(key);
    const prev = sameUtterance ?? emittedByTrack.get(r.track);
    if (prev === undefined) return r;
    // 出した本文が新しい本文の途中に現れる（頭に挿入が入った）ときは、頭から出した本文の手前までを除く。
    // 関所と同じく句読点・空白を無視して比べる（出した文の句読点が変わっても見落とさない）。
    // 先頭に現れるときは切らず、関所の重なりに任せる（頭だけ書き換わった出した文の後ろまで捨てないため）
    const at = sameUtterance === undefined ? 0 : insertionEnd(r.text, sameUtterance.text);
    const carry = createRemarkGate();
    carry.pass({ track: r.track, start: prev.end, end: prev.end, text: prev.text });
    return carry.pass(at === 0 ? r : cutHead(r, at));
  };

  // 途中結果・確定結果を、出した分の後ろだけにして返す
  const passCarried = (key: string, r: SettledRemark): SettledRemark[] => {
    const carried = afterEmitted(key, r);
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

  // 音声の時計（ミリ秒）。届いた結果の end の最大値。戻らない
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

  // 時計を t まで進める。期限の順に一つずつ時計を進めて出す（一度に跳ぶと、先に出した分の記録の前に後の発話が出る）
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
    // 途中結果。自分は、ヘルパーの重複判定（確定結果にだけ行う）を通らないので、発言にしない。
    // 返すのは、この結果で時計が進んで期限の来た発言
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
        current.words = p.words; // text と同じ更新で置き換える（undefined でも代入し、古い words を残さない）
        current.wordTimes = p.wordTimes;
        current.lastAt = now;
        return out;
      }
      const next: Utterance = { track: p.track, start: p.start, end: p.end, text: p.text, words: p.words, wordTimes: p.wordTimes, lastAt: now, state: "open", ends: sentenceEnds(p.text).map((pos) => ({ pos, at: now })), cut: false, cutPos: 0 };
      utterances.push(next);
      latest.set(key, next);
      return out;
    },

    // 字幕へ渡す途中結果（Issue #1222）。発言を出すときと同じ規則で、もう発言になった分を除いた後ろだけにする。
    // 全部が発言になっていれば、本文・語・語の区間を空にして返す（そのトラックの途中結果は空として扱う）。状態は変えない。
    // 自分の途中結果は発言にならないので、そのまま返す
    unemittedTail(p: HelperPartial): HelperPartial {
      if (p.track === "自分") return p;
      const carried = afterEmitted(keyOf(p.track, p.start), p);
      // 発言を出すときと同じく、トラック全体の関所も通す（記録は進めない）
      const tail = carried === undefined ? undefined : gate.preview(carried);
      return tail === undefined ? cutHead(p, p.text.length) : { ...p, ...tail };
    },

    // 確定結果。返すのは、期限の来た発言に続けて、発言として出すもの
    final(r: SettledRemark): SettledRemark[] {
      const due = advance(r.end * 1000);
      if (r.track === "自分") return [...due, r];
      const covered = utterances.filter((u) => u.track === r.track && midpoint(u) >= r.start - EPSILON && midpoint(u) <= r.end + EPSILON);
      const alreadyOut = covered.some((u) => u.state === "emitted" || (u.state === "open" && u.cut));
      const pending = covered.filter((u) => u.state === "open");
      // 既に出した分（同じ発話、無ければ同じトラック）があれば、確定結果もその後ろだけを出す
      const out = alreadyOut ? pending.flatMap(release) : passCarried(keyOf(r.track, r.start), r);
      for (const u of covered) {
        u.state = "consumed";
        if (latest.get(keyOf(u.track, u.start)) === u) latest.delete(keyOf(u.track, u.start));
      }
      for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i]!.state === "consumed") utterances.splice(i, 1);
      return [...due, ...out];
    },

    // 停止時。まだ出ていない発話をすべて出す
    drain(): SettledRemark[] {
      return utterances.filter((u) => u.state === "open").flatMap(release);
    },
  };
}
