// 発言を出す直前の関所。同じトラックの発言どうしは会議の中の時刻（start/end）が重ならず、
// 出した本文と重なる分は出さない（Issue #186、GLOSSARY.md の「発言」）。
// settle.ts の 4 つの出口（due / final の 2 分岐 / drain）が、出す直前にここを通す。
// 時刻は呼び出し側が渡す start/end だけを見る。タイマー・now は使わない（ADR 0003）。
// settle.ts の SettledRemark と同じ形を Remark から直接組み立て、settle.ts への import は作らない（循環 import を避ける）。
import type { Remark } from "./session.ts";

type GatedRemark = Omit<Remark, "id">;

// 比較のとき無視する文字（句読点と空白。order.md が列挙した集合）
const IGNORED = /[、。，．,.!?！？「」\s]/u;

// 比べるための本文（句読点・空白を除いたもの）。出す本文の切り出し位置はこれから導かず、
// 同じ数え方で元の本文を走査して決める（dropOverlap）。位置を 2 つの単位で持たない
function compact(text: string): string {
  let body = "";
  for (const c of text) if (!IGNORED.test(c)) body += c;
  return body;
}

// 元の本文から、頭の重なり分を落とした残り。overlap の単位は呼び出し側の k と同じ UTF-16 コード単位。
// 残りは「残す文字が overlap 分たまった次の残す文字」から始まるので、その手前の句読点・空白は残りに入らない
function dropOverlap(text: string, overlap: number): string {
  let kept = 0;
  let i = 0;
  for (const c of text) {
    const keep = !IGNORED.test(c);
    if (keep && kept === overlap) break;
    if (keep) kept += c.length;
    i += c.length;
  }
  return text.slice(i);
}

export function createRemarkGate() {
  // トラックごとの「直前に出した発言」。関所で落とした発言では更新しない
  const last = new Map<GatedRemark["track"], { end: number; text: string }>();

  return {
    // 出す直前に通す。出さない発言は undefined を返す
    pass(r: GatedRemark): GatedRemark | undefined {
      const prev = last.get(r.track);
      if (prev === undefined || r.start >= prev.end) {
        // 重なっていない: 本文も時刻もそのまま出す
        last.set(r.track, { end: r.end, text: r.text });
        return r;
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
      // 不対サロゲートとの比較では k がペアの途中を指し、切り出し結果が空になることがある。
      // 抑制した発言で「直前」を更新しないため、切り出し後の本文を状態更新前に検証する。
      const text = k === 0 ? r.text : dropOverlap(r.text, k);
      if (compact(text) === "") return undefined;
      const start = prev.end;
      if (r.end <= start) return undefined;

      const emitted: GatedRemark = { ...r, start, text };
      last.set(r.track, { end: emitted.end, text: emitted.text });
      return emitted;
    },
  };
}
