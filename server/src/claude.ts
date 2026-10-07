// 差分更新（Claude）。Sonnet 5.5 を Agent SDK で呼ぶ。認証は利用者の ANTHROPIC_API_KEY（ADR 0004）。
// Claude の呼び出しはこの関数の後ろに閉じる（ADR 0003）。プロンプトは試作 v3 の方針。
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Context, Effect, Exit, Layer, Option, Queue, Ref, Schema, Scope, Stream } from "effect";
import { children, DiffOutput, DiffUpdater, pointStatus, ROOT_ID, type DiffInput, type MeetingMap, type Remark } from "./core/index.ts";

const MODEL = "claude-sonnet-5-5";

// noop にしてよい発言の範囲。noop の条件の定義はここだけに書く（SYSTEM の「# noop にする範囲」に 1 回埋め込む）。
export const NOOP_SCOPE = `noop にしてよいのは、新しい発言が次の 4 つだけでできているときに限る。
- 相づち: 内容を足さない短い応答。賛否や理由を述べていれば相づちではない。
- 進行の段取り: 会議の運び方についての発言（開始・終了・次の話への切り替え・順番・時間・画面共有や接続の操作）。話題の中身は含まない。
- 聞き取れない断片: 誤認識や途切れで、意味を復元できない発言。
- 同じ内容の言い直し: 直前の発言やマップにすでにある内容を、新しい情報を足さずに繰り返す発言。
これ以外（紹介、説明、体験談、おすすめ、質問と答え、脱線した話題など）は noop にせず、マップに残す。新しい発言に 4 つ以外の部分があれば、その部分を反映する。`;

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
- 要点: 議題の中で共有された中身。紹介、体験談、おすすめ、質問とその答えを表す。答えを出す対象でも、問題の指摘でも、答えの候補でもない。

# 差分操作
- add: 親・種別・本文・根拠（発言 id を 1 つ以上）を指定してノードを作る。ref に仮 id（例 "a1"）を付けると、同じ応答の後続の操作から親として参照できる。仮 id は既存ノードの id（n1 など）と重ねない。論点を解決するには、その論点の子に決定を add する。
- update: ノードの本文を書き換え、根拠を足す。案の状態（検討中 / 却下）の切り替えもこれで表す。種別は変えられない。本文は追記せず、言い直した結果の全文で置き換える。
- combine: 同じ種別のノード from を into にまとめる。from の根拠と子は into に移る。
- move: ノードの親を変える。子孫も一緒に移る。
- delete: 誤認識や読み違いで作った、子を持たないノードを消す。却下された案は削除せず update で 却下 にする。
- close: 議題か論点を「済み」にする。会議の話が明らかに別へ移り、戻る気配がないときだけ使う。迷うときは閉じない。根拠は持たない。済みの議題・論点やその子孫に add・update・combine・move をすると、自動で話し中に戻る（開き直す操作は無い）。話が戻ってきたら、畳まれていても見えている id にそのまま add・update する。
- noop: 新しい発言を見たうえで、マップを変えないと判断したことを表す。

# 方針
## 粒度
- マップは画面共有で参加者が読み、会議の後に見返す。60 分の会議で 50 ノード前後、root からの深さ 4 段（議題 → 論点 → 案・課題・決定・要点 → 補足）までを目安にする。毎回添える「マップの状態」を見て、目安を超えそうなら新しいノードを増やすより既存ノードの update や combine を選ぶ。
- 子ノードにするのは、親とは別の主張（別の理由・別の懸念・派生した案）のときだけ。具体例、経緯、同じ主張の補強は、ノードを作らず既存ノードに根拠を足す update にする。
- 課題の子に課題を連ねない。課題や案が 1 つの親の下に 6 つを超えそうなら、何の問いに答えようとしているかで論点を立て、既存ノードを move で束ねる。

## 本文
- 本文は 40 字以内の日本語の名詞句か一文。発言の言い回しをそのまま写さない。例や経緯は本文に書かない。
- update で本文を変えるときは、書き足さず、より的確な短い言い方の全文で置き換える。

## 決定と TODO
- 「〜にしましょう」「〜を結論とする」「〜を基準にする」のような合意は決定にする。案として置かない。答えている論点が無ければ、先に論点を add してからその子に決定を add する。
- 「〜さんが〜する」「〜を持ち帰る」「〜に当たる」のように、誰かが後でやると決まった作業は TODO にする。案として置かない。
- 紹介・解説・体験談・流した動画や資料の解説の中で語られた「〜にする」「〜すべき」は、会議の合意でも作業の割り当てでもない。決定や TODO にせず、要点にする。

## 決めない会議（共有・紹介・雑談）
- 決定がなくても、話題が変わるたびに議題として立て、その下に要点を add する。紹介、体験談、おすすめ、質問とその答えは、それぞれ議題の下の要点として残す。
- 質問とその答えは 1 つの要点にまとめる。答えが後から出たら、その要点の本文を update で置き換える。
- 要点を分けるのは、紹介した物・体験・おすすめ・質問が別のときだけ。同じ紹介や体験談の補足、具体例、値段、手順、数字、経緯は、新しい要点にせず、既存の要点に根拠を足す update にする（本文に収まるものだけ短く言い直す）。
- 1 つの議題の下の要点は 3 つまで。3 つある議題に紹介・体験談・おすすめ・質問が増えるときは、新しい要点を add せず、最も近い要点の本文を、両方を含む短い言い方の全文で update し、新しい発言を根拠に足す。

## その他
- 文字起こしには誤認識がある。意味が通るように読み替えてよいが、話されていない内容を足さない。
- 根拠には「新しい発言」の id を使う。直前の発言は文脈を理解するためのもので、根拠に使ってよいのは新しい発言の続きとして必要な場合だけ。
- 1 回の応答の操作は少なく保つ。迷ったら、新しいノードを増やすより既存ノードの update を選ぶ。

# noop にする範囲
${NOOP_SCOPE}

# 済みの議題の見え方
現在のマップで「（済み）」が付いた議題・論点は畳んである。配下の案・課題・要点は省いて見せている。そこへ話が戻ったら、見えている議題・論点の id に add・update する。同じ議題や論点を新しく作り直さない。

# 会話の扱い
この会話の最初のメッセージには、現在のマップの全体が載る。2 通目からは、マップの全体の代わりに前回からのマップの変更だけが載る。変更には、前回の操作を当てた結果（add で付いた id、update 後の本文、統合・移動・削除）が含まれる。最初のマップにこれまでの変更を順に当てたものが今のマップ。ノードは変更に書かれた id で指す`;


const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtRemark = (r: Remark) => `${r.id} [${fmtTime(r.start)}] ${r.text}`;

// 1 ノードの書式（ID・種別・状態・本文・TODO の担当と期限）。アウトラインと変更で共有する。根拠は渡さない
function nodeLabel(map: MeetingMap, id: string, explicitPlanStatus = false): string {
  const n = map.nodes[id]!;
  const status = n.kind === "論点" ? `(${pointStatus(map, id)})`
    : n.kind === "案" && (n.planStatus === "却下" || explicitPlanStatus) ? `(${n.planStatus === "却下" ? "却下" : "検討中"})` : n.planStatus === "却下" ? "(却下)" : "";
  const todo = n.kind === "TODO" && (n.assignee || n.due) ? ` [${[n.assignee, n.due].filter(Boolean).join(" / ")}]` : "";
  return `${n.id} ${n.kind}${status}: ${n.text}${todo}`;
}

// アウトラインの 1 行（字下げ・ID・種別・状態・本文・「（済み）」）。全体のアウトラインと、開き直した配下の出力で共有する
function outlineLine(map: MeetingMap, id: string, depth: number): string {
  return `${"  ".repeat(depth)}- ${nodeLabel(map, id)}${map.nodes[id]!.talkStatus ? "（済み）" : ""}`;
}

// 済みの議題・論点の配下は、案・課題・要点の行を省く（その下の論点・決定・TODO などはたどって出す）
const FOLDED_KINDS = new Set(["案", "課題", "要点"]);

// ID・種別・状態・本文だけを字下げした木で出す
function renderOutline(map: MeetingMap): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number, folded: boolean) => {
    // 省いた段も字下げに数える（元の木の深さを保つ）
    if (!(folded && FOLDED_KINDS.has(map.nodes[id]!.kind))) lines.push(outlineLine(map, id, depth));
    const nextFolded = folded || !!map.nodes[id]!.talkStatus;
    for (const c of children(map, id)) walk(c.id, depth + 1, nextFolded);
  };
  walk(ROOT_ID, 0, false);
  return lines.join("\n");
}

// 前回送ったマップ prev から今のマップ cur への変更を行ごとに出す。操作ではなくマップ同士を比べるので、適用できなかった操作は出ない
function renderChanges(prev: MeetingMap, cur: MeetingMap): string {
  const lines: string[] = [];
  const ids = (m: MeetingMap) => m.order.filter((id) => id !== ROOT_ID && m.nodes[id]);
  for (const id of ids(prev)) {
    if (!cur.nodes[id]) lines.push(`- 削除 ${id}: 削除（統合された場合は統合先に子と根拠が移った）`);
  }
  for (const id of ids(cur)) {
    const n = cur.nodes[id]!;
    const old = prev.nodes[id];
    if (!old) {
      lines.push(`- 追加 ${nodeLabel(cur, id, true)} （親: ${n.parent}）`);
      continue;
    }
    const changed = n.text !== old.text || n.planStatus !== old.planStatus || n.assignee !== old.assignee || n.due !== old.due
      || (n.kind === "論点" && pointStatus(cur, id) !== pointStatus(prev, id));
    if (changed) lines.push(`- 更新 ${nodeLabel(cur, id, true)}`);
    if (n.parent !== old.parent) lines.push(`- 移動 ${id} → 親: ${n.parent}`);
  }
  for (const id of ids(cur)) {
    const closedNow = !!cur.nodes[id]!.talkStatus;
    const closedBefore = !!prev.nodes[id]?.talkStatus;
    if (!closedBefore && closedNow) lines.push(`- ${id} 済みにした`);
    if (closedBefore && !closedNow) {
      lines.push(`- ${id} 話し中に戻った。畳んでいた中身:`);
      const walk = (pid: string, depth: number) => {
        for (const c of children(cur, pid)) {
          lines.push(outlineLine(cur, c.id, depth));
          walk(c.id, depth + 1);
        }
      };
      walk(id, 1);
    }
  }
  return lines.length ? lines.join("\n") : "（変更なし）";
}

function mapStats(map: MeetingMap, now: number): string {
  const ids = map.order.filter((id) => id !== ROOT_ID);
  const depth = (id: string) => { let d = 0; for (let c = map.nodes[id]; c?.parent; c = map.nodes[c.parent]) d++; return d; };
  return `経過 ${Math.round(now / 60)} 分・ノード ${ids.length}・最大の深さ ${Math.max(0, ...ids.map(depth))}（目安: 60 分で 50 前後、深さ 4 まで）`;
}

// previous（その query に前回送ったマップ）が無ければ全体のアウトライン、あれば前回からの変更を載せる
export function buildPrompt({ map, recent, fresh }: DiffInput, previous?: MeetingMap): string {
  return [
    "## マップの状態", mapStats(map, fresh.at(-1)!.end), "",
    ...(previous
      ? [`## 前回からのマップの変更（ルートの ID: ${ROOT_ID}）`, renderChanges(previous, map)]
      : [`## 現在のマップ（ルートの ID: ${ROOT_ID}）`, renderOutline(map)]), "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map(fmtRemark).join("\n") : "（なし）", "",
    "## 新しい発言", fresh.map(fmtRemark).join("\n"),
  ].join("\n");
}

// 出力の JSON Schema は core の DiffOutput から、モジュールを読み込んだときに 1 回だけ作る。
// 余分なキーは JSON Schema の上では禁止（additionalProperties: false）にし、decode では黙って落とす。文字列の長さなどの検査は足さない
const OUTPUT_SCHEMA = Schema.toJsonSchemaDocument(DiffOutput, { onExcessProperty: "error" }).schema;

// 1 つの query を開いたまま使い回す回数。会話の履歴がたまり続けないよう、この回数ごとに開き直す。
// 14 は、計測（#75）で品質を確かめた最長の回数
export const QUERY_RENEW_CALLS = 14;

// Agent SDK の query。テストでは偽物の Layer に替える
export class AgentSdk extends Context.Service<AgentSdk, {
  readonly query: typeof query;
}>()("live-mindmap/server/AgentSdk") {
  static readonly layer = Layer.succeed(AgentSdk, AgentSdk.of({ query }));
}

// SDK が例外を投げた、または result の前にストリームが終わった
export class ClaudeQueryFailed extends Schema.TaggedError<ClaudeQueryFailed>()("ClaudeQueryFailed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

// result の subtype が success ではない
export class ClaudeResultFailed extends Schema.TaggedError<ClaudeResultFailed>()("ClaudeResultFailed", {
  message: Schema.String,
  subtype: Schema.String,
}) {}

// structured_output が無い、または DiffOutput の形に合わない
export class DiffOutputInvalid extends Schema.TaggedError<DiffOutputInvalid>()("DiffOutputInvalid", {
  message: Schema.String,
  issue: Schema.Defect(),
}) {}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 開いている query。子の Scope を閉じると、入力の Queue を終えて query.close() を呼ぶ
type Open = {
  scope: Scope.Closeable;
  input: Queue.Queue<SDKUserMessage, Cause.Done>;
  query: Query;
  output: AsyncIterator<SDKMessage>;
  calls: number;
  sent?: MeetingMap; // この query に前回送ったマップ。開き直しで Open ごと捨てられ、次の最初のメッセージで再び全体を送る
};

// 1 つのセッション（会議）で、開いたままの query を使い回す差分更新。
// 最初の呼び出しで開き、回数・失敗・ストリームの終わりで開き直し、セッションの Scope を閉じると閉じる。
// 呼び出しは同時に 1 つしか走らない前提（core の session が直列に呼ぶ）。
export const ClaudeDiffUpdater = {
  layer: Layer.effect(
    DiffUpdater,
    Effect.gen(function* () {
      const sdk = yield* AgentSdk;
      const sessionScope = yield* Scope.Scope;
      const current = yield* Ref.make(Option.none<Open>());
      let closed = false;
      yield* Effect.addFinalizer(() => Effect.sync(() => void (closed = true)));

      const open = Effect.gen(function* () {
        const scope = yield* Scope.fork(sessionScope, "sequential");
        return yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done>();
            const q = yield* Effect.try({
              try: () => sdk.query({
                prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
                options: {
                  model: MODEL, systemPrompt: SYSTEM,
                  tools: [], settingSources: [], persistSession: false, maxTurns: 4,
                  mcpServers: {}, strictMcpConfig: true, plugins: [], skills: [], agents: {},
                  outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
                  env: { ...process.env, FORCE_PROMPT_CACHING_5M: "1" }, // env は subprocess の環境を置き換えるので process.env を引き継ぐ
                },
              }),
              catch: (e) => new ClaudeQueryFailed({ message: messageOf(e), cause: e }),
            }).pipe(Effect.tapError(() => Queue.end(input)));
            const opened: Open = { scope, input, query: q, output: q[Symbol.asyncIterator](), calls: 0 };
            return opened;
          }),
          (o) => Queue.end(o.input).pipe(Effect.andThen(Effect.sync(() => o.query.close()))),
        ).pipe(
          Scope.provide(scope),
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        );
      });

      // 使っている query を捨てる。Ref を空にしてから子の Scope を閉じる
      const discard = (o: Open) =>
        Ref.update(current, (c) => (Option.isSome(c) && c.value === o ? Option.none() : c)).pipe(
          Effect.andThen(Scope.close(o.scope, Exit.void)),
        );

      const next = (o: Open) =>
        Effect.tryPromise({
          try: () => o.output.next(),
          catch: (e) => new ClaudeQueryFailed({ message: messageOf(e), cause: e }),
        });

      const awaitResult = (o: Open): Effect.Effect<DiffOutput, ClaudeQueryFailed | ClaudeResultFailed | DiffOutputInvalid> =>
        Effect.gen(function* () {
          for (;;) {
            const { value: m, done } = yield* next(o);
            if (done) return yield* new ClaudeQueryFailed({ message: "差分更新の結果が無い", cause: "stream ended before result" });
            if (m.type !== "result") continue;
            if (m.subtype !== "success") return yield* new ClaudeResultFailed({ message: `差分更新に失敗: ${m.subtype}`, subtype: m.subtype });
            return yield* Schema.decodeUnknownEffect(DiffOutput)(m.structured_output).pipe(
              Effect.mapError((e) => new DiffOutputInvalid({ message: `差分更新の出力が不正: ${e.message}`, issue: e.issue })),
            );
          }
        });

      const update = (input: DiffInput) =>
        Effect.gen(function* () {
          if (closed) return yield* Effect.die(new Error("差分更新の updater は閉じています"));
          let c = yield* Ref.get(current);
          if (Option.isSome(c) && c.value.calls >= QUERY_RENEW_CALLS) {
            yield* discard(c.value);
            c = Option.none();
          }
          const o = Option.isSome(c) ? c.value : yield* open;
          if (Option.isNone(c)) yield* Ref.set(current, Option.some(o));
          return yield* Effect.gen(function* () {
            o.calls++;
            yield* Queue.offer(o.input, { type: "user", message: { role: "user", content: buildPrompt(input, o.sent) }, parent_tool_use_id: null });
            o.sent = input.map;
            return yield* awaitResult(o);
          }).pipe(
            // 失敗・defect・中断のどれでも、その query は使い続けず、次の呼び出しで開き直す
            Effect.onError(() => discard(o)),
          );
        });

      return DiffUpdater.of({ update });
    }),
  ),
};
