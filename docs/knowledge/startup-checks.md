# 開始前の確かめ

セッションや再生を始める入口（`start`・`resume`・`recorded`・`cli play`・`cli eval --model`）と、始めずに確かめる口（http の確かめ・`cli check`）を足す・変えるとき、入口ごとに要るものを変えるとき、`StartupChecks`（`server/src/startupChecks.ts`）とそのテストを触るときに読む文書。入口ごとの「要る・あれば足りる・確かめない」の表は仕様 [#1611](https://github.com/daiki-beppu/live-mindmap/issues/1611) にある。

- 用語: [開始前の確かめ](../../GLOSSARY.md)
- ADR: [0017 重い依存は使うときだけ管理ディレクトリに固定版で入れ、CLI は入れずに開始前の確かめで止める](../adr/0017-heavy-deps-in-managed-dir-cli-stops-at-check.md)（確かめは確かめるだけで、入れない）

## 入口は `StartupChecks` の口を 1 回呼ぶだけにする。手順を呼ぶ側に並べない

`StartupChecks` の口は 2 つある。

- **報告の口**（`report`）: 行の確かめの結果を `CheckReport`（items と ready）で返す。始めない、準備しない。http の確かめ・`cli check` が使う
- **準備の口**（`prepare`）: 要るものが欠ければ `StartupDepsMissing` で止める。そろえば、マップを作る行（`start`・`recorded` のマップあり・`play`）では `prepareUpdater` を呼んで `{ warnings, updaterLayer }` を、updater を組まない行（`resume`・`recorded` の `noMap`）では `{ warnings }` を返す

準備の口の中の順序（確かめを先に走らせ、欠けていれば `prepareUpdater` を呼ばない → 準備の失敗のうち `dependency` を持つものを `StartupDepsMissing` に読み替える → 判定の鍵の `notice` を警告の後ろに 1 回だけ足す）も、helper の確かめ方（`check({ screen: true })`・`check({ screen: false })`・呼ばない）の選び分けも、module の中にある。

前は、この手順を入口ごとに 5 か所以上で並べていて、`cli eval --model` だけが確かめを飛ばしていた（[#1524](https://github.com/daiki-beppu/live-mindmap/issues/1524)）。Chromium が無い環境で、`cli play` は開始前に警告したが、`cli eval --model` は最後の map.png の書き出しで初めて失敗した。入口を足すときは、表のどの行かを決めて口を 1 回呼ぶ。新しい規則が要るなら、呼ぶ側ではなく module の表を直す。`cli eval --model` は `play` の行を使い、`cli eval`（`--model` なし）は何も確かめないので module を通らない。

## 入力は入口の行を決める 4 つの鍵だけ。要らない鍵は型で渡せない

入力は、入口・経路（`ModelRoute`）・共有画面の有無（`screen`）・`noMap` の 4 つ。`screen` は `start`・`resume` だけ、`noMap` は `recorded` だけが持ち、`recorded` の `noMap: true` は `route` も持たない。updater を組まない行の `prepare` は `plan` を受け取らず、戻り値に `updaterLayer` が無い。`startupChecks.test` の最初のテストが、これらの誤った呼び出しを `@ts-expect-error` で固定している。入力の型を緩めると、このテストが落ちる。

`play` の行の型は `Helpers` を要求しない（`report`・`prepare` の最初の overload）。CLI のプロセスは helper の layer を持たないので、`cli play`・`cli eval --model`・`cli check --for play` はこの形に頼っている。`play` で helper を見るようにすると、CLI の型検査が落ちる。helper を見る行（`start`・`resume`・`recorded`）の `cli check` は、常駐の server に http で問う。

## 「確かめない」は、その資源を壊した状態を入れても何も出てこないことで確かめる。呼んだ回数は数えない

偽の helper は `server/test/fixtures/helperCheck.ts` の `helperChecks(state)` 1 つで作る。「helper が失敗する」（`HelperCheckFailure`）か、マイク・画面収録・speech-ja の状態を渡すと、`check({ screen })` が `screen` に応じた形を返す。前は、そろった状態の束と、呼ばれたら落ちる束（`forbiddenHelperChecks`）の 2 つを使い分けていた。

「確かめない」を確かめるときは、その資源が無い・失敗する状態を入れ、items にも警告にも出ず、始められることを見る（`play` は helper が失敗しても通る、共有画面を取らない `start` は画面収録の許可が無くても項目を出さない、経路が claude 以外なら claude が missing でも警告しない、など）。呼ばれたかどうかで確かめると、出てくるものが同じままの作り替えでも落ちる（[CODING_STANDARDS.md](../../CODING_STANDARDS.md) → Tests）。

報告の `ready` と、準備の口が確かめで止まるかは食い違わせない。web の画面は報告の口を、開始は準備の口を使うので、ずれると「確かめでは大丈夫なのに始まらない」になる。`startupChecks.test` は、speech-ja の 5 つの状態ごとに、この 2 つが一致することを見ている。形式仕様の性質 `invReportMatchesPrepare`（#1611 のコメント）と同じ約束だ。

経路が claude 以外のときの claude は、警告には出さず、`cli check`・http の確かめの JSON には `optional` の項目として残す。外の形を変えないための既定で、外すかは決めていない。

## 準備に要るサービスは layer を組むときに、Scope は `prepare` を呼ぶときに受け取る

`StartupChecks.layer({ prepareUpdater })` は、`prepareUpdater` が要るサービス（`HttpClient`・`FileSystem`・`AppleIntelligence`・`ManagedDeps`）を layer を組むときに捕まえ、`prepare` の呼び手の `Scope` を足して渡す。updater の寿命はセッションのもので、`Sessions` の `prepareMap` がセッションの Scope の中で呼ぶ。Scope まで layer で捕まえると、updater が server の寿命まで開いたままになる。`startupChecks.test` の「準備で取得した資源はサービス構築時でなく呼び出し元の Scope で閉じる」が、layer を組んだだけでは 0 回、呼び手の Scope を抜けるたびに 1 回閉じることを見ている。

偽の updater の差し口は `ServerOptions.prepareUpdater` の 1 つで、`realLayers` がそれを `StartupChecks.layer` に渡す。`SessionSinks` は準備に関わらない。server の層の組（`ServerLayers`）に `startupChecks` の欄があるので、`startedServer` に層を渡す IT の fixture はこの欄も渡す。#1627 で差し口を `SessionSinks` からここへ移したときは、42 ファイルのうち多くがこの 1 欄を足すだけの変更だった（[PR #1645](https://github.com/daiki-beppu/live-mindmap/pull/1645)）。

## 確かめの部品を module の外の呼び手へ出さない。bench も `play` の行で `prepare` を呼ぶ

項目・警告の文を作る部品は `startupItems.ts` にあり、export されている。今それを import しているのは `startupChecks.ts` と、日本語モデルの導入の後に状態を読み直す `installDeps.ts`（`speechJaItem` だけ。導入は入口ではないので表を通らず、`Helpers` の `check({ screen: false })` を直接呼ぶ）だけだ。ほかの呼び手から使わない。

#1628 で古い `managedDepsCheck.ts` を消したとき、チケットに出てこない呼び手の bench（`server/bench/sttReplay.ts`）が `startupPreparationFailure` を使っていて、読み込みで落ちた。1 回目の run は import 先を `startupItems.ts` に向け替えたが、2 回目の run は採らず、bench も `StartupChecks.prepare` を `play` の行で呼ぶ形にした。古い確かめの関数を消すときは、`server/bench/` も呼び手として grep する。

bench のように経路が 1 つに決まっている呼び手に `planLayer` を `prepareUpdater` として渡すと、`planLayer` がすべての経路の依存（Apple Intelligence・HTTP）を要求し、型検査が呼び手の依存の増加として検出する。経路が決まっているなら、その経路の updater を先に組んでその結果を返すだけの `prepareUpdater` を渡す（`sttReplay.ts` は `claudeUpdaterLayer(defaultClaude)` を組む）。

## 出典

- 仕様 [#1611](https://github.com/daiki-beppu/live-mindmap/issues/1611)（Formal Spec のコメントを含む）、親 [#1622](https://github.com/daiki-beppu/live-mindmap/issues/1622)
- チケット [#1626](https://github.com/daiki-beppu/live-mindmap/issues/1626)・[PR #1642](https://github.com/daiki-beppu/live-mindmap/pull/1642)、[#1627](https://github.com/daiki-beppu/live-mindmap/issues/1627)・[PR #1645](https://github.com/daiki-beppu/live-mindmap/pull/1645)、[#1628](https://github.com/daiki-beppu/live-mindmap/issues/1628)・[PR #1668](https://github.com/daiki-beppu/live-mindmap/pull/1668)、[#1629](https://github.com/daiki-beppu/live-mindmap/issues/1629)・[PR #1648](https://github.com/daiki-beppu/live-mindmap/pull/1648) の差分
- #1628 の takt の run（`20261026-221216-issue-1628-cli-play-to-cli-eva-vgx5ew`・`20261027-035023-issue-1628-cli-play-to-cli-eva-ne56xj`）の計画・決定ログ・実装の報告
- [開始前の確かめを入口の表 1 つにまとめたとき](../devlog/2026-10-27.md#startup-checks-module)
