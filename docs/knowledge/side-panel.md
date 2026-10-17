# 右の列

右の列（`web/src/app/sidePanel/main.ts`、Issue [#821](https://github.com/daiki-beppu/live-mindmap/issues/821) の部品）に段を足す・中身を変える・テストを書くときに読む文書。右の列は上から「根拠」「TODO」「変わったこと」の 3 段で、会議中と見返し（書き出した `map.html` を含む）が同じ部品を使う。何をどこから導くか、高さと狭い幅の扱い、押したときの動き、テストで何をどの層で確かめるかの基準を書く。決定そのものは仕様 [#1284](https://github.com/daiki-beppu/live-mindmap/issues/1284) にある。

- 用語: [TODO・根拠・畳む・追加・統合・話者の名前](../../GLOSSARY.md)
- ADR: 無し（段の並びや割合は覆しやすいので、仕様に置いている）

## 段を足すのは sidePanel の 1 か所でよい。会議中・見返し・map.html に同時に出る

会議中（`web/src/app/meeting/main.ts`）も見返し（`web/src/app/review/main.ts`）も同じ sidePanel を描き、書き出した `map.html` は見返しの画面そのものなので、段は 1 か所に足せば 3 つの画面すべてに出る。右の列の Disclosure も 1 つなので、隠すときは全段がまとめて隠れる。TODO の段（[#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287)、[PR #1292](https://github.com/daiki-beppu/live-mindmap/pull/1292)）は、画面ごとの配線を 1 行も足していない。

裏返すと、段に出した文字は、マップだけの書き出しにも載る。TODO の段はノードの本文・担当者・期限・時刻だけを出すので、発言の文字は増えない。発言を出す段を足すときは、[エクスポートの公開](export-publish.md)の「外に出す物は HTML に埋め込んだデータで数える」に照らす。

## 段の高さは件数で変えない。新しい段も既存と同じ `flex-1 min-h-0 overflow-y-auto` にする

3 段は 1:1:1 の固定で、それぞれの段の中でスクロールする。TODO が増えるたびに他の段が縮むと、共有画面に映る右の列の中が動いてしまう。1 つの段だけ `flex-none` や `max-h` にすると、件数で高さが変わる。右の列の幅（300px）も変えない。字幕の位置・幅の式とマップの幅は右の列の中身に依存しないので、段を足しても字幕とマップは動かない。

## 一覧は Model に持たず、`snapshot.nodes` から view で毎回導く。描かれた木から取らない

`snapshot.nodes` は畳み方に関係なく全ノードを持ち、統合で消えたノードを含まず、作られた順に並んでいる。種別で絞るだけで、畳まれた議題の下の TODO も入り、統合で消えた TODO は自然に消え、見返しでは再生位置の時点の一覧になる。マップに描かれているノード（畳み方を通した木）から取ると、畳まれた議題の下が漏れる。Model に一覧を持つと、スナップショットの更新に追従させる分岐が要る（[web/AGENTS.md](../../web/AGENTS.md) の「導いた値」）。

## ノードの時刻は、`snapshot.changes` の、そのノードの最初の「追加」から取る

変わったことの記録には、同じノードについて追加・更新・統合が並ぶ。最後の記録を取ると、統合で残った TODO には統合の時刻が出る。統合で残った側は反映前からあるノードなので、自分の「追加」を持っている。`node === id && change === "追加"` の最初を探し、見つからなければ時刻を出さない。表示は変わったことの列と同じ `formatClock`（`web/src/changes.ts`）で、60 分を超えても分は 60 以上のまま（3725 秒は `62:05`）。

## 担当者の表示は `people.ts` の `todoAssignee` を通す。マップの担当者の行を分解しない

マップのノードの「→ 担当者 · 期限」の行（`personLine`）と TODO の段は、同じ `todoAssignee` で担当者を決める。担当者の名前があればそれ、無ければ担当の話者を `speakerName` に通した表示名、話者なしの `相手` は出さない。`personLine` の文字列を「 · 」で割って取ると、期限の文字に区切りが入ったときに壊れる。`speakerName` を通すので、話者の名前（[#1026](https://github.com/daiki-beppu/live-mindmap/issues/1026)）が付くと一覧も追従し、段の側で話者のラベルを名前に変える処理は要らない。

## 押してマップのノードを選ぶ段は、変わったことの項目の Message をそのまま使う

`ClickedChangeItem` の update が、畳まれた祖先を開いてノードを指し、選び、スナップショットに無ければ選ぶだけにする処理をすでに持っている。親（会議中・見返し）へ知らせる出力も無い。同じ Message を使えば、押した後の見る状態とビューポートは変わったことの項目の Story テストが見ているので、Story を足さなくてよい。新しい Message を足すと、この両方を作り直すことになる。

## 狭い幅の会議中に隠す段は、`.meeting .changes` と同じセレクタに並べる

768px 以下の会議中は、右の列の段を出さず、ノードを選んだときだけ根拠のシートを出す。`.meeting .side--selected` は子を隠さないので、シートに混ぜたくない段は `web/src/styles.css` の `.meeting .changes, .meeting .todos, …{ display: none; }` に並べる。別の `@media` を立てると、変わったことと振る舞いがずれる。

## 段の Scene は、専用のスナップショットで、見出しの文字と中身で確かめる。class 名の並びを固定しない

継ぎ目は `web/test/sidePanel.scene.test.ts` の 1 つで、マップの表示面と右の列を同じ Model から描き、項目を押す。

- **専用のスナップショット**: 共有の `NODES` に TODO を足すと、根拠の Scene の前提が変わる。#1287 は `TODO_NODES`・`TODO_CHANGES` を別に置き、畳まれた議題の下の TODO・TODO 以外の種別・担当者も期限も無い TODO・話者なしの相手・60 分を超える時刻・`<b>` を含む本文（HTML として解釈しないこと）を 1 つに入れた
- **段の並び**: 新しく書く assertion は、見出しの文字（`["根拠", "TODO", "変わったこと"]`）で比べる。`elements(...).map(named)` で `section.todos` などの並びを完全一致で固定した 1 行は、takt のレビューで [CODING_STANDARDS.md](../../CODING_STANDARDS.md) の「Contracts, not structure」に反するとして REJECT になり、消した。前からある `map(named)` の assertion は、段を足した分の要素を足すだけにし、一括で書き直さない
- **意味のクラス**: 段に付けた BEM の class（`todos`・`todos__item` など）は `web/test/semanticClasses.ts` に登録する。Scene がユーティリティを数えずに意味のクラスだけを比べるための一覧
- **話者の名前の追従**: sidePanel の Scene には `speakerNames` を変える入口が無い。名前が付いて一覧が変わることは、`web/test/meeting.scene.test.ts` の「名前が付くと…」の Scene で `.todos__assignee` を読んで確かめた。sidePanel の Scene にテスト専用の入口を足さない

## 高さ・幅・スクロールは Scene でも takt のレビューでも見ていない。見るのは mount の heavy テスト

1:1:1 の割合・段の中のスクロール・幅 300px・狭い幅で隠れることは、Scene では見ない（CSS の規則なので）。#1287 の takt のレビューは、3 人とも「実ブラウザでの寸法・スクロールは未確認」と書いたうえで APPROVE した。CSS の指定を読んで規則があることを確かめただけで、描いた寸法は誰も測っていない。右の列の寸法を確かめる層は `web/test/meeting.mount.heavy.test.ts`・`review.mount.heavy.test.ts`（1280×801 で右の列が幅 300px で見える、狭い幅で `.changes` が見えない、など）で、#1287 は TODO の段の寸法をここに足していない。割合や隠れ方を契約にしたいときは、この層に足す。

## 出典

- 仕様 [#1284](https://github.com/daiki-beppu/live-mindmap/issues/1284)、親 [#1286](https://github.com/daiki-beppu/live-mindmap/issues/1286)、チケット [#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287)、[PR #1292](https://github.com/daiki-beppu/live-mindmap/pull/1292)
- #1287 の takt の run（`20261017-060712-implement-using-only-the-files-sugyi4`）の計画・決定ログ・3 人のレビュー・修正計画・最終検証
