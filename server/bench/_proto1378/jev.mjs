// node jev.mjs tokens|pairs <model> <out.jsonl>
import { readFileSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
const [mode, model, out] = process.argv.slice(2);
const KEY = process.env.TYPESAFE_AI_API_KEY;
const DIR = `${process.env.HOME}/.live-mindmap/sessions/2026-10-09T11-59-57.947Z/screens`;
const Q = { type: "noul", instructions: "2 枚目は 1 枚目と比べて、共有されている資料の中身（文字・数字・表・図・スライド・ページ）が変わったか。資料が消えて参加者の顔だけになった・顔だけから資料が出た、も変わった。参加者の顔の表情や並び・話者の枠・カーソル・通知・時計だけの違いは変わっていない" };
async function call(state, assets) {
  const body = JSON.stringify({ model, state, questions: { changed: Q }, ...(assets ? { assets } : {}) });
  const t = performance.now();
  const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "TypeSafe-Danger-Zone-Images": "true" }, body });
  const b = await r.json(); const ms = performance.now() - t;
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b).slice(0, 300)}`);
  return { ms, p: b.answers.changed.noul, tokens: b.usage?.input_tokens, bytes: body.length };
}
const asset = (p) => ({ type: "image", format: "jpg", data_base64: readFileSync(p).toString("base64") });
writeFileSync(out, "");
const log = (o) => appendFileSync(out, JSON.stringify(o) + "\n");
if (mode === "tokens") {
  const base = await call("1 枚目は、直前に AI へ渡した会議アプリのウィンドウ。2 枚目は、いま映っているウィンドウ。1 枚目: (なし) 2 枚目: (なし)");
  log({ kind: "text", ...base });
  const files = readdirSync(DIR).filter((f) => f.endsWith(".jpg")).sort();
  const pick = [...files.filter((_, i) => i % 105 === 0), "0000.4.jpg"]; // 会議全体から約 12 枚と 553×720 の 1 枚
  for (const f of new Set(pick)) {
    const id = randomUUID();
    const a = await call(`1 枚目は、直前に AI へ渡した会議アプリのウィンドウ。2 枚目は、いま映っているウィンドウ。1 枚目: ${id} 2 枚目: (なし)`, { [id]: asset(`${DIR}/${f}`) });
    log({ kind: "one", file: f, ...a, image: a.tokens - base.tokens });
  }
} else {
  const rows = readFileSync(new URL("window.tsv", import.meta.url), "utf8").trim().split("\n").map((l) => l.split("\t")[1].replace(/^~/, process.env.HOME));
  for (let i = 1; i < rows.length; i++) {
    const a = randomUUID(), b = randomUUID();
    try {
      const r = await call(`1 枚目は、直前に AI へ渡した会議アプリのウィンドウ。2 枚目は、いま映っているウィンドウ。1 枚目: ${a} 2 枚目: ${b}`, { [a]: asset(rows[i - 1]), [b]: asset(rows[i]) });
      log({ kind: "pair", i, ...r });
    } catch (e) { log({ kind: "error", i, error: String(e.message ?? e) }); }
  }
}
