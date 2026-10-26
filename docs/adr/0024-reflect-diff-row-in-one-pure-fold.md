# 差分更新の反映は、ログの `diff` の行を入力にした 1 つの純粋な関数にし、ライブ・復元・計測が同じ関数を通る

[反映](../../GLOSSARY.md)（ログの `diff` の行 1 件を、マップ・反映の履歴・発言の台帳に畳むこと）を、同期の純粋な関数 `reflectDiff`（`server/src/core/reflection.ts`）1 つにする（仕様 [#1593](https://github.com/daiki-beppu/live-mindmap/issues/1593)、実装 [#1595](https://github.com/daiki-beppu/live-mindmap/issues/1595)・[#1596](https://github.com/daiki-beppu/live-mindmap/issues/1596)・[#1597](https://github.com/daiki-beppu/live-mindmap/issues/1597)）。これまでは、ライブ（`callUpdater`）・復元（`restoreState`）・計測（`logMetrics`）が同じ手順を別々に持っていて、もう食い違っていた。処理数が `fresh` より多い行を、復元は不正なログとして止め、計測は黙って切り詰めて数字を出していた。

- **入力は `log.jsonl` に書く `diff` の行の型（`DiffEvent`）そのもの**。ライブは AI の出力に `attributePeople` を掛けてから行を組み、その行を畳み、同じ行に畳んだ結果の `dropped` を添えてログに書く。復元と計測は、読んだ行を同じ関数で畳む。書く値と読む値が同じなので、「復元 = 元」が照合ではなく作りで成り立つ
- **`Result` を返し、Effect は返さない**。ライブは `Ref.modify`・`Ref.update` のコールバックの中で呼ぶので、同期の値が要る。失敗の理由は文字列で、行の位置は付けない。復元と計測は位置つきの `InvalidLogEvent` に包む。ライブが自分で組んだ行が落ちるのはライブの約束違反なので、defect にする（型付きのエラーは足さない）
- **反映の外に置くもの**: 話者の割り当て（`attributePeople`。ログに書く前に 1 回だけ掛け、復元では掛け直さない）、話者名の受け入れ、一時停止からの戻り、共有画面の持ち越し
- **復元は `diff-update-state`（`restarting`・`stopped`）を読まない**。止まっていたセッションも、差分更新が動く状態で戻す。`diff-update-state` はその回の updater（子プロセス）の状態で、セッションの中身ではない。`stopped` で戻すと、状態を `stopped` から出さない作りのため、再開したセッションが二度と差分更新しない。一時停止（`diff-update-paused`／`diff-update-resumed`）は今どおり戻す

## Considered Options

- **3 か所の写しを残し、往復の照合テストでそろっていることを確かめる（今までの作り）**: `session.ts` と `restore.test.ts` は 16 回一緒に変わり、それでも計測の切り詰めは往復の外にあって見つからなかった
- **復元用に簡単な入力の型を作る**: ライブが書く値と復元が読む値が別の型になり、その間の写しがまた生まれる
- **ライブと復元の Effect の処理をまるごと共通にする**: 共有画面・通知・再試行の責務がライブと復元で違う。差分更新の呼び出しの順序（TLA+ のモデルの範囲）にも触ることになる

## Consequences

- 反映の規則を変えるときは `reflection.ts` の 1 か所を直す。ライブ・復元・計測がそろって変わる
- 往復の照合テストでは、反映そのものの誤りを見つけられない（ライブと復元が同じように間違える）。反映の中身は `reflection.test.ts` の期待値で、外（行の組み立て・書き込み・読み戻し）は `restore.test.ts` の往復 1 本で確かめる
- 計測は、処理数の超過や台帳に無い id を含む壊れたログで `InvalidLogEvent` を返す。正しいログに対する数字は変わらない
- ログの形は変えない。過去のログはそのまま読める
