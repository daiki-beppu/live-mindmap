// Claude の差分更新プロンプト。Agent SDK に依存せず、文と出力の形を所有する。
import { Schema } from "effect";
import { children, DiffOperations, groupSize, type GroupNode, openChildCounts, pointStatus, ROOT_ID, type DiffInput, type MapNode, type MeetingMap, type PreviousResponse } from "./core/index.ts";
import { nameOfSpeaker, remarkLine } from "./remarkLine.ts";

// noop にしてよい発言の範囲。noop の条件の定義はここだけに書く（SYSTEM の「# noop にする範囲」に 1 回埋め込む）。
export const NOOP_SCOPE = `noop にしてよいのは、新しい発言が次の 4 つだけでできているときに限る。
- 相づち: 内容を足さない短い応答。賛否や理由を述べていれば相づちではない。
- 進行の段取り: 会議の運び方についての発言（開始・終了・次の話への切り替え・順番・時間・画面共有や接続の操作）。話題の中身は含まない。
- 聞き取れない断片: 誤認識や途切れで、意味を復元できない発言。
- 同じ内容の言い直し: 直前の発言やマップにすでにある内容を、新しい情報を足さずに繰り返す発言。
これ以外（紹介、説明、体験談、おすすめ、質問と答え、脱線した話題など）は noop にせず、マップに残す。新しい発言に 4 つ以外の部分があれば、その部分を反映する。`;

// 目安の数字。SYSTEM と議題の一覧の両方に出すので、ここに 1 つだけ置く
const TOPIC_NODES = "15〜20";
// 議題の一覧で、子の議題を立てるよう名指しする境目（目安の上限）
const TOPIC_NODES_MAX = 20;
const SIBLINGS_MAX = 5;
// 議題の一覧で名指しする親の境目。合図を超えてからでは遅く、合図ちょうどの親が評価の 1 再生に 9〜12 個あったので、合図ちょうどから出す
const SIBLINGS_NEAR = SIBLINGS_MAX;

// system は毎回同じ文字列にして、前置きをキャッシュに乗せる
export const SYSTEM = `あなたは会議のマインドマップを継続的に組み立てる担当者です。
会議の文字起こしが少しずつ届きます。毎回、現在のマップと新しい発言を読み、マップへの差分操作だけを返してください（話者の名前を推定できたときは、下の「話者の名前」の names も返してよい）。マップを作り直してはいけません。

# マップの語彙
- マップは会議をルートとする木。ルートの id は「現在のマップ」の先頭に書いてあり、最初の議題はルートの子に add する。ノード同士の関係は親子だけ。
- 議題: 会議で扱う話題のまとまり。答えを出す対象ではない。議題の下にも議題を置ける（入れ子）。
- 論点: 会議の中で答えを出すべき問い。決定を子に持つと「決定済み」、持たなければ「未決」。論点の下に、その論点から派生した問い（元の問いの一部を別に問うもの）を論点として置ける（派生の論点）。状態はそれぞれの論点が持ち、派生の論点が決まっても元の論点は決定済みにならない。
- 案: 論点への答えの候補、または議題の中で出た自由なアイデア。状態は 検討中 / 却下。
- 決定: 論点に対して会議で出した答え。親は必ず論点。子を持たない。採用した案の内容は決定の本文に書く。
- 課題: 問題や懸念の記述。答えを出すべき問いになったら論点として扱う。
- TODO: 会議で決まった、誰かが後で行う作業。担当者（会話に出た名前、または担当の話者）と期限は任意。子を持たない。
- 要点: 議題の中で共有された中身。紹介、体験談、おすすめ、質問とその答えを表す。答えを出す対象でも、問題の指摘でも、答えの候補でもない。要点の下に、その中身を具体化する要点（具体例・数字・手順・経緯）を置ける。
- 子: 親を具体化する・親に答える・親から派生したノード。親との関係を一言（「〜の例」「〜への答え」「〜への懸念」）で言える。
- 兄弟: 同じ親について並ぶ、別々の中身（同じ論点への別の案、同じ議題の別の紹介、同じ要点の別の具体例）。

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
- 親子は意味で決め、話の順は形に表さない。親は、その発言が最も直接に具体化する・答える・派生する元のノードにする。直前に足したノードを親にするのではない。
- 親との関係を一言（「〜の例」「〜への答え」「〜への懸念」）で言えないなら、そのノードの子にしない。直前に話されたことの続きというだけでは子にしない。
- 同じ親への 2 つ目以降の具体化は、前の具体化の子ではなく、同じ親の下に兄弟として並べる。子の子にするのは、具体化そのものをさらに具体化するときだけ。話が先へ進んだもの（次の紹介・体験・別の質問）は、議題の直下の新しい要点にする。
- 親とは別の主張（別の理由・別の懸念・派生した案）は、子ノードにする。要点の補足（具体例・数字・手順・経緯）は、親の要点を言い直さず、それが具体化する要点の子の要点として add する。同じ主張の繰り返し・言い換えは、ノードを作らず根拠だけの update にする。
- 課題の子に課題を連ねない。

## 本文
- 本文は 40 字以内の日本語の名詞句か一文。発言の言い回しをそのまま写さない。親の要点の本文に例や経緯を追記・言い直ししない（補足は子の要点にする）。子の要点の本文は、補足の中身を短く書く。
- update で本文を変えるのは、誤認識・読み違いの修正、質問に答えが出たとき、案の状態（検討中 / 却下）の切り替えの 3 つのときだけ。そのときは追記せず全文で置き換える。それ以外の update は根拠を足すだけで、text を渡さない。

## 決定と TODO
- 「〜にしましょう」「〜を結論とする」「〜を基準にする」のような合意は決定にする。案として置かない。答えている論点が無ければ、先に論点を add してからその子に決定を add する。
- 「〜さんが〜する」「〜を持ち帰る」「〜に当たる」のように、誰かが後でやると決まった作業は TODO にする。案として置かない。
- TODO の担当者は、会話に出た名前を assignee に書く。名前が出ないまま話者が自分から引き受けたとき（「私がやります」）に限り、その話者を assigneeSpeaker に書く（発言の行頭の話者。例 相手 A / 自分）。「じゃあお願いします」のように頼まれた側を、話者から推し量って担当者にしない。担当者はその TODO を言い出した話者とは限らない。担当者が後から分かったら、TODO を update して assignee か assigneeSpeaker を渡す。名前が分かったら assignee を渡す。
- 紹介・解説・体験談・流した動画や資料の解説の中で語られた「〜にする」「〜すべき」は、会議の合意でも作業の割り当てでもない。決定や TODO にせず、要点にする。

## 決めない会議（共有・紹介・雑談）
- 決定がなくても、話題が変わるたびに議題として立て、その下に要点を add する。紹介、体験談、おすすめ、質問とその答えは、それぞれ議題の下の要点として残す。
- 質問とその答えは 1 つの要点にまとめる。答えが後から出たら、その要点の本文を update で置き換える。
- 要点を分けるのは、紹介した物・体験・おすすめ・質問が別のときだけ。同じ紹介や体験談の補足（具体例、値段、手順、数字、経緯）は、親の要点を言い直さず、その要点の子の要点として add する。同じ要点への補足が続けば、前の補足の子ではなく、その要点の下に兄弟として並べる。

## 議題の立て方
- ルートは会議そのもの。会議の目的や会議全体で答えようとしている問い（例「どんな本を作るか」）は、議題にも論点にもしない。その下位の話題をそれぞれ議題として立てる。
- 話の対象（扱う物・写真・発表・発表者）が変わったら、短い話でも新しい議題を立てる。紹介や発表が 1 つずつ続く場面では、1 つ（1 人）ごとに議題を立てる。
- 1 つの発表・紹介の中の例・派生案・反応は、その議題の下に案や要点として置く。番号を振って議題を分けない。
- 新しい問いが今の議題名に収まるなら論点、収まらないなら新しい議題にする。ただし「議題の一覧」で名指しされた議題では、「目安」の規則を先に効かせる。議題名は、名前だけで中身が分かるようにする。
- 同じ対象の話でも、話の焦点が今の議題名に収まらなくなったら、新しい議題を立てる。このときは今の議題の子の議題にする（「議題の入れ子」）。
- 前の議題の話に戻ったら、その議題の id に add・update する。済みの議題は一覧に出ないので、現在のマップや変更に出てきた id を使う。

## 議題の入れ子
- 対象が 1 つずつ変わる流れでは、流れのまとまりを親の議題に、対象ごとの議題をその子に置く。深さの上限は無い。
- 1 つの議題の話が大きくなり、同じ対象のまま焦点が移っていくときも、その議題を流れのまとまりとし、次の話から焦点ごとの議題をその子に立てる。それまでの中身はまとまりの議題の下に残し、動かさない。ルートの直下に「〜の続き」の議題を並べない。
- まとまりが始まると分かったら、先に親の議題を立て、最初の対象から親の下に置く。気づかずに 1 つ目を会議の直下に立てていたら、その議題は動かさず、2 つ目のときに親の議題を立ててその下に置く。立てた議題は動かし直さない。
- 親の議題の下に置くのは、対象ごとの議題と、まとまり全体についての論点・要点。
- 入れ子にするのは、この 2 つの流れのときだけ。議題名に収まらない新しい問いは、入れ子にせず新しい議題として立てる。
- 休憩を挟んで同じ種類の対象が出てきたら、同じ親の議題の下に足す。
- 親の議題の済みも close で決める。

## 目安
- 会議全体のノード数に目安は設けない。
- 1 つの議題の話し中の部分（論点は 1 ノードと数え、論点の下は数えない。子の議題の下も数えない）は、${TOPIC_NODES} ノード。論点の下は、論点ごとに別に数える（次の論点の目安）。目安を超えた議題は、毎回の「議題の一覧」に名指しで出る。
- 名指しされた議題の直下には、新しいものを立てない。新しく立つ論点・案・課題・要点は、議題名に収まるかどうかによらず、焦点ごとの子の議題を立ててその下に置く（「議題の入れ子」）。今あるノードへの答え・具体化は、これまでどおりそのノードの下に置く（名指しされた案・課題・要点の下は除く。次の次の目安に従う）。答えが出た論点や話の移った論点を閉じてもよい。すでにあるノードを別の議題へ動かし直さない。
- 1 つの論点の話し中の部分（派生の論点の下は数えない）も、${TOPIC_NODES} ノードが目安。目安を超えた論点は、毎回の「議題の一覧」に名指しで出る。名指しされた論点で、答えが元の問いの一部を別に問い始めたら、次の答えからその論点の子に派生の論点を立て、その下に置く。それまでの答えは動かさない。派生の問いが無く、同じ問いへの別々の案や答えが続くだけなら、そのまま兄弟として並べてよい。派生の問いを無理に作らない。「〜系の案」のような分類のためだけの親は立てない。
- 1 つの案・課題・要点の話し中の配下（論点は 1 ノードと数え、論点の下は数えない。子の議題の下も数えない）も、${TOPIC_NODES} ノードが目安。目安を超えたものは、毎回の「議題の一覧」に名指しで出る（入れ子になっていれば、超えたものすべて）。名指しされた案・課題・要点の下には、直下にも孫以下にも新しいノードを足さない（根拠を足す update はよい）。その続きの具体化は、一番近い祖先の議題の下に子の議題を立てて置く（「議題の入れ子」）。子の議題の名前は、元のノードと焦点が分かるもの（「〜案の運用」「〜の懸念への対処」）にし、同じ焦点の続きは同じ子の議題に足す。山が論点の下にあっても同じで、派生の論点にはしない。すでにあるノードは動かさない。
- 1 つの親の下の話し中の兄弟（子の議題も数える）が ${SIBLINGS_MAX} つになったら、それは上限ではなく、まとめる親を考える合図。その親は、毎回の「議題の一覧」に id・本文・話し中の子の数つきで名指しで出る。
- 名指しされた親の下に足したくなったら、1 段下へ潜らせず、上へ逃がす。親が議題なら、次の話から子の議題を立てる（${SIBLINGS_MAX} を超えてよい）。親が要点や論点なら、意味が合えば議題の直下（名指しされた議題なら子の議題の下）に置き、合わなければそのまま兄弟を増やしてよい（つながりの違う場所に置くくらいなら超える）。論点や議題は、話の移ったものを閉じてもよい。合図に合わせるための move はしない。

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

# 話者の名前
発言の行頭の「相手 A」「相手 B」のラベルに、名前を付けられることがある。確かなときだけ names に出す。名前の無い回は names を省く。誤った名前は、名前がないより悪い。
- 根拠にしてよいのは次の 2 つだけ。basis に種類を書く。
  - 名乗り: そのラベル本人が名乗った発言（「田中です」）。
  - 呼びかけへの応答: 名前での呼びかけ（「田中さん、どうですか」）の直後に、そのラベルが応じた発言。呼びかけの次に話したラベルだけが対象。
- evidence には、そのラベルが話した名乗りまたは応答の発言の id を書く。label には行頭の「相手 X」を書く（「（名前）」の部分は除く）。
- 次のときは出さない: 複数人への呼びかけ、呼ばれた人と別の人が答えたとき、推測、話題に出ただけの名前、仮の名前（「田中?」）、画面に出ている名前。
- 「自分」と、ラベルの無い「相手」には出さない。
- 名前が付いているラベル（「相手 B（田中）」）は、本人が別の名前を名乗ったときだけ付け替える。

# 済みの議題の見え方
現在のマップで「（済み）」が付いた議題・論点は畳んである。配下の案・課題・要点は省いて見せている。そこへ話が戻ったら、見えている議題・論点の id に add・update する。同じ議題や論点を新しく作り直さない。

# 会話の扱い
この会話の最初のメッセージには、現在のマップの全体が載る。2 通目からは、マップの全体の代わりに前回からのマップの変更だけが載る。変更には、前回の操作を当てた結果（add で付いた id、update 後の本文、統合・移動・削除）が含まれる。最初のマップにこれまでの変更を順に当てたものが今のマップ。ノードは変更に書かれた id で指す

# 共有画面
メッセージの先頭に「## 共有画面 [mm:ss] から」の見出しと画像が付くことがある。発表者が画面共有で映したものを表す。見出しが「## 共有画面：なし（[mm:ss] から）」なら、その時刻から何も映っていない。
- 添えた画面は、次の画面が添えられるまで映り続けている。
- 時刻つきの画面が複数あるときは、発言の時刻に映っていたものを使う。
- 画面は、「この図」「ここ」「一番下の行」「上から二つ目」のように画面を指す発言の中身を読み解くためだけに使う。根拠にするのは、その発言。
- 画面を指す発言をノードにするときは、指している行・点・項目を画面から特定し、そこに書かれた値（名前・数字・割合）を本文に入れる。発言が「この」「一番下」としか言っていなくても、画面で分かる中身を書く。これは「話されていない内容を足す」には当たらない。例: 部署別の残業時間の表を映して「一番下の部署が突出してます」→ 本文「物流部の残業は月 42 時間」。
- 表の 1 行を指してその行を話題にするときは、行の名前だけでなく、その行の値も本文に入れる。例: 機材の比較表を映して「次は 2 番目、これです」→ 本文「機材 2 ハンディ型：重さ 1.2kg・価格 8 万円」。
- 本文に入れるのは、発言が指した行・点の値だけ。同じ表のほかの行、同じスライドのほかの項目、スライド全体の要約は書かない。例: イベント準備の予定表を映して「一番上の会場の予約は済みました」→ 本文「5 月の会場の予約は済み」。表のほかの行（6 月・7 月…の予定）は、誰かが話すまで書かない。画面に映っただけで誰も指していない中身は、マップに書かない。
- 「さっきの表」「前のグラフ」のように、今は映っていない前の画面を指したら、前に添えた画面から読む。
- 参加者の顔の一覧だけが映っているときは、共有画面は無いものとして扱う。`;


// 1 ノードの書式（ID・種別・状態・本文・TODO の担当と期限）。アウトラインと変更で共有する。根拠は渡さない
function nodeLabel(map: MeetingMap, id: string, explicitPlanStatus = false): string {
  const n = map.nodes[id]!;
  const status = n.kind === "論点" ? `(${pointStatus(map, id)})`
    : n.kind === "案" && (n.planStatus === "却下" || explicitPlanStatus) ? `(${n.planStatus === "却下" ? "却下" : "検討中"})` : n.planStatus === "却下" ? "(却下)" : "";
  return `${n.id} ${n.kind}${status}: ${n.text}${n.kind === "TODO" ? todoSuffix(n) : ""}`;
}

// TODO の担当（名前、無ければ担当の話者）と期限。どちらも無ければ空
function todoSuffix(n: MapNode): string {
  const who = n.assignee ?? (n.assigneeSpeaker ? `担当の話者 ${n.assigneeSpeaker}` : undefined);
  const parts = [who, n.due].filter(Boolean);
  return parts.length ? ` [${parts.join(" / ")}]` : "";
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

const changeIds = (m: MeetingMap) => m.order.filter((id) => id !== ROOT_ID && m.nodes[id]);

const removedLines = (prev: MeetingMap, cur: MeetingMap): string[] =>
  changeIds(prev).filter((id) => !cur.nodes[id]).map((id) => `- 削除 ${id}: 削除（統合された場合は統合先に子と根拠が移った）`);

// 前回は済みの下で畳まれていて、今回は畳まれない場所へ親が変わったノード。AI はまだ中身を知らない
// cur で済みの下に留まった移動は、まだ畳まれているので含めない
function surfacedIds(prev: MeetingMap, cur: MeetingMap): Set<string> {
  return new Set(changeIds(cur).filter((id) => {
    const old = prev.nodes[id];
    return !!old && cur.nodes[id]!.parent !== old.parent && underClosed(prev, id) && !underClosed(cur, id);
  }));
}

// ノードごとの行。追加、または 更新 → 移動 → 畳んだ中から出た の順
// refIds は、前回の応答で作られたノードの n の ID → その応答での仮 ID。追加の行に添える
function nodeChangeLines(prev: MeetingMap, cur: MeetingMap, refIds: ReadonlyMap<string, string>): string[] {
  const surfaced = surfacedIds(prev, cur);
  // 祖先が出るなら、子孫はその中身に含まれる
  const hasSurfacedAncestor = (id: string) => {
    for (let p = cur.nodes[id]!.parent; p !== null; p = cur.nodes[p]!.parent) if (surfaced.has(p)) return true;
    return false;
  };
  const lines: string[] = [];
  for (const id of changeIds(cur)) {
    const n = cur.nodes[id]!;
    const old = prev.nodes[id];
    if (!old) {
      const ref = refIds.get(id);
      lines.push(`- 追加 ${nodeLabel(cur, id, true)} （親: ${n.parent}）${ref === undefined ? "" : `（前回の応答の仮 id ${ref}）`}`);
      continue;
    }
    const changed = n.text !== old.text || n.planStatus !== old.planStatus || n.assignee !== old.assignee || n.assigneeSpeaker !== old.assigneeSpeaker || n.due !== old.due
      || (n.kind === "論点" && pointStatus(cur, id) !== pointStatus(prev, id));
    if (changed) lines.push(`- 更新 ${nodeLabel(cur, id, true)}`);
    if (n.parent !== old.parent) lines.push(`- 移動 ${id} → 親: ${n.parent}`);
    if (surfaced.has(id) && !hasSurfacedAncestor(id)) {
      lines.push(`- ${id} 畳んだ中から出た。中身:`);
      lines.push(...foldedOutlineLines(cur, id, 1));
    }
  }
  return lines;
}

// 済みにした / 話し中に戻った（配下を全部出す）ノードの行
function talkStatusLines(prev: MeetingMap, cur: MeetingMap): string[] {
  const lines: string[] = [];
  const walk = (pid: string, depth: number) => {
    for (const c of children(cur, pid)) {
      lines.push(outlineLine(cur, c.id, depth));
      walk(c.id, depth + 1);
    }
  };
  for (const id of changeIds(cur)) {
    const closedNow = !!cur.nodes[id]!.talkStatus;
    const closedBefore = !!prev.nodes[id]?.talkStatus;
    if (!closedBefore && closedNow) lines.push(`- ${id} 済みにした`);
    if (closedBefore && !closedNow) {
      lines.push(`- ${id} 話し中に戻った。畳んでいた中身:`);
      walk(id, 1);
    }
  }
  return lines;
}

// 前回送ったマップ prev から今のマップ cur への変更を行ごとに出す。操作ではなくマップ同士を比べるので、変更の行には適用できなかった操作は出ない。
// 前回の応答で捨てた操作は、末尾の節に JSON と理由を 1 行ずつ出す（無ければ節ごと出さない）
function renderChanges(prev: MeetingMap, cur: MeetingMap, previousResponse?: PreviousResponse): string {
  const refIds = new Map(Object.entries(previousResponse?.refs ?? {}).map(([ref, id]) => [id, ref]));
  const lines = [...removedLines(prev, cur), ...nodeChangeLines(prev, cur, refIds), ...talkStatusLines(prev, cur)];
  const dropped = previousResponse?.dropped ?? [];
  return [
    lines.length ? lines.join("\n") : "（変更なし）",
    ...(dropped.length ? ["### 前回の応答で捨てた操作", ...dropped.map((d) => `- ${JSON.stringify(d.op)}（理由: ${d.reason}）`)] : []),
  ].join("\n");
}

// 計測では除く論点の配下でも、子の議題の表示は残すので探索を分ける。
function childTopics(map: MeetingMap, id: string): string[] {
  const topics: string[] = [];
  const walk = (pid: string) => {
    for (const c of children(map, pid)) {
      if (c.kind === "議題") { topics.push(c.id); continue; }
      walk(c.id);
    }
  };
  walk(id);
  return topics;
}

// 話し中の子が境目以上の親を、種別によらず 1 行ずつ出す。行頭を「- n12 」にしない（議題の行と区別するため）
function renderCrowdedParents(map: MeetingMap): string[] {
  const counts = openChildCounts(map);
  return map.order
    .filter((id) => map.nodes[id] && (counts.get(id) ?? 0) >= SIBLINGS_NEAR)
    .map((id) => {
      const n = counts.get(id)!;
      const state = n > SIBLINGS_MAX ? `合図の ${SIBLINGS_MAX} を超えた` : `合図の ${SIBLINGS_MAX} に達した`;
      return `- 親 ${id} ${map.nodes[id]!.kind}「${map.nodes[id]!.text}」: 話し中の子 ${n}（${state}）`;
    });
}

// 配下が目安を超えた話し中の案・課題・要点を名指しする（入れ子の山は超えたものすべて）。数と一番近い議題は groupSize から得る
function renderBigPiles(map: MeetingMap, groupNodes: readonly GroupNode[]): string[] {
  return map.order
    .filter((id) => FOLDED_KINDS.has(map.nodes[id]?.kind ?? "") && !underClosed(map, id))
    .map((id) => [id, groupSize(groupNodes, id)] as const)
    .filter(([, g]) => g.size > TOPIC_NODES_MAX)
    .map(([id, g]) => `- ${map.nodes[id]!.kind} ${id}「${map.nodes[id]!.text}」: 話し中の配下 ${g.size} ノード（目安 ${TOPIC_NODES} を超えた。この下には新しいノードを足さず、続きの具体化は一番近い議題 ${g.topicId} の下に、元のノードと焦点が分かる名前の子の議題を立てて置く）`);
}

// 話し中の部分が目安を超えた話し中の論点を名指しする
function renderBigPoints(map: MeetingMap, groupNodes: readonly GroupNode[]): string[] {
  return map.order
    .filter((id) => map.nodes[id]?.kind === "論点" && !map.nodes[id]!.talkStatus)
    .map((id) => [id, groupSize(groupNodes, id).size] as const)
    .filter(([, n]) => n > TOPIC_NODES_MAX)
    .map(([id, n]) => `- 論点 ${id}「${map.nodes[id]!.text}」: 話し中 ${n} ノード（目安 ${TOPIC_NODES} を超えた。派生の問いがあれば、次の答えは派生の論点として立てる）`);
}

// 話し中の議題を木のまま字下げした一覧。済みの議題と、済みの議題の下の議題は出さず、件数だけを見出しに出す。
// 毎回、その時点のマップから作り直す（状態は持たない）
function renderTopicList(map: MeetingMap): string {
  const rows: string[] = [];
  const big: string[] = [];
  const groupNodes = Object.values(map.nodes);
  const walk = (id: string, depth: number) => {
    const topics = childTopics(map, id);
    const nodes = groupSize(groupNodes, id).size;
    const open = topics.filter((t) => !map.nodes[t]!.talkStatus);
    const touched = map.nodes[id]!.touchedAt;
    const info = [
      ...(topics.length ? [`まとまり・子の議題 話し中 ${open.length}・済み ${topics.length - open.length}・まとまり自体の話し中 ${nodes} ノード`] : [`話し中 ${nodes} ノード`]),
      ...(touched === undefined ? [] : [`最後に触れた ${Math.floor(touched / 60)} 分`]),
    ];
    rows.push(`${"  ".repeat(depth)}- ${id} ${map.nodes[id]!.text}（${info.join("・")}）`);
    if (nodes > TOPIC_NODES_MAX) big.push(`- 議題 ${id}「${map.nodes[id]!.text}」: 話し中 ${nodes} ノード（目安 ${TOPIC_NODES} を超えた。直下に新しいものを立てず、新しい論点・案・課題・要点は焦点ごとの子の議題の下に置く）`);
    for (const t of open) walk(t, depth + 1);
  };
  const top = childTopics(map, ROOT_ID).filter((t) => !map.nodes[t]!.talkStatus);
  for (const t of top) walk(t, 0);
  const closedCount = Object.values(map.nodes).filter((n) => n.kind === "議題" && n.talkStatus).length;
  const shown = rows.length;
  return [
    `## 議題の一覧（話し中 ${shown}・済み ${closedCount}。済みと、済みの議題の下は省略）`,
    ...(rows.length ? rows : ["（なし）"]),
    ...big,
    ...renderBigPoints(map, groupNodes),
    ...renderBigPiles(map, groupNodes),
    ...renderCrowdedParents(map),
    `目安: 1 つの議題・論点の話し中の部分、1 つの案・課題・要点の話し中の配下は ${TOPIC_NODES} ノード。1 つの親の下の話し中の兄弟が種別によらず ${SIBLINGS_MAX} つになったら、まとめる親を考える合図（ルート直下も含む。済みは数えない）`,
  ].join("\n");
}

// previous（その query に前回送ったマップ）が無ければ全体のアウトライン、あれば前回からの変更を載せる
// 前回の応答の仮 ID と捨てた操作（previousResponse）は、変更を載せる回にだけ出す
export function buildPrompt({ map, recent, fresh, previousResponse, speakerNames }: DiffInput, previous?: MeetingMap): string {
  return [
    renderTopicList(map), "",
    ...(previous
      ? [`## 前回からのマップの変更（ルートの ID: ${ROOT_ID}）`, renderChanges(previous, map, previousResponse)]
      : [`## 現在のマップ（ルートの ID: ${ROOT_ID}）`, renderOutline(map)]), "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map((r) => remarkLine(r, { name: nameOfSpeaker(r, speakerNames) })).join("\n") : "（なし）", "",
    "## 新しい発言", fresh.map((r) => remarkLine(r, { name: nameOfSpeaker(r, speakerNames) })).join("\n"),
  ].join("\n");
}

// Claude の出力は操作だけで、core の反映数を生成させない。
// 余分なキーは JSON Schema の上では禁止（additionalProperties: false）にし、decode では黙って落とす。文字列の長さなどの検査は足さない
export const OUTPUT_SCHEMA = Schema.toJsonSchemaDocument(DiffOperations, { onExcessProperty: "error" }).schema;
