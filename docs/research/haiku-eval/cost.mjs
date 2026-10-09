// 使い捨て（issue #614）。metrics.jsonl から、遅れ・トークン・料金（usage × 公式単価）を出す。
// 使い方: node cost.mjs <runs dir> <name>...      … ランごとの表
//         node cost.mjs <runs dir> --calls <name>... … API の要求ごとの内訳（TSV）
//
// トークンの出どころ:
// - result.usage.iterations は差分更新 1 回の「最後の」要求しか持たない（num_turns=3 の回は要求が 2 回走る）。
// - 要求ごとの入力側（input・cache_read・cache_creation）は、assistant メッセージの message.usage（要求の始まりの値。message.id で重複を除く）から取る。
// - 出力は、最後の要求を iterations から、それより前の要求を modelUsage（query ごとの累計）の差分の残りから取る。
import { readFileSync } from "node:fs";

// $/MTok。Haiku 5.5 は 1 回の要求の入力（キャッシュの読み書きを含む）が 10 万を超えると hi の表
const PRICE = {
  "claude-sonnet-5-5": { lo: { in: 2, out: 10, w5m: 2.5, w1h: 4, read: 0.1 } },
  "claude-haiku-5-5": {
    lo: { in: 0.1, out: 0.5, w5m: 0.125, w1h: 0.2, read: 0.01 },
    hi: { in: 0.5, out: 2.5, w5m: 0.625, w1h: 1, read: 0.05 },
  },
};
const LIMIT = 100_000;

const args = process.argv.slice(2);
const dir = args.shift();
const callsMode = args[0] === "--calls";
const names = callsMode ? args.slice(1) : args;

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const k = (n) => (n / 1000).toFixed(1) + "k";
const sumMU = (mu, model) => Object.entries(mu ?? {}).filter(([n]) => model === undefined || n === model).map(([, m]) => m).reduce((a, m) => ({
  in: a.in + m.inputTokens, out: a.out + m.outputTokens, think: a.think + (m.thinkingTokens ?? 0),
  read: a.read + m.cacheReadInputTokens, write: a.write + m.cacheCreationInputTokens,
}), { in: 0, out: 0, think: 0, read: 0, write: 0 });

const reqCost = (model, r) => {
  const prompt = r.in + r.read + r.write;
  const over = prompt > LIMIT;
  const p = over && PRICE[model].hi ? PRICE[model].hi : PRICE[model].lo;
  return { prompt, over, usd: (r.in * p.in + r.out * p.out + r.w5 * p.w5m + r.w1 * p.w1h + r.read * p.read) / 1e6 };
};

if (!callsMode) console.log("| ラン | 差分更新 | API の要求 | 失敗 | 不正な出力 | 開き直し | 1 回の秒数（中央 / 最大） | 入力 | 読み出し | 書き込み | 出力（うち thinking） | 10 万超の要求 | 料金（usage×単価） | 補助（Haiku 4.5） | total_cost_usd（参考） |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const name of names) {
  const recs = readFileSync(`${dir}/${name}.metrics.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const model = recs[0].model;
  const otherModels = new Set();
  const tot = { in: 0, out: 0, think: 0, read: 0, write: 0 };
  const aux = { in: 0, out: 0, usd: 0 };
  let nreq = 0, over = 0, usd = 0, maxPrompt = 0, sdkCost = 0, opens = 0, prev = sumMU({}), mismatch = 0;
  if (callsMode) console.log(`# ${name}（${model}）\ncall\treq\tsec\tinput\tcache_read\tcache_write\toutput\tprompt\tover100k\tusd`);
  recs.forEach((r, i) => {
    if (r.calls === 0) { opens++; prev = sumMU({}); }
    for (const m of Object.keys(r.modelUsage ?? {})) if (m !== model) otherModels.add(m);
    const lastOfQuery = recs[i + 1] === undefined || recs[i + 1].calls === 0;
    if (r.total_cost_usd !== undefined && lastOfQuery) sdkCost += r.total_cost_usd;
    // Claude Code が query ごとに足す補助の呼び出し（Haiku 4.5。$1 / $5）は別に数える
    if (lastOfQuery) for (const [n, m] of Object.entries(r.modelUsage ?? {})) if (n !== model) { aux.in += m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens; aux.out += m.outputTokens; aux.usd += (m.inputTokens * 1 + m.cacheCreationInputTokens * 1.25 + m.cacheReadInputTokens * 0.1 + m.outputTokens * 5) / 1e6; }
    if (!r.modelUsage) return;
    const cur = sumMU(r.modelUsage, model);
    const d = Object.fromEntries(Object.keys(cur).map((x) => [x, cur[x] - prev[x]]));
    prev = cur;
    for (const x of Object.keys(d)) tot[x] += d[x];
    const last = r.usage.iterations.at(-1);
    const reqs = r.requests.map((q, j) => {
      const isLast = j === r.requests.length - 1;
      return {
        in: q.input_tokens, read: q.cache_read_input_tokens, write: q.cache_creation_input_tokens,
        w5: q.cache_creation?.ephemeral_5m_input_tokens ?? q.cache_creation_input_tokens, w1: q.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        out: isLast ? last.output_tokens : NaN,
      };
    });
    // 最後でない要求の出力は、差分の出力から最後の分を引いた残りを等分する（2 回のときは 1 つ）
    const rest = (d.out - last.output_tokens) / Math.max(1, reqs.length - 1);
    for (const q of reqs) if (Number.isNaN(q.out)) q.out = rest;
    // 入力側の合計が modelUsage の差分と合うかを検算する
    const sIn = reqs.reduce((a, q) => a + q.in + q.read + q.write, 0);
    if (sIn !== d.in + d.read + d.write) mismatch++;
    reqs.forEach((q, j) => {
      const c = reqCost(model, q);
      nreq++; if (c.over) over++; maxPrompt = Math.max(maxPrompt, c.prompt); usd += c.usd;
      if (callsMode) console.log([i + 1, j + 1, (r.ms / 1000).toFixed(1), q.in, q.read, q.write, q.out, c.prompt, c.over ? 1 : 0, c.usd.toFixed(5)].join("\t"));
    });
  });
  if (callsMode) continue;
  const ok = recs.filter((r) => r.kind === "success");
  const invalid = ok.filter((r) => r.valid === false).length;
  const secs = ok.map((r) => r.ms / 1000);
  console.log(`| ${name} | ${recs.length} | ${nreq} | ${recs.length - ok.length} | ${invalid} | ${opens - 1} | ${median(secs).toFixed(1)} / ${Math.max(...secs).toFixed(1)} | ${k(tot.in)} | ${k(tot.read)} | ${k(tot.write)} | ${k(tot.out)}（${k(tot.think)}） | ${over}（最大 ${k(maxPrompt)}） | $${usd.toFixed(3)} | ${k(aux.in)}/${aux.out} $${aux.usd.toFixed(3)} | $${sdkCost.toFixed(3)} |${mismatch ? ` 検算ずれ ${mismatch}` : ""}`);
}
