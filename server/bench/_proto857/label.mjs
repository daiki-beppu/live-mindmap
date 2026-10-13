// PROTOTYPE（#857、使い捨て）— 役割 8 択の正解を Claude（Sonnet 5.5）に付けてもらう。
// env -u ANTHROPIC_API_KEY node label.mjs → in/role.truth.json（{ id: 役割 }）。Claude Code のサブスクで呼ぶ
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const here = new URL(".", import.meta.url).pathname;
const rows = readFileSync(`${here}in/role.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const roles = JSON.parse(readFileSync(`${here}in/roles.json`, "utf8"));
const prompt = [
  "会議の文字起こし（音声認識なので誤字がある）の発言に、役割を 1 つずつ付けてください。",
  "役割（キー: 説明）:",
  ...Object.entries(roles).map(([k, d]) => `- ${k}: ${d}`),
  "各項目は「直前の発言」（文脈）と「判定する発言」からなります。役割を付けるのは「判定する発言」だけです。",
  'JSON のオブジェクト {"<項目の id>": "<役割のキー>", ...} だけを返してください。前置き・コードブロックは不要です。',
  "",
  ...rows.map((r) => `## ${r.id}\n${r.state}\n`),
].join("\n");
const out = execFileSync("claude", ["-p", "--model", "claude-sonnet-5-5", "--output-format", "text"], { input: prompt, encoding: "utf8", maxBuffer: 1 << 24 });
const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
const missing = rows.filter((r) => !(json[r.id] in roles));
if (missing.length) throw new Error(`役割が付かなかった: ${missing.map((r) => r.id).join(", ")}`);
writeFileSync(`${here}in/role.truth.json`, JSON.stringify(json, null, 1));
const counts = {};
for (const v of Object.values(json)) counts[v] = (counts[v] ?? 0) + 1;
console.error(counts);
