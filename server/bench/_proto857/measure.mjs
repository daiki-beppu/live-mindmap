// PROTOTYPE（#857、使い捨て）— Jev・Clef-flash・Clef（本体）に同じ問いを同じ条件で投げ、答え・時間・usage を残す。
// op run --env-file=.env.op -- node measure.mjs <jev,clef-flash,clef> <in/role.jsonl> [in/node.jsonl ...]
//   CLOUDFLARE_ACCOUNT_ID も環境変数で渡す（値の場所は地図 #757 の Notes）
// - 1 問ずつ、選択肢の順を「そのまま」と「逆」の 2 通りで、モデルを順に回して呼ぶ（時間帯の差が 3 社に等しく乗るよう、並べて呼ばない）
// - 答えは out/<model>.jsonl に追記し、済んだ（問い・順）は飛ばす。日をまたいで続きから流せる
// - Workers AI の 1 日の無料枠が尽きたら、そのモデルだけ止めて他は続ける。他の失敗はすべて止める（「今どおり」に倒すと結果が混ざる）
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const [modelsArg, ...inputs] = process.argv.slice(2);
const models = modelsArg.split(",");
const TIMEOUT_MS = 10_000; // 時間切れの目安を測るので長めに取る
mkdirSync(`${here}out`, { recursive: true });

const done = new Map(models.map((m) => {
  const p = `${here}out/${m}.jsonl`;
  const keys = existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.id}/${r.order}`; }) : [];
  return [m, new Set(keys)];
}));
const exhausted = new Set();

async function call(model, row, order) {
  const keys = Object.keys(row.criteria);
  const criteria = Object.fromEntries((order === "rev" ? keys.reverse() : keys).map((k) => [k, row.criteria[k]]));
  const questions = { target: { type: "choice", instructions: row.instructions, criteria } };
  const jev = model === "jev";
  const url = jev ? "https://api.typesafe.ai/v1/systemone" : `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`;
  const token = jev ? process.env.TYPESAFE_API_KEY : process.env.CLOUDFLARE_API_TOKEN;
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: jev ? "jev-latest" : model, state: row.state, questions }),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) return { error: { status: res.status, body: text.slice(0, 400) }, ms };
  const b = jev ? JSON.parse(text) : JSON.parse(text).result;
  return { answer: b.answers.target, usage: b.usage, ms };
}

// 無料枠が尽きたときの応答（Workers AI は 429 か、errors に Neurons / allocation を返す）
const isQuota = (e) => e.status === 429 || /neuron|allocation|quota|limit/i.test(e.body);

const rows = inputs.flatMap((p) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)));
let n = 0;
for (const row of rows) {
  for (const order of ["fwd", "rev"]) {
    for (const model of models) {
      if (exhausted.has(model) || done.get(model).has(`${row.id}/${order}`)) continue;
      let r;
      try { r = await call(model, row, order); }
      catch (e) { console.error(`止めた: ${model} ${row.id}/${order} ${e.name}: ${e.message}`); process.exit(1); }
      if (r.error) {
        if (!model.startsWith("jev") && isQuota(r.error)) { exhausted.add(model); console.error(`枠切れ: ${model} ${row.id}/${order} ${r.error.status} ${r.error.body}`); continue; }
        console.error(`止めた: ${model} ${row.id}/${order} ${r.error.status} ${r.error.body}`); process.exit(1);
      }
      appendFileSync(`${here}out/${model}.jsonl`, JSON.stringify({ id: row.id, q: row.q, order, at: new Date().toISOString(), ...r }) + "\n");
      if (++n % 50 === 0) console.error(`${n} 回`);
    }
  }
}
console.error(`済み ${n} 回。枠切れ: ${[...exhausted].join(", ") || "なし"}`);
