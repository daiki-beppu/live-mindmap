// PROTOTYPE（issue #130 の試作。main には入れない）: src/claude.ts の写しに、ADR 0005 の「閉じる」と、済みの議題を畳んで渡す入力を足したもの。
// closedStyle: "full" は今の作りと同じ（閉じるも出させない）。"title" は済みの議題を 1 行に、"outcomes" は議題名と論点・決定・TODO だけにする。
// 済みの状態はこのファイルの中だけで持つ（core の適用関数は閉じるを知らないので、閉じるは取り除いてから返す）。
import { appendFileSync } from "node:fs";
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { applyOps, children, KINDS, PLAN_STATUSES, pointStatus, ROOT_ID, type DiffInput, type DiffUpdater, type MeetingMap, type Op, type Remark } from "../src/core/index.ts";

export type ClosedStyle = "full" | "title" | "outcomes";

const MODEL = "claude-sonnet-5-5";

// noop にしてよい発言の範囲。noop の条件の定義はここだけに書く（SYSTEM の「# noop にする範囲」に 1 回埋め込む）。
export const NOOP_SCOPE = `noop にしてよいのは、新しい発言が次の 4 つだけでできているときに限る。
- 相づち: 内容を足さない短い応答。賛否や理由を述べていれば相づちではない。
- 進行の段取り: 会議の運び方についての発言（開始・終了・次の話への切り替え・順番・時間・画面共有や接続の操作）。話題の中身は含まない。
- 聞き取れない断片: 誤認識や途切れで、意味を復元できない発言。
- 同じ内容の言い直し: 直前の発言やマップにすでにある内容を、新しい情報を足さずに繰り返す発言。
これ以外（紹介、説明、体験談、おすすめ、質問と答え、脱線した話題など）は noop にせず、マップに残す。新しい発言に 4 つ以外の部分があれば、その部分を反映する。`;

const CLOSE_OP_TEXT = `- close: 議題か論点を「済み」にする。会議の話が明らかに別へ移り、戻る気配がないときだけ使う。迷うときは閉じない。根拠は持たない。済みの議題・論点は、マップで畳んだ形（議題名と、論点・決定・TODO だけ）で見える。済みの議題・論点やその子孫に add・update・combine・move をすると、自動で話し中に戻る（開き直す操作は無い）。話が戻ってきたら、畳まれていても見えている id にそのまま add・update する。
`;
const CLOSED_VIEW_TEXT = `
# 済みの議題の見え方
現在のマップで「（済み）」が付いた議題・論点は畳んである。配下の案・課題・要点は省いて見せている。そこへ話が戻ったら、見えている議題・論点の id に add・update する。同じ議題や論点を新しく作り直さない。
`;


// 粒度の方針。v1 は今の作り（60 分で 50 ノード前後）。v2 は issue #137 の試作（議題の立て方・議題ごとの目安・議題の一覧）
export type Granularity = "v1" | "v2" | "v3";
const TOPIC_DEF: Record<Granularity, string> = {
  get v3() { return this.v2; },
  v1: "会議で扱う話題のまとまり。答えを出す対象ではない。",
  v2: "会議の中で、話がしばらく集まる話題のまとまり。答えを出す対象ではない。会議そのもの（会議の目的や、会議全体で答えようとしている問い）は議題にも論点にもしない。それはルートが表す。",
};
const GRANULARITY_TEXT = {
  v1: `## 粒度
- マップは画面共有で参加者が読み、会議の後に見返す。60 分の会議で 50 ノード前後、root からの深さ 4 段（議題 → 論点 → 案・課題・決定・要点 → 補足）までを目安にする。毎回添える「マップの状態」を見て、目安を超えそうなら新しいノードを増やすより既存ノードの update や combine を選ぶ。
- 子ノードにするのは、親とは別の主張（別の理由・別の懸念・派生した案）のときだけ。具体例、経緯、同じ主張の補強は、ノードを作らず既存ノードに根拠を足す update にする。
- 課題の子に課題を連ねない。課題や案が 1 つの親の下に 6 つを超えそうなら、何の問いに答えようとしているかで論点を立て、既存ノードを move で束ねる。`,
  v2: `## 議題の立て方
- ルートは会議そのもの。会議の目的や、会議全体で答えようとしている問い（例: 「どんな本を作るか」「新製品をどうするか」）は、議題にも論点にもしない。その下位の話題（届け先、大きさ、部数、値段…）を、それぞれ議題としてルートの子に add する。
- 話の対象（扱う物・写真・発表・発表者・問い）が変わったら、短い話でも新しい議題をルートの子に add する。今の議題の下に押し込まない。紹介や発表が 1 つずつ続く場面では、1 つ（1 人）ごとに議題を立てる。
- 前の議題の話に戻ったら、新しく作らず、「議題の一覧」にあるその議題の id に add・update する。
- 議題の下に議題を置かない。

## 粒度
- マップは画面共有で参加者が読み、会議の後に見返す。画面は今の議題を中心に見せるので、1 つの議題は 15〜20 ノード、root からの深さ 4 段（議題 → 論点 → 案・課題・決定・要点 → 補足）までを目安にする。会議全体のノード数には目安を設けない。
- 毎回添える「議題の一覧」で、今の議題の大きさを見る。目安を超えそうなら、これからの話を新しい議題として立てる。すでにあるノードを別の議題へ動かし直さない。
- 子ノードにするのは、親とは別の主張（別の理由・別の懸念・派生した案）のときだけ。具体例、経緯、同じ主張の補強は、ノードを作らず既存ノードに根拠を足す update にする。
- 課題の子に課題を連ねない。課題や案が 1 つの親の下に 6 つを超えそうなら、何の問いに答えようとしているかで論点を立て、既存ノードを move で束ねる。

## 閉じる
- 新しい議題を立てたときは、「議題の一覧」の話し中の議題を見直し、話が明らかに別へ移って戻る気配がないものを close する。論点も同じ。迷うときは閉じない。
`,
  v3: `## 議題の立て方
- ルートは会議そのもの。会議の目的や、会議全体で答えようとしている問い（例: 「どんな本を作るか」「新製品をどうするか」）は、議題にも論点にもしない。その下位の話題（届け先、大きさ、部数、値段…）を、それぞれ議題としてルートの子に add する。
- マップは会議の記録として後で見返す。議題名を見れば、その下に何があるかが分かるようにする。
- 話の対象（扱う物・写真・発表・発表者）が変わったら、短い話でも新しい議題をルートの子に add する。紹介や発表が 1 つずつ続く場面では、1 つ（1 人）ごとに議題を立てる。
- 1 つの発表・紹介の中で出た例・派生した案・周りの反応は、その発表の議題の下に案や要点として置く。「発表9-2」のように番号を振って議題を分けない。
- 新しい問いが出たとき、今の議題名に収まる問いなら、その議題の下に論点として置く。議題名に収まらない問いなら、新しい議題を立てる（例: 議題「本の届け先」の中で「出版社から出すか自費か」が話され始めたら、新しい議題にする）。
- 前の議題の話に戻ったら、新しく作らずその議題の id に add・update する。済みの議題は「議題の一覧」に出ないので、現在のマップや変更に出てきた id を使う。
- 議題の下に議題を置かない。

## 粒度
- マップは画面共有で参加者が読み、会議の後に見返す。画面は今の議題を中心に見せ、済みの議題・論点は畳む。1 つの議題の話し中の部分（済みの論点の下は数えない）は 15〜20 ノード、root からの深さ 4 段（議題 → 論点 → 案・課題・決定・要点 → 補足）までを目安にする。会議全体のノード数には目安を設けない。
- 毎回添える「議題の一覧」で、今の議題の話し中の大きさを見る。目安を超えそうなら、答えが出た論点や話の移った論点を close するか、これからの話を新しい議題として立てる。すでにあるノードを別の議題へ動かし直さない。
- 子ノードにするのは、親とは別の主張（別の理由・別の懸念・派生した案）のときだけ。具体例、経緯、同じ主張の補強は、ノードを作らず既存ノードに根拠を足す update にする。
- 課題の子に課題を連ねない。課題や案が 1 つの親の下に 6 つを超えそうなら、何の問いに答えようとしているかで論点を立て、既存ノードを move で束ねる。

## 閉じる
- 毎回、「議題の一覧」の話し中の議題と、今の議題の中の論点を見直す。最後に触れてからしばらく経ち、話が明らかに別へ移って戻る気配がないものを close する。迷うときは閉じない。
- 直前の応答や今回の応答で触れた議題・論点は閉じられない（無効になる）。新しい議題に移ったばかりの応答では前の議題を閉じず、次の応答以降で閉じる。
`,
};
const PREFER_UPDATE = {
  v3: "- 1 回の応答の操作は少なく保つ。同じ話の中で迷ったら、新しいノードを増やすより既存ノードの update を選ぶ。ただし、話の対象が変わったときや、議題名に収まらない問いが出たときは新しい議題を立てる。",
  v1: "- 1 回の応答の操作は少なく保つ。迷ったら、新しいノードを増やすより既存ノードの update を選ぶ。",
  v2: "- 1 回の応答の操作は少なく保つ。同じ話の中で迷ったら、新しいノードを増やすより既存ノードの update を選ぶ。ただし、話の対象が変わったときは新しい議題を立てる。",
};

// system は毎回同じ文字列にして、前置きをキャッシュに乗せる
const makeSystem = (CLOSE_OP: string, CLOSED_VIEW: string, CONVERSATION: string, TOPIC_DEF: string, GRANULARITY: string, PREFER_UPDATE: string) => `あなたは会議のマインドマップを継続的に組み立てる担当者です。
会議の文字起こしが少しずつ届きます。毎回、現在のマップと新しい発言を読み、マップへの差分操作だけを返してください。マップを作り直してはいけません。

# マップの語彙
- マップは会議をルートとする木。ルートの id は「現在のマップ」の先頭に書いてあり、最初の議題はルートの子に add する。ノード同士の関係は親子だけ。
- 議題: ${TOPIC_DEF}
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
- noop: 新しい発言を見たうえで、マップを変えないと判断したことを表す。
${CLOSE_OP}
# 方針
${GRANULARITY}
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
${PREFER_UPDATE}

# noop にする範囲
${NOOP_SCOPE}
${CLOSED_VIEW}

# 会話の扱い
${CONVERSATION}`;
const CONVERSATION_FULL = "毎回のメッセージは独立した依頼です。前のメッセージのマップは古いので、そのメッセージの現在のマップだけを使ってください。";
const CONVERSATION_DIFF = `この会話の最初のメッセージには、現在のマップの全体が載っています。2 通目からは、マップの全体の代わりに「前回からのマップの変更」だけが載ります。変更には、あなたの前回の操作を当てた結果（add で付いた id、update 後の本文、統合・移動・削除、済み・話し中の切り替え）が含まれます。最初のマップにこれまでの変更を順に当てたものが、今のマップです。
- ノードを指すときは、変更に書かれた n で始まる id を使う。前回の応答の仮 id（ref）は次の応答では使えない。
- 適用できなかった操作は変更に出てこない。前回の応答に書いたことでも、変更に出ていなければマップには無い。`;

const evidence = { type: "array", items: { type: "string" }, minItems: 1, description: "根拠の発言 id（例 r12）" };
const nodeRef = { type: "string", description: "既存ノードの id（例 n3）か、同じ応答で add した ref" };
const opSchema = (op: string, props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { op: { const: op }, ...props },
  required: ["op", ...required],
  additionalProperties: false,
});

const makeSchema = (withClose: boolean) => ({
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
          ...(withClose ? [opSchema("close", { node: nodeRef }, ["node"])] : []),
        ],
      },
    },
  },
  required: ["ops"],
  additionalProperties: false,
});

const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtRemark = (r: Remark) => `${r.id} [${fmtTime(r.start)}] ${r.text}`;

// 根拠は渡さず、ID・種別・状態・本文だけを字下げした木で出す。済みの議題・論点は style に従って畳む
function renderOutline(map: MeetingMap, closed: ReadonlySet<string> = new Set(), style: ClosedStyle = "full"): string {
  const lines: string[] = [];
  const line = (id: string, depth: number) => {
    const n = map.nodes[id]!;
    const status = n.kind === "論点" ? `(${pointStatus(map, id)})` : n.planStatus === "却下" ? "(却下)" : "";
    const todo = n.kind === "TODO" && (n.assignee || n.due) ? ` [${[n.assignee, n.due].filter(Boolean).join(" / ")}]` : "";
    lines.push(`${"  ".repeat(depth)}- ${n.id} ${n.kind}${status}: ${n.text}${todo}${closed.has(id) ? "（済み）" : ""}`);
  };
  // 畳んだ中身: 論点・決定・TODO だけを残す（論点の下は決定と TODO だけ）
  const folded = (id: string, depth: number) => {
    for (const c of children(map, id)) {
      if (c.kind === "論点") { line(c.id, depth); folded(c.id, depth + 1); }
      else if (c.kind === "決定" || c.kind === "TODO") line(c.id, depth);
      else folded(c.id, depth);
    }
  };
  const walk = (id: string, depth: number) => {
    line(id, depth);
    if (closed.has(id)) {
      if (style === "outcomes") folded(id, depth + 1);
      return;
    }
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

// 前回送ったときから変わったノードと、済み・話し中の切り替えを出す。開き直した議題・論点は、畳んで見せていた中身ごと出す
function renderChanges(before: MeetingMap, beforeClosed: ReadonlySet<string>, after: MeetingMap, closed: ReadonlySet<string>): string {
  const lines: string[] = [];
  const line = (m: MeetingMap, id: string, depth = 0) => {
    const n = m.nodes[id]!;
    const status = n.kind === "論点" ? `(${pointStatus(m, id)})` : n.planStatus === "却下" ? "(却下)" : "";
    const todo = n.kind === "TODO" && (n.assignee || n.due) ? ` [${[n.assignee, n.due].filter(Boolean).join(" / ")}]` : "";
    return `${"  ".repeat(depth)}- ${n.id} ${n.kind}${status}: ${n.text}${todo}（親 ${n.parent}）`;
  };
  const shown = new Set<string>();
  for (const id of after.order) {
    const a = after.nodes[id]!, b = before.nodes[id];
    const statusChanged = a.kind === "論点" && b && pointStatus(after, id) !== pointStatus(before, id);
    if (!b) lines.push(line(after, id) + " 追加");
    else if (a.text !== b.text || a.planStatus !== b.planStatus || a.assignee !== b.assignee || a.due !== b.due || statusChanged) lines.push(line(after, id) + " 更新");
    else if (a.parent !== b.parent) lines.push(line(after, id) + " 移動");
    else continue;
    shown.add(id);
  }
  for (const id of before.order) if (!after.nodes[id]) lines.push(`- ${id} 削除（統合された場合は統合先に子と根拠が移った）`);
  for (const id of closed) if (!beforeClosed.has(id) && after.nodes[id]) lines.push(`- ${id} 済みにした`);
  for (const id of beforeClosed) {
    if (closed.has(id) || !after.nodes[id]) continue;
    lines.push(`- ${id} 話し中に戻った。畳んでいた中身:`);
    const walk = (c: string, depth: number) => { for (const k of children(after, c)) { lines.push(line(after, k.id, depth)); walk(k.id, depth + 1); } };
    walk(id, 1);
  }
  return lines.join("\n") || "（変更なし）";
}

// v2: 全体の数の代わりに、議題の一覧（id・名前・話し中 / 済み・ノード数）を毎回添える
function topicStats(map: MeetingMap, now: number, closed: ReadonlySet<string>): string {
  const size = (id: string): number => children(map, id).reduce((a, c) => a + 1 + size(c.id), 0);
  const topics = map.order.filter((id) => map.nodes[id]!.kind === "議題");
  const open = topics.filter((id) => !closed.has(id)).length;
  return [
    `経過 ${Math.round(now / 60)} 分（目安: 1 つの議題は 15〜20 ノード、深さ 4 まで）`,
    "",
    `## 議題の一覧（話し中 ${open}・済み ${topics.length - open}）`,
    ...topics.map((id) => `- ${id} ${map.nodes[id]!.text}（${closed.has(id) ? "済み" : "話し中"}・${size(id)} ノード）`),
  ].join("\n") + (topics.length ? "" : "（まだ無い）");
}

// v3: 議題の一覧は話し中だけ。最後に触れた分と、話し中の部分の大きさ（済みの論点の下は数えない）を載せる。済みは件数だけ
function topicStatsV3(map: MeetingMap, now: number, closed: ReadonlySet<string>, lastTouched: ReadonlyMap<string, number>): string {
  const size = (id: string): number => children(map, id).reduce((a, c) => a + 1 + (closed.has(c.id) ? 0 : size(c.id)), 0);
  const topics = map.order.filter((id) => map.nodes[id]!.kind === "議題");
  const open = topics.filter((id) => !closed.has(id));
  return [
    `経過 ${Math.round(now / 60)} 分（目安: 1 つの議題の話し中の部分は 15〜20 ノード、深さ 4 まで）`,
    "",
    `## 議題の一覧（話し中 ${open.length}・済み ${topics.length - open.length}。済みは省略）`,
    ...open.map((id) => `- ${id} ${map.nodes[id]!.text}（話し中 ${size(id)} ノード・最後に触れたのは ${Math.round((lastTouched.get(id) ?? 0) / 60)} 分）`),
  ].join("\n") + (open.length ? "" : "（まだ無い）");
}

function buildDiffPrompt({ recent, fresh }: DiffInput, changes: string, stats: string): string {
  return [
    "## マップの状態", stats, "",
    "## 前回からのマップの変更", changes, "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map(fmtRemark).join("\n") : "（なし）", "",
    "## 新しい発言", fresh.map(fmtRemark).join("\n"),
  ].join("\n");
}

export function buildPrompt({ map, recent, fresh }: DiffInput, closed: ReadonlySet<string> = new Set(), style: ClosedStyle = "full", stats = mapStats(map, fresh.at(-1)!.end)): string {
  return [
    "## マップの状態", stats, "",
    `## 現在のマップ（ルートの ID: ${ROOT_ID}）`, renderOutline(map, closed, style), "",
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
  sent?: { map: MeetingMap; closed: Set<string> }; // 変更分だけ送るとき、前回送った時点のマップと済み
  aborted: Promise<never>; // close されたら reject する。待っている next() が終わらなくても、呼び出しを止める
  abort: () => void;
};

// 1 つのセッション（会議）で、開いたままの query を使い回す差分更新。
// 最初の呼び出しで開き、回数・失敗・ストリームの終わりで開き直し、close() で閉じる。
// 呼び出しは同時に 1 つしか走らない前提（core の session が直列に呼ぶ）。
export function openClaudeUpdater(run: typeof query = query, style: ClosedStyle = "full", closesLog?: string, diff = false, granularity: Granularity = "v1"): SessionUpdater & { closedSet: Set<string>; prompt: (input: DiffInput) => string } {
  let current: Open | undefined;
  let closed = false;
  const withClose = style !== "full";
  const SYSTEM = makeSystem(withClose ? CLOSE_OP_TEXT : "", withClose ? CLOSED_VIEW_TEXT : "", diff ? CONVERSATION_DIFF : CONVERSATION_FULL, TOPIC_DEF[granularity], GRANULARITY_TEXT[granularity], PREFER_UPDATE[granularity]);
  // 次の呼び出しで送るプロンプト。query の最初の呼び出しでは全体、それ以降は（diff のとき）前回からの変更
  const lastTouched = new Map<string, number>();
  const stats = (input: DiffInput) => granularity === "v3" ? topicStatsV3(input.map, input.fresh.at(-1)!.end, closedSet, lastTouched) : granularity === "v2" ? topicStats(input.map, input.fresh.at(-1)!.end, closedSet) : mapStats(input.map, input.fresh.at(-1)!.end);
  const promptFor = (input: DiffInput, q: Open | undefined) =>
    diff && q?.sent && q.calls < QUERY_RENEW_CALLS
      ? buildDiffPrompt(input, renderChanges(q.sent.map, q.sent.closed, input.map, closedSet), stats(input))
      : buildPrompt(input, closedSet, style, stats(input));
  const SCHEMA = makeSchema(withClose);
  const closedSet = new Set<string>();
  const known = new Set<string>();
  let touchedBefore = new Set<string>(); // 直前の差分更新で変わったノード
  const ancestors = (m: MeetingMap, id: string) => { const out: string[] = []; for (let c = m.nodes[id]; c; c = c.parent ? m.nodes[c.parent] : undefined) out.push(c.id); return out; };
  const log = (e: object) => closesLog && appendFileSync(closesLog, JSON.stringify(e) + "\n");
  // 応答の操作を当てた結果から、済みの開き直しと閉じるを決め、閉じるを取り除いた操作を返す
  const settleClosed = (input: DiffInput, ops: Op[]): Op[] => {
    for (const r of [...input.recent, ...input.fresh]) known.add(r.id);
    const closes = ops.filter((o) => (o as { op: string }).op === "close") as unknown as { op: "close"; node: string }[];
    const rest = ops.filter((o) => (o as { op: string }).op !== "close");
    const before = input.map;
    const after = applyOps(before, rest, known).map;
    const touched = new Set<string>();
    for (const id of after.order) {
      const a = after.nodes[id]!, b = before.nodes[id];
      if (!b || a.evidence.length !== b.evidence.length || a.text !== b.text || a.parent !== b.parent || a.planStatus !== b.planStatus) touched.add(id);
    }
    for (const id of before.order) if (!after.nodes[id]) touched.add(before.nodes[id]!.parent ?? ROOT_ID);
    const at = input.fresh.at(-1)!.end;
    for (const id of touched) for (const anc of ancestors(after, id)) if (closedSet.delete(anc)) log({ at, type: "reopen", node: anc, text: after.nodes[anc]?.text, by: id });
    const sub = (id: string): string[] => [id, ...children(after, id).flatMap((c) => sub(c.id))];
    for (const c of closes) {
      const n = after.nodes[c.node];
      if (!n || (n.kind !== "議題" && n.kind !== "論点")) { log({ at, type: "close-dropped", node: c.node, reason: "議題か論点ではない" }); continue; }
      const recentHit = sub(c.node).find((id) => touched.has(id) || touchedBefore.has(id));
      if (recentHit) { log({ at, type: "close-dropped", node: c.node, text: n.text, reason: `子孫 ${recentHit} に根拠が足されたばかり` }); continue; }
      closedSet.add(c.node);
      log({ at, type: "close", node: c.node, kind: n.kind, text: n.text });
    }
    for (const id of touched) for (const anc of ancestors(after, id)) lastTouched.set(anc, at);
    touchedBefore = touched;
    return rest;
  };

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
    const content = promptFor(input, q);
    q.calls++;
    q.sent = { map: input.map, closed: new Set(closedSet) };
    q.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
    try {
      for (;;) {
        const { value: m, done } = await Promise.race([q.output.next(), q.aborted]);
        if (done) throw new Error("差分更新の結果が無い");
        if (m.type !== "result") continue;
        if (m.subtype === "success" && m.structured_output) return { ops: settleClosed(input, (m.structured_output as { ops: Op[] }).ops) };
        throw new Error(`差分更新に失敗: ${m.subtype}`);
      }
    } catch (e) {
      discard(q); // 失敗した query は使い続けず、次の呼び出しで開き直す
      throw e;
    }
  };

  return {
    update,
    closedSet,
    prompt: (input: DiffInput) => promptFor(input, current),
    close() {
      closed = true;
      if (current) discard(current);
    },
  };
}
