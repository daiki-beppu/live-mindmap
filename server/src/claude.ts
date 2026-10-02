// 差分更新（Claude）。Sonnet 5.5 を Agent SDK（サブスクの認証）で呼ぶ。
// Claude の呼び出しはこの関数の後ろに閉じる。アプリとして配布するときは、API キーで
// Anthropic API を直接呼ぶ実装に差し替える（ADR 0003）。プロンプトは試作 v3 の方針。
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { children, KINDS, PLAN_STATUSES, pointStatus, ROOT_ID, type DiffInput, type DiffUpdater, type MeetingMap, type Op, type Remark } from "./core/index.ts";

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
- add: 親・種別・本文・根拠（発言 id を 1 つ以上）を指定してノードを作る。ref に仮 id（例 "a1"）を付けると、同じ応答の後続の操作から親として参照できる。仮 id は既存ノードの id（n1 など）と重ねない。論点を解決するには、その論点の子に決定を add する。
- update: ノードの本文を書き換え、根拠を足す。案の状態（検討中 / 却下）の切り替えもこれで表す。種別は変えられない。本文は追記せず、言い直した結果の全文で置き換える。
- combine: 同じ種別のノード from を into にまとめる。from の根拠と子は into に移る。
- move: ノードの親を変える。子孫も一緒に移る。
- delete: 誤認識や読み違いで作った、子を持たないノードを消す。却下された案は削除せず update で 却下 にする。
- noop: 新しい発言を見たうえで、マップを変えないと判断したことを表す。

# 方針
## 粒度
- マップは画面共有で参加者が読み、会議の後に見返す。60 分の会議で 50 ノード前後、root からの深さ 4 段（議題 → 論点 → 案・課題・決定 → 補足）までを目安にする。毎回添える「マップの状態」を見て、目安を超えそうなら新しいノードを増やすより既存ノードの update や combine を選ぶ。
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
- 1 回の応答の操作は少なく保つ。迷ったら何もしない。

# 会話の扱い
毎回のメッセージは独立した依頼です。前のメッセージのマップは古いので、そのメッセージの現在のマップだけを使ってください。`;

const evidence = { type: "array", items: { type: "string" }, minItems: 1, description: "根拠の発言 id（例 r12）" };
const nodeRef = { type: "string", description: "既存ノードの id（例 n3）か、同じ応答で add した ref" };
const opSchema = (op: string, props: Record<string, unknown>, required: string[]) => ({
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
          opSchema("add", { ref: { type: "string" }, parent: nodeRef, kind: { enum: [...KINDS] }, text: { type: "string" }, evidence, assignee: { type: "string" }, due: { type: "string" } }, ["ref", "parent", "kind", "text", "evidence"]),
          opSchema("update", { node: nodeRef, text: { type: "string" }, evidence, planStatus: { enum: [...PLAN_STATUSES] } }, ["node", "evidence"]),
          opSchema("combine", { from: nodeRef, into: nodeRef }, ["from", "into"]),
          opSchema("move", { node: nodeRef, parent: nodeRef }, ["node", "parent"]),
          opSchema("delete", { node: nodeRef }, ["node"]),
          opSchema("noop", { reason: { type: "string" } }, ["reason"]),
        ],
      },
    },
  },
  required: ["ops"],
  additionalProperties: false,
};

const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtRemark = (r: Remark) => `${r.id} [${fmtTime(r.start)}] ${r.text}`;

// 根拠は渡さず、ID・種別・状態・本文だけを字下げした木で出す
function renderOutline(map: MeetingMap): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = map.nodes[id]!;
    const status = n.kind === "論点" ? `(${pointStatus(map, id)})` : n.planStatus === "却下" ? "(却下)" : "";
    const todo = n.kind === "TODO" && (n.assignee || n.due) ? ` [${[n.assignee, n.due].filter(Boolean).join(" / ")}]` : "";
    lines.push(`${"  ".repeat(depth)}- ${n.id} ${n.kind}${status}: ${n.text}${todo}`);
    for (const c of children(map, id)) walk(c.id, depth + 1);
  };
  walk(ROOT_ID, 0);
  return lines.join("\n");
}

function mapStats(map: MeetingMap, now: number): string {
  const ids = map.order.filter((id) => id !== ROOT_ID);
  const depth = (id: string) => { let d = 0; for (let c = map.nodes[id]; c?.parent; c = map.nodes[c.parent]) d++; return d; };
  return `経過 ${Math.round(now / 60)} 分・ノード ${ids.length}・最大の深さ ${Math.max(0, ...ids.map(depth))}（目安: 60 分で 50 前後、深さ 4 まで）`;
}

export function buildPrompt({ map, recent, fresh }: DiffInput): string {
  return [
    "## マップの状態", mapStats(map, fresh.at(-1)!.end), "",
    `## 現在のマップ（ルートの ID: ${ROOT_ID}）`, renderOutline(map), "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map(fmtRemark).join("\n") : "（なし）", "",
    "## 新しい発言", fresh.map(fmtRemark).join("\n"),
  ].join("\n");
}

// 1 つの query を開いたまま使い回す回数。会話の履歴がたまり続けないよう、この回数ごとに開き直す。
// 14 は、計測（#75）で品質を確かめた最長の回数
export const QUERY_RENEW_CALLS = 14;

export type SessionUpdater = { update: DiffUpdater; close: () => void };

type UserMessage = SDKUserMessage;

// push で受け取ったメッセージを、query の prompt として順に流す。end で終わる
function inputQueue() {
  const pending: UserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const iterable: AsyncIterable<UserMessage> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
  return {
    iterable,
    push(message: UserMessage) {
      pending.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

type Open = {
  input: ReturnType<typeof inputQueue>;
  query: Query;
  output: AsyncIterator<SDKMessage>;
  calls: number;
  aborted: Promise<never>; // close されたら reject する。待っている next() が終わらなくても、呼び出しを止める
  abort: () => void;
};

// 1 つのセッション（会議）で、開いたままの query を使い回す差分更新。
// 最初の呼び出しで開き、回数・失敗・ストリームの終わりで開き直し、close() で閉じる。
// 呼び出しは同時に 1 つしか走らない前提（core の session が直列に呼ぶ）。
export function openClaudeUpdater(run: typeof query = query): SessionUpdater {
  let current: Open | undefined;
  let closed = false;

  const open = (): Open => {
    const input = inputQueue();
    const query = run({
      prompt: input.iterable,
      options: {
        model: MODEL, systemPrompt: SYSTEM,
        tools: [], settingSources: [], persistSession: false, maxTurns: 4,
        mcpServers: {}, strictMcpConfig: true, plugins: [], skills: [], agents: {},
        outputFormat: { type: "json_schema", schema: SCHEMA },
      },
    });
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => (abort = () => reject(new Error("差分更新の query を閉じました"))));
    aborted.catch(() => {}); // 待つ呼び出しが無くても未処理の拒否にしない
    return { input, query, output: query[Symbol.asyncIterator](), calls: 0, aborted, abort };
  };

  const discard = (q: Open) => {
    if (current === q) current = undefined;
    q.input.end();
    q.query.close();
    q.abort();
  };

  const update: DiffUpdater = async (input) => {
    if (closed) throw new Error("差分更新の updater は閉じています");
    if (current && current.calls >= QUERY_RENEW_CALLS) discard(current);
    const q = (current ??= open());
    q.calls++;
    q.input.push({ type: "user", message: { role: "user", content: buildPrompt(input) }, parent_tool_use_id: null });
    try {
      for (;;) {
        const { value: m, done } = await Promise.race([q.output.next(), q.aborted]);
        if (done) throw new Error("差分更新の結果が無い");
        if (m.type !== "result") continue;
        if (m.subtype === "success" && m.structured_output) return { ops: (m.structured_output as { ops: Op[] }).ops };
        throw new Error(`差分更新に失敗: ${m.subtype}`);
      }
    } catch (e) {
      discard(q); // 失敗した query は使い続けず、次の呼び出しで開き直す
      throw e;
    }
  };

  return {
    update,
    close() {
      closed = true;
      if (current) discard(current);
    },
  };
}
