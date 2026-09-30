// PROTOTYPE — Claude に差分操作を出させる部分。サブスク（Agent SDK）経由で呼ぶ。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { KINDS, renderOutline, type MindMap, type Op, type Segment } from "./map";

// system は毎回同じ文字列にして、前置きをキャッシュに乗せる
export const SYSTEM = `あなたは会議のマインドマップを継続的に組み立てる担当者です。
会議の文字起こしが少しずつ届きます。毎回、現在のマップと新しい発言を読み、マップへの差分操作だけを返してください。マップを作り直してはいけません。

# マップの語彙
- マップは会議をルートとする木。ルートの id は root で、最初の議題は root の子に add する。ノード同士の関係は親子だけ。
- 議題: 会議で扱う話題のまとまり。答えを出す対象ではない。
- 論点: 会議の中で答えを出すべき問い。決定を子に持つと「決定済み」、持たなければ「未決」。
- 案: 論点への答えの候補、または議題の中で出た自由なアイデア。状態は 検討中 / 却下。
- 決定: 論点に対して会議で出した答え。親は必ず論点。子を持たない。採用した案の内容は決定の本文に書く。
- 課題: 問題や懸念の記述。答えを出すべき問いになったら論点として扱う。
- TODO: 会議で決まった、誰かが後で行う作業。担当者（会話に出た名前）と期限は任意。子を持たない。

# 差分操作
- add: 親・種別・本文・根拠（発言 id を 1 つ以上）を指定してノードを作る。ref に仮 id（例 "a1"）を付けると、同じ応答の後続の操作から親として参照できる。論点を解決するには、その論点の子に決定を add する。
- update: ノードの本文を書き換え、根拠を足す。案の状態（検討中 / 却下）の切り替えもこれで表す。種別は変えられない。本文は追記せず、言い直した結果の全文で置き換える。
- merge: 同じ種別のノード from を into にまとめる。from の根拠と子は into に移る。
- move: ノードの親を変える。子孫も一緒に移る。
- delete: 誤認識や読み違いで作った、子を持たないノードを消す。却下された案は削除せず update で 却下 にする。
- noop: 新しい発言を見たうえで、マップを変えないと判断したことを表す。

# 方針
## 粒度
- マップは画面共有で参加者が読み、会議の後に見返す。60 分の会議で 50 ノード前後、root からの深さ 4 段（議題 → 論点 → 案・課題・決定 → 補足）までを目安にする。毎回添える「マップの状態」を見て、目安を超えそうなら新しいノードを増やすより既存ノードの update や merge を選ぶ。
- 子ノードにするのは、親とは別の主張（別の理由・別の懸念・派生した案）のときだけ。言い換え、具体例、経緯、同じ主張の補強は、ノードを作らず既存ノードに根拠を足す update にする。
- 課題の子に課題を連ねない。課題や案が 1 つの親の下に 6 つを超えそうなら、何の問いに答えようとしているかで論点を立て、既存ノードを move で束ねる。

## 本文
- 本文は 40 字以内の日本語の名詞句か一文。発言の言い回しをそのまま写さない。例や経緯は本文に書かない。
- update で本文を変えるときは、書き足さず、より的確な短い言い方の全文で置き換える。

## 決定と TODO
- 「〜にしましょう」「〜を結論とする」「〜を基準にする」のような合意は決定にする。案として置かない。答えている論点が無ければ、先に論点を add してからその子に決定を add する。
- 「〜さんが〜する」「〜を持ち帰る」「〜に当たる」のように、誰かが後でやると決まった作業は TODO にする。案として置かない。

## その他
- 挨拶、進行の段取り、相づち、雑談、番組の解説のような、会議の中身でない発言は noop にする。
- 文字起こしには誤認識がある。意味が通るように読み替えてよいが、話されていない内容を足さない。
- 根拠には「新しい発言」の id を使う。直前の発言は文脈を理解するためのもので、根拠に使ってよいのは新しい発言の続きとして必要な場合だけ。
- 1 回の応答の操作は少なく保つ。迷ったら何もしない。`;

const evidence = { type: "array", items: { type: "string" }, minItems: 1, description: "根拠の発言 id（例 s12）" };
const nodeRef = { type: "string", description: "既存ノードの id（例 n3）か、同じ応答で add した ref" };
const obj = (op: string, props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { op: { const: op }, ...props },
  required: ["op", ...required],
  additionalProperties: false,
});

export const SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        anyOf: [
          obj("add", { ref: { type: "string" }, parent: nodeRef, kind: { enum: [...KINDS] }, text: { type: "string" }, evidence, assignee: { type: "string" }, due: { type: "string" } }, ["ref", "parent", "kind", "text", "evidence"]),
          obj("update", { node: nodeRef, text: { type: "string" }, evidence, proposalStatus: { enum: ["検討中", "却下"] } }, ["node", "evidence"]),
          obj("merge", { from: nodeRef, into: nodeRef }, ["from", "into"]),
          obj("move", { node: nodeRef, parent: nodeRef }, ["node", "parent"]),
          obj("delete", { node: nodeRef }, ["node"]),
          obj("noop", { reason: { type: "string" } }, ["reason"]),
        ],
      },
    },
  },
  required: ["ops"],
  additionalProperties: false,
};

export const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtSeg = (s: Segment) => `${s.id} [${fmtTime(s.start)}] ${s.text}`;

function mapStats(map: MindMap, now: number): string {
  const ids = map.order.filter((id) => id !== "root");
  const depth = (id: string) => { let d = 0; for (let c = map.nodes[id]; c?.parent; c = map.nodes[c.parent]) d++; return d; };
  return `経過 ${Math.round(now / 60)} 分・ノード ${ids.length}・最大の深さ ${Math.max(0, ...ids.map(depth))}（目安: 60 分で 50 前後、深さ 4 まで）`;
}

export function buildPrompt(map: MindMap, recent: Segment[], fresh: Segment[], hint?: string): string {
  return [
    "## マップの状態", mapStats(map, fresh.at(-1)!.end), "",
    "## 現在のマップ", renderOutline(map), "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map(fmtSeg).join("\n") : "（なし）", "",
    ...(hint ? ["## 判断モデルの見立て（参考）", hint, ""] : []),
    "## 新しい発言", fresh.map(fmtSeg).join("\n"),
  ].join("\n");
}

export type CallResult = {
  ops: Op[];
  latencyMs: number;
  apiMs: number;
  costUSD: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number };
  error?: string;
};

export async function proposeOps(model: string, prompt: string, effort?: "low" | "medium" | "high"): Promise<CallResult> {
  const t0 = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  try {
    for await (const m of query({
      prompt,
      options: {
        model, systemPrompt: SYSTEM, ...(effort ? { effort } : {}),
        tools: [], settingSources: [], persistSession: false, maxTurns: 4,
        mcpServers: {}, strictMcpConfig: true, plugins: [], skills: [], agents: {},
        outputFormat: { type: "json_schema", schema: SCHEMA },
      },
    })) {
      if (m.type !== "result") continue;
      for (const u of Object.values(m.modelUsage)) {
        usage.input += u.inputTokens; usage.output += u.outputTokens;
        usage.cacheRead += u.cacheReadInputTokens; usage.cacheWrite += u.cacheCreationInputTokens;
        usage.thinking += (u as { thinkingTokens?: number }).thinkingTokens ?? 0;
      }
      const base = { latencyMs: Date.now() - t0, apiMs: m.duration_api_ms, costUSD: m.total_cost_usd, usage };
      if (m.subtype === "success" && m.structured_output) return { ...base, ops: (m.structured_output as { ops: Op[] }).ops };
      return { ...base, ops: [], error: m.subtype };
    }
  } catch (e) {
    return { ops: [], latencyMs: Date.now() - t0, apiMs: 0, costUSD: 0, usage, error: String(e) };
  }
  return { ops: [], latencyMs: Date.now() - t0, apiMs: 0, costUSD: 0, usage, error: "no result" };
}
