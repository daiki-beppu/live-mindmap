// PROTOTYPE（#768、使い捨て）— 共有画面の変化を 1 枚ずつ、直前に「添える」とした画面と並べて Clef に判定させる。
// node judge.mjs <clef-flash|clef> <screens.tsv> <out.jsonl> [min=0.3]
//   screens.tsv: start<TAB>画像のパス（null は共有なし）。時刻順
//   min 未満の「変わった」確率なら添えない（迷ったら添える）。失敗・時間切れは添える
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const [model, list, out, minArg] = process.argv.slice(2);
const MIN = Number(minArg ?? 0.3), TIMEOUT_MS = 5000;
const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`;
const dataUrl = (p) => `data:image/${p.endsWith(".png") ? "png" : "jpeg"};base64,` + readFileSync(p).toString("base64");
export const QUESTION = {
  type: "noul",
  instructions: "2 枚目は 1 枚目と比べて、共有されている資料の中身（文字・数字・表・図・スライド・ページ）が変わったか。資料が消えて参加者の顔だけになった・顔だけから資料が出た、も変わった。参加者の顔の表情や並び・話者の枠・カーソル・通知・時計だけの違いは変わっていない",
};
async function ask(prev, next) {
  const t = performance.now();
  const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, state: "1 枚目は、直前に AI へ渡した会議アプリのウィンドウ。2 枚目は、いま映っているウィンドウ。", images: [dataUrl(prev), dataUrl(next)], questions: { changed: QUESTION } }) });
  const b = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b.errors).slice(0, 200)}`);
  return { p: b.result.answers.changed.noul, ms: performance.now() - t, tokens: b.result.usage.input_tokens };
}
writeFileSync(out, "");
const rows = readFileSync(list, "utf8").trim().split("\n").map((l) => l.split("\t")).map(([s, p]) => ({ start: Number(s), path: p === "null" ? null : p }));
let kept = null; // 直前に添えた画面
for (const row of rows) {
  let rec; const against = kept?.start ?? null;
  if (row.path === null || kept === null || kept.path === null) rec = { keep: true, why: "比べない" }; // 共有なし・最初・共有なしの後はそのまま添える
  else {
    try { const a = await ask(kept.path, row.path); rec = { keep: a.p >= MIN, ...a }; }
    catch (e) { console.error(`止めた: ${row.start} ${e.message ?? e}`); process.exit(1); } // 試作では枠切れ・失敗で止める（添えるに倒すと結果が混ざる）
  }
  if (rec.keep) kept = row;
  appendFileSync(out, JSON.stringify({ start: row.start, image: row.path, against, ...rec }) + "\n");
}
