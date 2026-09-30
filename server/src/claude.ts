// 差分更新（Claude）。Sonnet 5.5 を Agent SDK（サブスクの認証）で呼ぶ。
// Claude の呼び出しはこの関数の後ろに閉じる。アプリとして配布するときは、API キーで
// Anthropic API を直接呼ぶ実装に差し替える（ADR 0003）。プロンプトは試作 v3 の方針。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { children, issueStatus, KINDS, type DiffUpdater, type MindMap, type Op, type Utterance } from "./core/index.ts";

const MODEL = "claude-sonnet-5-5";

// system は毎回同じ文字列にして、前置きをキャッシュに乗せる
const SYSTEM = `あなたは会議のマインドマップを継続的に組み立てる担当者です。
会議の文字起こしが少しずつ届きます。毎回、現在のマップと新しい発言を読み、マップへの差分操作だけを返してください。マップを作り直してはいけません。

# マップの語彙
- マップは会議をルートとする木。ルートの id は「現在のマップ」の先頭に書いてあり、最初の議題はルートの子に add する。ノード同士の関係は親子だけ。
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

const SCHEMA = {
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

const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtUtt = (u: Utterance) => `${u.id} [${fmtTime(u.start)}] ${u.text}`;

// 根拠は渡さず、ID・種別・状態・本文だけを字下げした木で出す
function renderOutline(map: MindMap, rootId: string): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = map.nodes[id]!;
    const status = n.kind === "論点" ? `(${issueStatus(map, id)})` : n.proposalStatus === "却下" ? "(却下)" : "";
    const todo = n.kind === "TODO" && (n.assignee || n.due) ? ` [${[n.assignee, n.due].filter(Boolean).join(" / ")}]` : "";
    lines.push(`${"  ".repeat(depth)}- ${n.id} ${n.kind}${status}: ${n.text}${todo}`);
    for (const c of children(map, id)) walk(c.id, depth + 1);
  };
  walk(rootId, 0);
  return lines.join("\n");
}

function mapStats(map: MindMap, rootId: string, now: number): string {
  const ids = map.order.filter((id) => id !== rootId);
  const depth = (id: string) => { let d = 0; for (let c = map.nodes[id]; c?.parent; c = map.nodes[c.parent]) d++; return d; };
  return `経過 ${Math.round(now / 60)} 分・ノード ${ids.length}・最大の深さ ${Math.max(0, ...ids.map(depth))}（目安: 60 分で 50 前後、深さ 4 まで）`;
}

export function buildPrompt({ rootId, map, recent, fresh }: Parameters<DiffUpdater>[0]): string {
  return [
    "## マップの状態", mapStats(map, rootId, fresh.at(-1)!.end), "",
    `## 現在のマップ（ルートの ID: ${rootId}）`, renderOutline(map, rootId), "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map(fmtUtt).join("\n") : "（なし）", "",
    "## 新しい発言", fresh.map(fmtUtt).join("\n"),
  ].join("\n");
}

export const claudeUpdater: DiffUpdater = async (input) => {
  for await (const m of query({
    prompt: buildPrompt(input),
    options: {
      model: MODEL, systemPrompt: SYSTEM,
      tools: [], settingSources: [], persistSession: false, maxTurns: 4,
      mcpServers: {}, strictMcpConfig: true, plugins: [], skills: [], agents: {},
      outputFormat: { type: "json_schema", schema: SCHEMA },
    },
  })) {
    if (m.type !== "result") continue;
    if (m.subtype === "success" && m.structured_output) return { ops: (m.structured_output as { ops: Op[] }).ops };
    throw new Error(`差分更新に失敗: ${m.subtype}`);
  }
  throw new Error("差分更新の結果が無い");
};
