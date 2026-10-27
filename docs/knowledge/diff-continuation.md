# 差分更新の問い合わせの続き

差分更新の呼び出しをまたいで持つ状態（直前の応答を当てた結果と、開き直した query に送り直す共有画面）を触るときに読む文書。触る場所は、`server/src/core/session.ts` の `DiffInput` と Runtime、Claude の adapter（`server/src/claude.ts`）、振り分け（`server/src/routedDiffUpdater.ts`）、復元（`restoreState`）。続きの状態の持ち主の決め方、振り分けの画面の上限、復元で戻さないもの、どの層のテストで確かめるかを書く。決定そのものは仕様 [#1303](https://github.com/daiki-beppu/live-mindmap/issues/1303)（Formal Spec のコメントを含む）と、その元の [#1241](https://github.com/daiki-beppu/live-mindmap/issues/1241) の解決コメントにある。

- 用語: [差分更新のモデル・振り分け・共有画面・一時停止](../../GLOSSARY.md)
- ADR: [0006 差分更新は、開いた query の中ではマップの変更だけを送る](../adr/0006-send-map-changes-within-a-query.md)
- 関連する知識文書: [更新の計画](update-plan.md)

## 続きの状態は、それを使う DiffUpdater の中に置く。core には、core が作るものだけを残す

続きの状態は 2 つあり、持ち主が違う。

| 状態 | 作る・持つところ | 中身 |
|---|---|---|
| 直前の応答（`DiffInput.previousResponse`） | 操作を当てる core が作り、入力に載せる | refs（仮 ID → n の ID）と dropped（捨てた操作と理由） |
| 送り直す画面 | Claude の adapter が `retainedScreens` で持つ | 最後にメッセージへ載せた画面（最大 `RETAINED_SCREENS_MAX` = 2 件） |

[#1313](https://github.com/daiki-beppu/live-mindmap/issues/1313)（[PR #1389](https://github.com/daiki-beppu/live-mindmap/pull/1389)）の前は、送り直す画面も core が持っていた。中身は `DiffInput.previousScreens`、Runtime の `lastScreens`、`LAST_SCREENS`、復元の状態の `screens.last` と `attached`、送り直す画像を呼び出しのたびにログ（`SessionLog.readScreen`）から読み戻す処理。query を開き直すのは Claude の adapter の中の仕組みなのに、それを変えるたびに core・復元・振り分けを一緒に直すことになっていた。

新しい続きの状態を足すときは、どの DiffUpdater の都合で要るのかを先に決める。1 つの adapter の都合なら、その adapter の `Ref` に置き、`DiffInput` には足さない。

## `previousResponse` は「この DiffUpdater が直前に返した応答を当てた結果」。decorator は、それを返した内側の updater へ回す

core は自分の下にある DiffUpdater が何本の会話を持つかを知らない。だから `previousResponse` の意味は、会話の本数を前提にしない 1 文になっている（[#1314](https://github.com/daiki-beppu/live-mindmap/issues/1314)、[PR #1394](https://github.com/daiki-beppu/live-mindmap/pull/1394)）。振り分けのように内側に updater を何本も持つ decorator から見ると、自分が直前に返した応答は、直前に回した内側の updater の応答になる。

- `last` は、直前の応答を返した内側の updater
- `own[last] = input.previousResponse` で、その updater の分として受け取り、次にその updater を呼ぶときに渡す
- `last` が未設定の最初の呼び出しでは、入力の `previousResponse` は誰の分でもないので捨てる（`routedDiffUpdater.test` の「どの query を回したか分からない最初の呼び出しの previousResponse は…」）

ADR 0006 のとおり、変更と仮 ID の対応を送るのは開いた query の中だけ。Claude のプロンプトの組み立ては、その query に送ったマップがあるときにしか直前の応答を読まない。decorator を新しく書くときも、この知らせを、直前に応答した内側の updater へ回す。core の帳簿を逆算して持ち主を推し量る書き方はしない。

## 振り分けは、core がこの回に添えた画面を切らない。上限で切るのは、回さなかった側にたまる未送の画面だけ

回した先へ渡す画面は、その会話にたまっていた未送の画面（`unseen[destination]`）に、この回に core が添えた画面（`input.screens`）を切らずに続けたもの。回さなかった側の `unseen` にだけ、振り分け自身の定数 `UNSEEN_SCREENS_MAX`（3、使わない会話のために費用が膨らまないように）をかける。

前は、両方の会話の `unseen` を「core と同じ」と写した `SCREENS_MAX` = 3 で切ってから渡していた。core は、一時停止の間にたまった画面（追いつきの印の画面まで。今は [共有画面のキュー](screen-queue.md) が持つ）を添える回だけは `SCREENS_MAX` で切らない。そのため、既定の構成（組み込みの claude で判定の鍵があるとき）では、一時停止から戻るときに追いつきで 4 件以上たまった画面のうち、古い方が回した先へ届かなかった（[#1296](https://github.com/daiki-beppu/live-mindmap/issues/1296)、[#1312](https://github.com/daiki-beppu/live-mindmap/issues/1312) の [PR #1385](https://github.com/daiki-beppu/live-mindmap/pull/1385) で直した）。写した定数は、core の決まりの例外までは写せない。

ほかのモジュールの上限を写した定数は持たない。上限が要るなら、自分の理由をコメントに書いた自分の定数にする。decorator は、core が入力に載せた件数を減らさない。

## 送り直す画面は積み上げて覚える。画面の無い回では消さず、失敗した回の画面も数え、送り直しだけでは進めない

Claude の adapter は、送るメッセージに新しく添える画面（`input.screens`）があるときだけ、`retainedScreens` に足して新しい方から 2 件に切る。query を開き直した最初のメッセージ（`o.sent` が未設定。失敗・ストリームの終わり・`QUERY_RENEW_CALLS` 回に達したときのどれでも）でだけ、覚えた画面を新しく添える画面の前に付ける。

- **画面の無い回では消さない**: 毎回のメッセージで上書きすると、画面の無い回の後に開き直したとき、直前の画面が送り直されない。#1303 の Formal Spec が、この反例を出した
- **失敗した回の画面も覚える**: 画面を覚えるのは送る前なので、応答が失敗しても次の query へ持ち越す
- **送り直した画面では進めない**: 送り直しは `retainedScreens` を書き換えない。新しく添えた画面だけが履歴を進める
- **start が重なれば送り直さない**: 新しく添える画面と start が同じものは、id やバイト列が違っても送り直さない（`claude.test` の「新規画面とstartが同じ履歴は、idとバイト列が異なっても二重に送らない」）

振り分けでは、内側の Claude の adapter が 1 本ずつ自分の分を持つ。振り分けは「その会話が最後に見た画面」を持たず、`previousScreens` の除き方も持たない。

core は画像のバイト列をメモリに持たず、新しく添える画像だけを呼び出しのたびにログから読み戻す。Claude の adapter は、送り直す画面のバイト列を 1 本あたり最大 2 件メモリに持つ。振り分けでは内側が 2 本あるので、最大 4 件になる。

## 復元では、直前の応答も送り直す画面も戻さない

再生・復元の結果（`replayDiff`・`Replay`・`restoreState` の返り値）には、どちらの欄も無い。`previousResponse` は `SessionState` から Runtime へ移り、セッションを開くときに `undefined` で始まる（#1313・#1314）。

戻さない理由は、復元したセッションの最初の呼び出しが、どちらも使わないことにある。

- **Claude の adapter**: 復元の後は必ず query を開き直して、マップ全体を送る
- **振り分け**: `last` が未設定なので、最初の入力の直前の応答を捨てる
- **本番の経路**: 復元を呼ぶのは `cli restore` だけで、差分更新を呼べない updater を渡している

落ちたセッションを差分更新つきで続ける機能を作るときも、会話は落ちた時点で失われているので、直前の応答は要らない。復元の口を adapter に足さない。

テストでは、「元のセッションをそのまま続けた場合と、復元して続けた場合で、差分更新への入力が一致する」を入力全体の `toEqual` で比べられなくなった。`restore.test` は `map`・`recent`・`fresh` を比べ、直前の応答は `not.toHaveProperty("previousResponse")` で見る（「復元した続きの入力には前回の応答が載らない」、`claudePause.test`・`sessionPause.test` も同じ形）。

## 送り直しは `claude.test`、振り分けの画面は `routedDiffUpdater.test`、復元は `restore.test` で、どれも in-process の偽物で見る

| 確かめること | 置き場所 | 見るもの |
|---|---|---|
| 開き直した最初のメッセージの送り直し、失敗した回の画面、start の重なり、`QUERY_RENEW_CALLS` での開き直し | `claude.test`（「adapter が覚えて開き直しで送り直す共有画面」） | 偽の `AgentSdk` に届いたメッセージのブロック |
| core が添えた画面を全件渡すこと、回さなかった側を 3 件で切ること、先が替わったときに未送の画面がそろうこと | `routedDiffUpdater.test`（「振り分け: 共有画面」） | 内側の偽の DiffUpdater が受けた入力の `screens` |
| 復元した続きの入力に直前の応答が載らないこと | `restore.test` | 続きの呼び出しの入力 |

振り分けのテストは、`sonnet` と `haiku` の両方を `for` で回し、どちらへ回しても同じに働くことを見ている。振る舞いの持ち主とテストの置き場所はそろえる。送り直しのテストは、#1313 で `sessionScreen.test` から `claude.test` へ移し、元からは消した（[CODING_STANDARDS.md](../../CODING_STANDARDS.md) の Tests の replace, don't layer）。

## 振り分けの画面を変えたときの前後の比較は、`cli eval` では足りない

#1312 と #1313 には「マージ後に人が確かめること」として、`cli eval` を同じサンプルで前後に回すことが書いてある。けれども `cli eval` は `--model` で名指しするので、計画はいつも `single` になり、振り分けを通らない（[更新の計画](update-plan.md)）。#1312 の直しは、`cli eval` の前後では差が出ようがない。

Claude の adapter の送り直し（#1313）は、`single` でも通るので `cli eval` で比べられる。振り分けの側の変更を実際のモデルで比べるときは、振り分けを通る `play --judge`（または `start`・`recorded`）で回す。

## 出典

- 仕様 [#1303](https://github.com/daiki-beppu/live-mindmap/issues/1303)（Formal Spec のコメントを含む）、親 [#1311](https://github.com/daiki-beppu/live-mindmap/issues/1311)
- チケット [#1312](https://github.com/daiki-beppu/live-mindmap/issues/1312)・[PR #1385](https://github.com/daiki-beppu/live-mindmap/pull/1385)、[#1313](https://github.com/daiki-beppu/live-mindmap/issues/1313)・[PR #1389](https://github.com/daiki-beppu/live-mindmap/pull/1389)、[#1314](https://github.com/daiki-beppu/live-mindmap/issues/1314)・[PR #1394](https://github.com/daiki-beppu/live-mindmap/pull/1394) の差分と本文
- [#1296](https://github.com/daiki-beppu/live-mindmap/issues/1296)（振り分けが追いつきの画面を 3 件で切る不具合）とその triage のコメント
