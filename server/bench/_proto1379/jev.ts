// PROTOTYPE（#1379、使い捨て）— 2 枚の画面を Jev に渡し、noul「資料の中身が変わったか」を聞く。答えは cache.jsonl に貯めて再利用する
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const KEY = process.env.TYPESAFE_AI_API_KEY;
if (!KEY) throw new Error("TYPESAFE_AI_API_KEY が無い");
const CACHE = new URL("cache.jsonl", import.meta.url);
// #768 の Clef 版と同じ問い（#1378 もこれで測った）
const Q = { type: "noul", instructions: "2 枚目は 1 枚目と比べて、共有されている資料の中身（文字・数字・表・図・スライド・ページ）が変わったか。資料が消えて参加者の顔だけになった・顔だけから資料が出た、も変わった。参加者の顔の表情や並び・話者の枠・カーソル・通知・時計だけの違いは変わっていない" };

export type Answer = { p: number; ms: number; tokens: number } | { error: string; ms: number };
const cache = new Map<string, Answer[]>();
if (existsSync(CACHE)) for (const l of readFileSync(CACHE, "utf8").trim().split("\n").filter(Boolean)) {
  const r = JSON.parse(l); const k = `${r.model}|${r.ref}|${r.img}`; cache.set(k, [...(cache.get(k) ?? []), r.answer]);
}

const asset = (p: string) => ({ type: "image", format: p.endsWith(".png") ? "png" : "jpg", data_base64: readFileSync(p).toString("base64") });

async function call(model: string, ref: string, img: string): Promise<Answer> {
  const a = randomUUID(), b = randomUUID();
  const body = JSON.stringify({ model, state: `1 枚目は、直前に AI へ渡した会議アプリのウィンドウ。2 枚目は、いま映っているウィンドウ。1 枚目: ${a} 2 枚目: ${b}`, questions: { changed: Q }, assets: { [a]: asset(ref), [b]: asset(img) } });
  const t = performance.now();
  try {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "TypeSafe-Danger-Zone-Images": "true" }, body });
    const j = await r.json(); const ms = performance.now() - t;
    if (!r.ok) return { error: `${r.status} ${JSON.stringify(j).slice(0, 200)}`, ms };
    return { p: j.answers.changed.noul, ms, tokens: j.usage?.input_tokens };
  } catch (e) { return { error: String((e as Error).message ?? e), ms: performance.now() - t }; }
}

// nth 回目の答え（0 始まり）。無ければ呼んで貯める。ばらつきを見るときは nth を上げる
export async function judge(model: string, ref: string, img: string, nth = 0): Promise<Answer> {
  const k = `${model}|${ref}|${img}`; const got = cache.get(k) ?? [];
  while (got.length <= nth) {
    const answer = await call(model, ref, img); got.push(answer); cache.set(k, got);
    if ("p" in answer) appendFileSync(CACHE, JSON.stringify({ model, ref, img, answer }) + "\n"); // 失敗は貯めない
  }
  return got[nth];
}
