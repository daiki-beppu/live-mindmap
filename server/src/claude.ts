// 差分更新（Claude）。Sonnet 5.5 を Agent SDK で呼ぶ。認証は利用者の ANTHROPIC_API_KEY（ADR 0004）。
// Claude の呼び出しはこの関数の後ろに閉じる（ADR 0003）。プロンプトは試作 v6 の方針。
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Context, Effect, Exit, Layer, Option, Queue, Ref, Schema, Scope, Stream } from "effect";
import { children, DiffOutput, DiffUpdater, openChildCounts, pointStatus, ROOT_ID, type DiffInput, type MeetingMap, type Remark, type ScreenChange } from "./core/index.ts";

const MODEL = "claude-sonnet-5-5";

// noop にしてよい発言の範囲。noop の条件の定義はここだけに書く（SYSTEM の「# noop にする範囲」に 1 回埋め込む）。
export const NOOP_SCOPE = `noop にしてよいのは、新しい発言が次の 4 つだけでできているときに限る。
- 相づち: 内容を足さない短い応答。賛否や理由を述べていれば相づちではない。
- 進行の段取り: 会議の運び方についての発言（開始・終了・次の話への切り替え・順番・時間・画面共有や接続の操作）。話題の中身は含まない。
- 聞き取れない断片: 誤認識や途切れで、意味を復元できない発言。
- 同じ内容の言い直し: 直前の発言やマップにすでにある内容を、新しい情報を足さずに繰り返す発言。
これ以外（紹介、説明、体験談、おすすめ、質問と答え、脱線した話題など）は noop にせず、マップに残す。新しい発言に 4 つ以外の部分があれば、その部分を反映する。`;

// 目安の数字。SYSTEM と議題の一覧の両方に出すので、ここに 1 つだけ置く
const TOPIC_NODES = "15〜20";
const SIBLINGS_MAX = 5;
// 議題の一覧で名指しする親の境目。上限を超えてからでは遅く、上限ちょうどの親が評価の 1 再生に 9〜12 個あったので、上限ちょうどから出す
const SIBLINGS_NEAR = SIBLINGS_MAX;

// system は毎回同じ文字列にして、前置きをキャッシュに乗せる
const SYSTEM = `あなたは会議のマインドマップを継続的に組み立てる担当者です。
会議の文字起こしが少しずつ届きます。毎回、現在のマップと新しい発言を読み、マップへの差分操作だけを返してください。マップを作り直してはいけません。

# マップの語彙
- マップは会議をルートとする木。ルートの id は「現在のマップ」の先頭に書いてあり、最初の議題はルートの子に add する。ノード同士の関係は親子だけ。
- 議題: 会議で扱う話題のまとまり。答えを出す対象ではない。議題の下にも議題を置ける（入れ子）。
- 論点: 会議の中で答えを出すべき問い。決定を子に持つと「決定済み」、持たなければ「未決」。
- 案: 論点への答えの候補、または議題の中で出た自由なアイデア。状態は 検討中 / 却下。
- 決定: 論点に対して会議で出した答え。親は必ず論点。子を持たない。採用した案の内容は決定の本文に書く。
- 課題: 問題や懸念の記述。答えを出すべき問いになったら論点として扱う。
- TODO: 会議で決まった、誰かが後で行う作業。担当者（会話に出た名前）と期限は任意。子を持たない。
- 要点: 議題の中で共有された中身。紹介、体験談、おすすめ、質問とその答えを表す。答えを出す対象でも、問題の指摘でも、答えの候補でもない。要点の下に、その中身を具体化する要点（具体例・数字・手順・経緯）を置ける。

# 差分操作
- add: 親・種別・本文・根拠（発言 id を 1 つ以上）を指定してノードを作る。ref に仮 id（例 "a1"）を付けると、同じ応答の後続の操作から親として参照できる。仮 id は既存ノードの id（n1 など）と重ねない。論点を解決するには、その論点の子に決定を add する。
- update: ノードに根拠を足す。本文を変えるのは方針の「本文」の 3 つの場合だけで、それ以外は text を渡さない。案の状態（検討中 / 却下）の切り替えもこれで表す。種別は変えられない。
- combine: 同じ種別のノード from を into にまとめる。from の根拠と子は into に移る。
- move: ノードの親を変える。子孫も一緒に移る。
- delete: 誤認識や読み違いで作った、子を持たないノードを消す。却下された案は削除せず update で 却下 にする。
- close: 議題か論点を「済み」にする。使うときは方針の「閉じるの出し方」に従う。根拠は持たない。済みの議題・論点やその子孫に add・update・combine・move をすると、自動で話し中に戻る（開き直す操作は無い）。話が戻ってきたら、畳まれていても見えている id にそのまま add・update する。
- noop: 新しい発言を見たうえで、マップを変えないと判断したことを表す。

# 方針
## 粒度
- マップは画面共有で参加者が読み、会議の後に見返す。毎回添える「議題の一覧」を見て、話し中の議題の大きさを保つ。
- 親とは別の主張（別の理由・別の懸念・派生した案）は、子ノードにする。要点の補足（具体例・数字・手順・経緯）は、親の要点を言い直さず、その要点の子の要点として add し、右に伸ばす。同じ主張の繰り返し・言い換えは、ノードを作らず根拠だけの update にする。
- 課題の子に課題を連ねない。

## 本文
- 本文は 40 字以内の日本語の名詞句か一文。発言の言い回しをそのまま写さない。親の要点の本文に例や経緯を追記・言い直ししない（補足は子の要点にする）。子の要点の本文は、補足の中身を短く書く。
- update で本文を変えるのは、誤認識・読み違いの修正、質問に答えが出たとき、案の状態（検討中 / 却下）の切り替えの 3 つのときだけ。そのときは追記せず全文で置き換える。それ以外の update は根拠を足すだけで、text を渡さない。

## 決定と TODO
- 「〜にしましょう」「〜を結論とする」「〜を基準にする」のような合意は決定にする。案として置かない。答えている論点が無ければ、先に論点を add してからその子に決定を add する。
- 「〜さんが〜する」「〜を持ち帰る」「〜に当たる」のように、誰かが後でやると決まった作業は TODO にする。案として置かない。
- 紹介・解説・体験談・流した動画や資料の解説の中で語られた「〜にする」「〜すべき」は、会議の合意でも作業の割り当てでもない。決定や TODO にせず、要点にする。

## 決めない会議（共有・紹介・雑談）
- 決定がなくても、話題が変わるたびに議題として立て、その下に要点を add する。紹介、体験談、おすすめ、質問とその答えは、それぞれ議題の下の要点として残す。
- 質問とその答えは 1 つの要点にまとめる。答えが後から出たら、その要点の本文を update で置き換える。
- 要点を分けるのは、紹介した物・体験・おすすめ・質問が別のときだけ。同じ紹介や体験談の補足（具体例、値段、手順、数字、経緯）は、親の要点を言い直さず、その要点の子の要点として add する。

## 議題の立て方
- ルートは会議そのもの。会議の目的や会議全体で答えようとしている問い（例「どんな本を作るか」）は、議題にも論点にもしない。その下位の話題をそれぞれ議題として立てる。
- 話の対象（扱う物・写真・発表・発表者）が変わったら、短い話でも新しい議題を立てる。紹介や発表が 1 つずつ続く場面では、1 つ（1 人）ごとに議題を立てる。
- 1 つの発表・紹介の中の例・派生案・反応は、その議題の下に案や要点として置く。番号を振って議題を分けない。
- 新しい問いが今の議題名に収まるなら論点、収まらないなら新しい議題にする。議題名は、名前だけで中身が分かるようにする。
- 前の議題の話に戻ったら、その議題の id に add・update する。済みの議題は一覧に出ないので、現在のマップや変更に出てきた id を使う。

## 議題の入れ子
- 対象が 1 つずつ変わる流れでは、流れのまとまりを親の議題に、対象ごとの議題をその子に置く。深さの上限は無い。
- まとまりが始まると分かったら、先に親の議題を立て、最初の対象から親の下に置く。気づかずに 1 つ目を会議の直下に立てていたら、2 つ目のときに親の議題を立て、1 つ目だけ move する。それ以外では動かし直さない。
- 親の議題の下に置くのは、対象ごとの議題と、まとまり全体についての論点・要点。
- 入れ子は新しい議題を立てる代わりではない。議題名に収まらない新しい問いは、入れ子にせず新しい議題として立てる。
- 休憩を挟んで同じ種類の対象が出てきたら、同じ親の議題の下に足す。
- 親の議題の済みも close で決める。

## 目安
- 会議全体のノード数に目安は設けない。
- 1 つの議題の話し中の部分（済みの論点の下と、子の議題の下は数えない）は、${TOPIC_NODES} ノード。超えそうなら、答えが出た論点や話の移った論点を閉じるか、これからの話を新しい議題として立てる。すでにあるノードを別の議題へ動かし直さない。
- 1 つの親の下の話し中の兄弟は、種別によらず ${SIBLINGS_MAX} つまで（ルート直下も含む。済みは数えない）。上限に近い親と超えた親は、毎回の「議題の一覧」に id・本文・話し中の子の数つきで名指しで出る。
- 名指しされた親の下に足したくなったら、新しいノードを最も近い兄弟の子として add する。親が要点のときは、要点は close できない（close できるのは議題と論点だけ）ので、新しい要点を最も近い兄弟の要点の子として add する。親が議題や論点なら、新しい議題を立てるか、話の移ったものを閉じてもよい。上限を守るための move はしない。

## 閉じるの出し方
- 毎回、「議題の一覧」の話し中の議題と、今の議題の中の論点を見直す。最後に触れてからしばらく経ち、話が明らかに別へ移って戻る気配がないものを close する。迷うときは閉じない。
- 新しい議題に移ったばかりの応答では前の議題を閉じず、次の応答以降で閉じる。
- 最後に触れた分は判断の材料であり、何分で閉じるという規則ではない。

## その他
- 文字起こしには誤認識がある。意味が通るように読み替えてよいが、話されていない内容を足さない。
- 根拠には「新しい発言」の id を使う。直前の発言は文脈を理解するためのもので、根拠に使ってよいのは新しい発言の続きとして必要な場合だけ。
- 1 回の応答の操作は少なく保つ。同じ主張の繰り返し・言い換えで迷ったら、新しいノードを増やさず、根拠を足す update（text を渡さない）にする。

# noop にする範囲
${NOOP_SCOPE}

# 済みの議題の見え方
現在のマップで「（済み）」が付いた議題・論点は畳んである。配下の案・課題・要点は省いて見せている。そこへ話が戻ったら、見えている議題・論点の id に add・update する。同じ議題や論点を新しく作り直さない。

# 会話の扱い
この会話の最初のメッセージには、現在のマップの全体が載る。2 通目からは、マップの全体の代わりに前回からのマップの変更だけが載る。変更には、前回の操作を当てた結果（add で付いた id、update 後の本文、統合・移動・削除）が含まれる。最初のマップにこれまでの変更を順に当てたものが今のマップ。ノードは変更に書かれた id で指す

# 共有画面
メッセージの先頭に「## 共有画面 [mm:ss] から」の見出しと画像が付くことがある。発表者が画面共有で映したものを表す。見出しが「## 共有画面：なし（[mm:ss] から）」なら、その時刻から何も映っていない。
- 添えた画面は、次の画面が添えられるまで映り続けている。
- 時刻つきの画面が複数あるときは、発言の時刻に映っていたものを使う。
- 画面は、「この図」「ここ」のように画面を指す発言の中身を読み解くためだけに使う。画面に映っただけの中身は、マップに書かない。根拠にするのは発言だけ。
- 参加者の顔の一覧だけが映っているときは、共有画面は無いものとして扱う。`;


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
  return foldedOutlineLines(map, ROOT_ID, 0).join("\n");
}

// id 自身を畳まない状態の起点として、その下を済みの畳み方でたどった行を返す。全体のアウトラインと、畳んだ中から出たノードの中身で共有する
function foldedOutlineLines(map: MeetingMap, id: string, depth: number): string[] {
  const lines: string[] = [];
  const walk = (nid: string, d: number, folded: boolean) => {
    // 省いた段も字下げに数える（元の木の深さを保つ）
    if (!(folded && FOLDED_KINDS.has(map.nodes[nid]!.kind))) lines.push(outlineLine(map, nid, d));
    const nextFolded = folded || !!map.nodes[nid]!.talkStatus;
    for (const c of children(map, nid)) walk(c.id, d + 1, nextFolded);
  };
  walk(id, depth, false);
  return lines;
}

// 自分を除く祖先に、済みのものがあるか
function underClosed(map: MeetingMap, id: string): boolean {
  for (let p = map.nodes[id]!.parent; p !== null; p = map.nodes[p]!.parent) {
    if (map.nodes[p]!.talkStatus) return true;
  }
  return false;
}

// 前回送ったマップ prev から今のマップ cur への変更を行ごとに出す。操作ではなくマップ同士を比べるので、適用できなかった操作は出ない
function renderChanges(prev: MeetingMap, cur: MeetingMap): string {
  const lines: string[] = [];
  const ids = (m: MeetingMap) => m.order.filter((id) => id !== ROOT_ID && m.nodes[id]);
  for (const id of ids(prev)) {
    if (!cur.nodes[id]) lines.push(`- 削除 ${id}: 削除（統合された場合は統合先に子と根拠が移った）`);
  }
  // 前回は済みの下で畳まれていて、今回は畳まれない場所へ親が変わったノード。AI はまだ中身を知らない
  // cur で済みの下に留まった移動は、まだ畳まれているので含めない
  const surfaced = new Set(ids(cur).filter((id) => {
    const old = prev.nodes[id];
    return !!old && cur.nodes[id]!.parent !== old.parent && underClosed(prev, id) && !underClosed(cur, id);
  }));
  // 祖先が出るなら、子孫はその中身に含まれる
  const hasSurfacedAncestor = (id: string) => {
    for (let p = cur.nodes[id]!.parent; p !== null; p = cur.nodes[p]!.parent) if (surfaced.has(p)) return true;
    return false;
  };
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
    if (surfaced.has(id) && !hasSurfacedAncestor(id)) {
      lines.push(`- ${id} 畳んだ中から出た。中身:`);
      lines.push(...foldedOutlineLines(cur, id, 1));
    }
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

// 議題 id の下をたどり、その議題の話し中の部分のノード数と、直下の議題（途中の論点・案などは飛ばして最初に当たる議題）を返す。
// 議題に当たったらそれ自身は子の議題として返し、配下は数えない。済みの論点は 1 ノードとして数え、配下のノードは数えない。
// ただし済みの論点の下の議題は探し続ける（外すのは済みの議題とその下だけ）
function scanTopic(map: MeetingMap, id: string): { nodes: number; topics: string[] } {
  let nodes = 0;
  const topics: string[] = [];
  const walk = (pid: string, counting: boolean) => {
    for (const c of children(map, pid)) {
      if (c.kind === "議題") { topics.push(c.id); continue; }
      if (counting) nodes++;
      walk(c.id, counting && !c.talkStatus);
    }
  };
  walk(id, true);
  return { nodes, topics };
}

// 話し中の子が境目以上の親を、種別によらず 1 行ずつ出す。行頭を「- n12 」にしない（議題の行と区別するため）
function renderCrowdedParents(map: MeetingMap): string[] {
  const counts = openChildCounts(map);
  return map.order
    .filter((id) => map.nodes[id] && (counts.get(id) ?? 0) >= SIBLINGS_NEAR)
    .map((id) => {
      const n = counts.get(id)!;
      const state = n > SIBLINGS_MAX ? `上限 ${SIBLINGS_MAX} を超えた` : `上限 ${SIBLINGS_MAX} に達した`;
      return `- 親 ${id} ${map.nodes[id]!.kind}「${map.nodes[id]!.text}」: 話し中の子 ${n}（${state}）`;
    });
}

// 話し中の議題を木のまま字下げした一覧。済みの議題と、済みの議題の下の議題は出さず、件数だけを見出しに出す。
// 毎回、その時点のマップから作り直す（状態は持たない）
function renderTopicList(map: MeetingMap): string {
  const rows: string[] = [];
  const walk = (id: string, depth: number) => {
    const { nodes, topics } = scanTopic(map, id);
    const open = topics.filter((t) => !map.nodes[t]!.talkStatus);
    const touched = map.nodes[id]!.touchedAt;
    const info = [
      ...(topics.length ? [`まとまり・子の議題 話し中 ${open.length}・済み ${topics.length - open.length}・まとまり自体の話し中 ${nodes} ノード`] : [`話し中 ${nodes} ノード`]),
      ...(touched === undefined ? [] : [`最後に触れた ${Math.floor(touched / 60)} 分`]),
    ];
    rows.push(`${"  ".repeat(depth)}- ${id} ${map.nodes[id]!.text}（${info.join("・")}）`);
    for (const t of open) walk(t, depth + 1);
  };
  const top = scanTopic(map, ROOT_ID).topics.filter((t) => !map.nodes[t]!.talkStatus);
  for (const t of top) walk(t, 0);
  const closedCount = Object.values(map.nodes).filter((n) => n.kind === "議題" && n.talkStatus).length;
  const shown = rows.length;
  return [
    `## 議題の一覧（話し中 ${shown}・済み ${closedCount}。済みと、済みの議題の下は省略）`,
    ...(rows.length ? rows : ["（なし）"]),
    ...renderCrowdedParents(map),
    `目安: 1 つの議題の話し中の部分は ${TOPIC_NODES} ノード。1 つの親の下の話し中の兄弟は種別によらず ${SIBLINGS_MAX} つまで（ルート直下も含む。済みは数えない）`,
  ].join("\n");
}

// previous（その query に前回送ったマップ）が無ければ全体のアウトライン、あれば前回からの変更を載せる
export function buildPrompt({ map, recent, fresh }: DiffInput, previous?: MeetingMap): string {
  return [
    renderTopicList(map), "",
    ...(previous
      ? [`## 前回からのマップの変更（ルートの ID: ${ROOT_ID}）`, renderChanges(previous, map)]
      : [`## 現在のマップ（ルートの ID: ${ROOT_ID}）`, renderOutline(map)]), "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map(fmtRemark).join("\n") : "（なし）", "",
    "## 新しい発言", fresh.map(fmtRemark).join("\n"),
  ].join("\n");
}

type ContentBlockParam = Exclude<SDKUserMessage["message"]["content"], string>[number];

// 入力に来た共有画面の列を、そのままの順で見出し（text）と画像のブロックにする。「なし」は見出しだけ。どれを添えるかは core が決める
function screenBlocks(screens: readonly ScreenChange[]): ContentBlockParam[] {
  return screens.flatMap((s): ContentBlockParam[] =>
    s.image === null
      ? [{ type: "text", text: `## 共有画面：なし（[${fmtTime(s.start)}] から）` }]
      : [
          { type: "text", text: `## 共有画面 [${fmtTime(s.start)}] から` },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(s.image.bytes).toString("base64") } },
        ],
  );
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
  readonly scope: Scope.Closeable;
  readonly input: Queue.Queue<SDKUserMessage, Cause.Done>;
  readonly query: Query;
  readonly output: AsyncIterator<SDKMessage>;
  readonly calls: number;
  readonly sent?: MeetingMap; // この query に前回送ったマップ。開き直しで Open ごと捨てられ、次の最初のメッセージで再び全体を送る
};

// 1 つのセッション（会議）で、開いたままの query を使い回す差分更新。
// 最初の呼び出しで開き、回数・失敗・ストリームの終わりで開き直し、セッションの Scope を閉じると閉じる。
// 呼び出しは同時に 1 つしか走らない前提（core の session が直列に呼ぶ）。
export const layerClaude = Layer.effect(
  DiffUpdater,
  Effect.gen(function* () {
    const sdk = yield* AgentSdk;
    const sessionScope = yield* Scope.Scope;
    const current = yield* Ref.make(Option.none<Open>());
    const closed = yield* Ref.make(false);
    yield* Effect.addFinalizer(() => Ref.set(closed, true));

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
      Ref.update(current, (c) => (Option.isSome(c) && c.value.scope === o.scope ? Option.none() : c)).pipe(
        Effect.andThen(Scope.close(o.scope, Exit.void)),
      );

    // 今の query が o と同じ（scope が同じ）ときだけ、Open を新しい値に置き換える。discard した後の query は戻さない
    const advance = (o: Open, f: (x: Open) => Open) =>
      Ref.update(current, (c) => (Option.isSome(c) && c.value.scope === o.scope ? Option.some(f(c.value)) : c));

    const next = (o: Open) =>
      Effect.tryPromise({
        try: () => o.output.next(),
        catch: (e) => new ClaudeQueryFailed({ message: messageOf(e), cause: e }),
      });

    const awaitResult = Effect.fnUntraced(function* (o: Open): Effect.fn.Return<DiffOutput, ClaudeQueryFailed | ClaudeResultFailed | DiffOutputInvalid> {
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

    const update = Effect.fn("DiffUpdater.update")(function* (input: DiffInput) {
      if (yield* Ref.get(closed)) return yield* Effect.die(new Error("差分更新の updater は閉じています"));
      let c = yield* Ref.get(current);
      if (Option.isSome(c) && c.value.calls >= QUERY_RENEW_CALLS) {
        yield* discard(c.value);
        c = Option.none();
      }
      const o = Option.isSome(c) ? c.value : yield* open;
      if (Option.isNone(c)) yield* Ref.set(current, Option.some(o));
      return yield* Effect.gen(function* () {
        yield* advance(o, (x) => ({ ...x, calls: x.calls + 1 }));
        const prompt = buildPrompt(input, o.sent);
        // 開き直した query の最初のメッセージ（o.sent が未設定）にだけ、core が載せた送り直す画面を、新しく添える画面の前に付ける。
        // 画面のブロックが無い呼び出しは、今までどおり文字列のまま
        const blocks = [...(o.sent === undefined ? screenBlocks(input.previousScreens ?? []) : []), ...screenBlocks(input.screens ?? [])];
        const content = blocks.length ? [...blocks, { type: "text" as const, text: prompt }] : prompt;
        yield* Queue.offer(o.input, { type: "user", message: { role: "user", content }, parent_tool_use_id: null });
        yield* advance(o, (x) => ({ ...x, sent: input.map }));
        return yield* awaitResult(o);
      }).pipe(
        // 失敗・defect・中断のどれでも、その query は使い続けず、次の呼び出しで開き直す
        Effect.onError(() => discard(o)),
      );
    });

    return DiffUpdater.of({ update });
  }),
);
