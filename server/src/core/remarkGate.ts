import type { Remark } from "./remark.ts";
import { cutWords, type Word, type WordTime } from "./words.ts";

type GatedRemark = Omit<Remark, "id"> & { words?: readonly Word[]; wordTimes?: readonly WordTime[] };

const IGNORED = /[、。，．,.!?！？「」\s]/u;

export function compact(text: string): string {
  let body = "";
  for (const c of text) if (!IGNORED.test(c)) body += c;
  return body;
}

export function overlapEnd(text: string, overlap: number): number {
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

const OVERLAP_TOLERANCE = 1 / 4;

function fuzzyOverlap(prev: readonly string[], next: readonly string[]): number {
  const w = prev.length + 1;
  const d = new Uint32Array((next.length + 1) * w);
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
  const last = new Map<GatedRemark["track"], { end: number; text: string }>();

  const judge = (r: GatedRemark): { emitted: GatedRemark; remembered: { end: number; text: string } } | undefined => {
    const prev = last.get(r.track);
    if (prev === undefined || r.start >= prev.end) {
      return { emitted: r, remembered: { end: r.end, text: r.text } };
    }
    const prevBody = compact(prev.text);
    const newBody = compact(r.text);
    if (prevBody.includes(newBody)) return undefined;

    let k = 0;
    for (let candidate = Math.min(prevBody.length, newBody.length); candidate >= 1; candidate--) {
      if (prevBody.endsWith(newBody.slice(0, candidate))) {
        k = candidate;
        break;
      }
    }
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
    return { emitted, remembered: { end: emitted.end, text: r.text } };
  };

  return {
    pass(r: GatedRemark): GatedRemark | undefined {
      const judged = judge(r);
      if (judged === undefined) return undefined;
      last.set(r.track, judged.remembered);
      return judged.emitted;
    },
    preview(r: GatedRemark): GatedRemark | undefined {
      return judge(r)?.emitted;
    },
  };
}
