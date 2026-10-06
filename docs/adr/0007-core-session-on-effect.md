# 中核は Effect 本体に依存し、外から来るデータは Schema で検証し、セッションの並行処理は Effect で書く

server を Effect 4 へ置き換える（[#193](https://github.com/daiki-beppu/live-mindmap/issues/193)）にあたって、中核（`server/src/core/`）も Effect に寄せる。寄せる範囲は、失敗を型で表したいところと、並行処理を持つところに限る。中核が依存してよいのは `effect` 本体（`Effect`・`Schema`・`Clock`・`Ref` など）だけで、実行環境に結びつくモジュール（platform-node、`effect/process`・`effect/socket` など）は使わない。`effect` 本体はブラウザでも動くので、ADR 0003 の「Node の実行環境に依存しない」とはぶつからない（[#196](https://github.com/daiki-beppu/live-mindmap/issues/196)）。

- 外から来るデータ（ヘルパーのイベント、正解ファイル、ログの行、Claude の structured output）は Schema で検証し、壊れていればタグ付きの失敗にする。マップ・差分操作・発言・ログの型は `Schema.Struct` を正本にして型を導き、値は普通のオブジェクトのままにする。Claude に渡す JSON Schema も差分操作の Schema から作る
- 失敗しない純粋な関数（`applyOps` など）は `Effect` で包まない。捨てた操作は失敗ではなく結果の一部
- セッションは Scope を要る Effect で作り、差分更新の呼び出しと静かになるまでの待ちはセッションの Scope に属する Fiber にする。待ちは中断で取り消す（取り消せない sleep を世代番号で無視する作りをやめる）。差分更新を出す役とログを書く役は Service として受け取る

## Considered Options

- **セッションを純粋な状態遷移に分け、並行処理を外側に出す**: 中核に Effect が入らないが、発言の受け取り・待ち・呼び出しの絡みを状態遷移の値に書き直す、置き換えとは別の大きな作業になる
- **型は TS のまま残し、検証用の Schema を別に書く**: 定義が二重になり、ずれる
- **`Schema.Class` で定義する**: マップはログに JSON で書き、web に送り、スプレッドで写すので、クラスのインスタンスにすると毎回の変換が要る

## Consequences

- 差分更新の失敗は、中断以外は defect も含めて受け止めて記録し、次へ進む（1 回の失敗で会議中のマップを止めない）。記録には型で表した失敗か defect かの区別を残す
- 終わりに流す `flush` は、Scope を閉じる前に本体から呼ぶ。Scope を閉じたときの中断は安全網
- ログの保存の形は変えない。読み書きを同じ Schema にそろえ、今の形式のログを復元するテストで互換を守る
- 時刻を引数で受ける純粋な作り（発言化の規則など）はそのまま残す
