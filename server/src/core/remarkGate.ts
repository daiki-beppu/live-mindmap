// 発言を出す直前の関所。同じトラックの発言どうしは会議の中の時刻（start/end）が重ならず、
// 出した本文と重なる分は出さない（Issue #186、GLOSSARY.md の「発言」）。
// settle.ts の 4 つの出口（due / final の 2 分岐 / drain）が、出す直前にここを通す。
// 時刻は呼び出し側が渡す start/end だけを見る。タイマー・now は使わない（ADR 0003）。
// settle.ts の SettledRemark と同じ形を Remark から直接組み立て、settle.ts への import は作らない（循環 import を避ける）。
import type { Remark } from "./remark.ts";
import { cutWords, type Word, type WordTime } from "./words.ts";

type GatedRemark = Omit<Remark, "id"> & { words?: readonly Word[]; wordTimes?: readonly WordTime[] };

// 比較のとき無視する文字（句読点と空白。order.md が列挙した集合）
const IGNORED = /[、。，．,.!?！？「」\s]/u;

// 比べるための本文（句読点・空白を除いたもの）。出す本文の切り出し位置はこれから導かず、
// 同じ数え方で元の本文を走査して決める（dropOverlap）。位置を 2 つの単位で持たない
function compact(text: string): string {
  let body = "";
  for (const c of text) if (!IGNORED.test(c)) body += c;
  return body;
}

// 元の本文から、頭の重なり分を落とす切る位置（UTF-16 コード単位）。overlap の単位は呼び出し側の k と同じ。
// 残りは「残す文字が overlap 分たまった次の残す文字」から始まるので、その手前の句読点・空白は残りに入らない。
// 本文と words は、この位置で同じように切る
function overlapEnd(text: string, overlap: number): number {
  let kept = 0;
  let i = 0;
  for (const c of text) {
    const keep = !IGNORED.test(c);
    if (keep && kept === overlap) break;
    if (keep) kept += c.length;
    i += c.length;
  }
  return i;
}

// 前の部分が書き換わった全文（「シ子ど」→「シ子度で」）を重なりとして扱うときの、許す食い違いの比率。
// 重なりの長さ j のうち、編集距離 D が floor(j × 比率) 以下のものだけを採る。1/4 は、j が 4 以上で 1 文字、8 以上で 2 文字の書き換えを許す
// （order.md の素材 jargon の「シ子ど」→「シ子度で」は j=6、D=1）。これより緩いと別の発言の偶然の一致を重なりと見誤る
const OVERLAP_TOLERANCE = 1 / 4;

// 直前の本文 prev の末尾（始まりは自由）と、新しい本文 next の頭 next[0..j) を、食い違いを許して突き合わせ、
// 重ねる長さ j（コードポイント数）を返す。j − 2·D が最大の j を選ぶ。採れる j が無ければ 0
function fuzzyOverlap(prev: readonly string[], next: readonly string[]): number {
  const w = prev.length + 1;
  const d = new Uint32Array((next.length + 1) * w); // d[i * w + c]: next[0..i) と、prev の c 文字目で終わる任意の始まりからの部分の編集距離
  for (let i = 1; i <= next.length; i++) {
    d[i * w] = i;
    for (let c = 1; c <= prev.length; c++) {
      const diag = d[(i - 1) * w + c - 1]! + (next[i - 1] === prev[c - 1] ? 0 : 1);
      d[i * w + c] = Math.min(diag, d[(i - 1) * w + c]! + 1, d[i * w + c - 1]! + 1);
    }
  }
  let best = 0;
  let bestScore = 0;
  for (let j = 1; j <= next.length; j++) {
    const distance = d[j * w + prev.length]!;
    const score = j - 2 * distance;
    if (distance <= Math.floor(j * OVERLAP_TOLERANCE) && score > bestScore) {
      best = j;
      bestScore = score;
    }
  }
  return best;
}

export function createRemarkGate() {
  // トラックごとの「直前に出した発言」。関所で落とした発言では更新しない
  const last = new Map<GatedRemark["track"], { end: number; text: string }>();

  // 出す直前の判断。出さない発言は undefined。状態は変えない（覚える値は remembered で返す）
  const judge = (r: GatedRemark): { emitted: GatedRemark; remembered: { end: number; text: string } } | undefined => {
    const prev = last.get(r.track);
    if (prev === undefined || r.start >= prev.end) {
      // 重なっていない: 本文も時刻もそのまま出す
      return { emitted: r, remembered: { end: r.end, text: r.text } };
    }
    const prevBody = compact(prev.text);
    const newBody = compact(r.text);
    // 直前の本文に丸ごと含まれる（newBody が空文字の場合も、空文字はどんな文字列にも含まれるのでここで弾かれる）
    if (prevBody.includes(newBody)) return undefined;

    // 直前の本文の末尾と、新しい本文の頭で重なる最長の部分の長さ。無ければ 0
    let k = 0;
    for (let candidate = Math.min(prevBody.length, newBody.length); candidate >= 1; candidate--) {
      if (prevBody.endsWith(newBody.slice(0, candidate))) {
        k = candidate;
        break;
      }
    }
    // 重なりの候補は 2 つ持つ。完全一致（UTF-16 単位）と、書き換わった前の部分を許す重なり（コードポイント単位）。
    // 完全一致が短くても、その先に書き換えを含む長い重なりがあれば既出の部分が混ざるので、長い方を採る。
    // 完全一致だけが持つ候補を残すのは、不対サロゲートとの比較で k がペアの途中を指す場合の、切り出し結果が空になる既存の扱いのため。
    // 抑制した発言で「直前」を更新しないため、切り出し後の本文を状態更新前に検証する。
    // 切る位置は、重ねたコードポイントの UTF-16 の長さ
    const j = fuzzyOverlap(Array.from(prevBody), Array.from(newBody));
    const fuzzy = Array.from(newBody).slice(0, j).reduce((n, c) => n + c.length, 0);
    k = Math.max(k, fuzzy);
    const at = k === 0 ? 0 : overlapEnd(r.text, k);
    const text = r.text.slice(at);
    if (compact(text) === "") return undefined;
    const start = prev.end;
    if (r.end <= start) return undefined;

    const emitted: GatedRemark = {
      ...r, start, text,
      ...(r.words === undefined || at === 0 ? {} : { words: cutWords(r.words, at) }),
      ...(r.wordTimes === undefined || at === 0 ? {} : { wordTimes: cutWords(r.wordTimes, at) }),
    };
    // 覚える本文は切る前の r.text。同じ始まりから全文を送り直す途中結果の頭と、前の全文が重なる
    return { emitted, remembered: { end: emitted.end, text: r.text } };
  };

  return {
    // 出す直前に通す。出さない発言は undefined を返す
    pass(r: GatedRemark): GatedRemark | undefined {
      const judged = judge(r);
      if (judged === undefined) return undefined;
      last.set(r.track, judged.remembered);
      return judged.emitted;
    },
    // pass と同じ判断を、「直前に出した発言」を更新せずに返す（字幕へ渡す途中結果のため。Issue #1222）
    preview(r: GatedRemark): GatedRemark | undefined {
      return judge(r)?.emitted;
    },
  };
}
