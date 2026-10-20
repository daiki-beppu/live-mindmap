# takt の run

takt でチケットを実装させるとき、その run の報告を読むとき、run が層を「未実証」で返したときに読む文書。takt の作業場所で検査の層を通すための前提と、run の報告に出る失敗の読み方を書く。takt の並べ方と PR の更新は [ADR 0022](../adr/0022-align-behind-prs-from-local-resident-script.md) にある。

- 用語: 無し
- ADR: [0022 予約済みで BEHIND の PR は、手元の常駐スクリプトが 1 件ずつ揃える](../adr/0022-align-behind-prs-from-local-resident-script.md)

## takt の作業場所には依存が入っていない。ルートの層の前に `pnpm install --frozen-lockfile` が要る

takt が作る worktree（`takt-worktrees/` の下）は Orca の worktree ではないので、`orca.yaml` の setup（`vp install`）が走らない。[#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287) の run の 1 回目の実装は、server と e2e の `node_modules` が無いまま層を回し、ルートの `pnpm test` は server の `vitest` が無くて落ち、`pnpm typecheck` は exit 127 で落ち、`pnpm test:it` と smoke は回せなかった。実装の担当は「依存を入れるのは要求の範囲外」と判断して層を未実証のまま返し、2 回目の計画が `pnpm install --frozen-lockfile`（`e2e/README.md` の回し方の最初の手順）を採ってから、すべての層が通った。lockfile は変わらない。

チケットの完了条件にルートの層を書くときは、依存を入れることも作業に含まれると読ませる。

計画の段も同じ影響を受ける。AGENTS.md が読ませる `server/node_modules/effect/AGENTS.md` は依存を入れるまで無いので、[#1316](https://github.com/daiki-beppu/live-mindmap/issues/1316)・[#1317](https://github.com/daiki-beppu/live-mindmap/issues/1317) の計画は「未確認」と書いて先へ進み、テストを書く段で依存を入れてから読んだ。別の checkout の資料で代わりにしない。

## 仕様はリンク先に置かず、issue の本文かコメントに写す。takt のエージェントはリンク先の issue を読めない

heavy IT を速くする親 [#1151](https://github.com/daiki-beppu/live-mindmap/issues/1151) の子は、本文に「テストごとの振り分けの一次資料: #1147 の解決コメント」とだけ書いていた。#1155・#1160・#1161 の run は振り分けの表を読めないまま実装し、移す先を取り違えたり、残すはずのテストを落としたりして、レビューで止まった（手で引き取り、[PR #1337](https://github.com/daiki-beppu/live-mindmap/pull/1337)・[#1338](https://github.com/daiki-beppu/live-mindmap/pull/1338)・[#1339](https://github.com/daiki-beppu/live-mindmap/pull/1339) で直した）。残りの子に「## 一次資料の写し（takt 用）」のコメントで表を写してから流すと、#1153〜#1158・#1165〜#1168 は止まらずにマージまで進んだ。

積む前に takt スキルの `lint-issue.mjs` を流すと、「一次資料」「解決コメント」のようなリンク頼みの書き方を警告する。写しの節の見出しに「写し」を入れると、写した issue 番号は警告から外れる。

## ルートの `pnpm typecheck` の SIGKILL は環境の側。同じコマンドを 1 回流し直してから原因を探す

#1287 の run では、ルートの `pnpm typecheck` で server と helper が SIGKILL で終わり、それぞれを単体で流すと通った。テストの型エラー（TS4104）を直して同じ 1 コマンドを流し直すと、終了コード 0 で SIGKILL は出なかった。原因は確かめていない。並列 3 の takt で Swift のビルドが同時に走り、同じ SIGKILL で実装をやり直した前例がある（[2026-10-08 の開発ログ](../devlog/2026-10-08.md)）。完了条件はルートの 1 コマンドの終了コードなので、単体で通ったことを代わりにせず、流し直した結果で判断する。

## テストは行番号でなくテスト名で指す。行番号も、置き場のファイルも、先に入った子の PR で変わる

#1147 の振り分けの表は 2026-10-15 時点の行番号でテストを指していた。同じ親の子が先に何本もマージされると、同じファイルの行番号はずれる。後から流した子の run は、行番号の指す先が別のテストになっていても気づけない。issue に写すときは、ファイル名とテスト名（`describe` と `it` の文字列）で指す。

ファイルも動く。仕様 [#1304](https://github.com/daiki-beppu/live-mindmap/issues/1304) の子 [#1324](https://github.com/daiki-beppu/live-mindmap/issues/1324) は `cliRecorded.it` のテストを消すと書いていた。けれども、先に入った [#1323](https://github.com/daiki-beppu/live-mindmap/issues/1323) が、そのテストを新しい `sessionsRecorded.it` へ移していた。#1324 の run はテスト名で探し直して、移った先から消した（[PR #1362](https://github.com/daiki-beppu/live-mindmap/pull/1362) の報告）。子の issue には、テスト名で探させる一文を入れておく。

## `.each` の片方だけを動かす指示は、残す側の引数の値で書く。「〜の側と 1 件」は逆にも読める

[#1320](https://github.com/daiki-beppu/live-mindmap/issues/1320) は、`.each` のうち 1 行だけを外すテストを 4 つ含んでいた。そのうちの 1 つは「1358 の user の側と 1 件」と書かれていて、user の側を消すのか、user の側にまとめて残すのか、どちらにも読めた。takt の run は実装まで済んだが、査読がどちらを外すかを決められずに BLOCKED で止まった。結局、手で引き取って出どころ user の側を外した（[PR #1340](https://github.com/daiki-beppu/live-mindmap/pull/1340)）。

`.each` の一部を消す・下ろす行は、「`source: "user"` の行を外し、`source: "screen"` の行を残す」のように、外す値と残す値の両方を書く。

## 起票の後に main が動いたチケットは、積む前に「今の場所（takt 用）」のコメントを足す。計画が食い違いを見つけると ABORT する

[#1316](https://github.com/daiki-beppu/live-mindmap/issues/1316) の 1 本目の run は、計画の段だけで 5 分で ABORT した（`[PLAN:3] 要件が不明確`）。チケットの表は録画の `observe(connected)` を「何もしない」としていたが、今の main は話者の枠を振り直していた。下ろすはずの 5 件のテストも、先にマージされた [#1323](https://github.com/daiki-beppu/live-mindmap/issues/1323) が動かしていた。自動の requeue で始まった 2 本目も、同じ点を選択肢つきで問い返した。利用者が「本文のテスト → 今の main の場所」の表と、扱い（消えたものも移ったものも新しい unit に書く、重なる分だけ消す、今のコードの振る舞いを保つ）をコメントに書いてからは、どの段も迷わず、12 イテレーション・69 分で通った。#1317 も同じ形のコメントを積む前に足し、1 周・33 分で通った。

同じ親の子が並んでいて、前の子がテストやコードを動かすとき、後の子を積む前に main と本文を照らす。ずれていれば「## 下ろすテストの今の場所（takt 用、日付）」のように、表と扱いをコメントに写す。

## companion の findings 0 も、レビューの APPROVE も、テストを流し直した証拠ではない

#1316 の実装の後の companion レビュー（ai-antipattern と testing）は、1674 行の変更に findings 0 を返した。その後の本番のレビュー（architecture・backend・ai-antipattern）が、録画の正常完了の取り違えとライブの途切れの時刻の上書きの 2 つの退行を見つけた（[取り込みの試行](intake-attempts.md)）。testing のレビューは初めは APPROVE で、裁定役がテストの不足を同じ指摘にまとめた。#1317 では、レビューはテストを流し直さず、実装の段の証跡（`command-results.json`）と最終の差分の SHA-256 が合うことだけを見て APPROVE した。

run の報告を読むときは、どの段が実際にコマンドを流したかを証跡のログで見る。レビューの件数が 0 でも、まとめた経路の後処理の取り違えのような、テストが元々見ていない退行は残りうる。

## 隔離コピーで `pnpm` を流すと、リンク先の依存が入れ直される。`verifyDepsBeforeRun` を切る

#1317 の破壊検証は、`server/` の下を隔離コピーし、`node_modules` をシンボリックリンクにして、コピーの `sessions.ts` だけを壊した。そのコピーで `pnpm test` を流すと、pnpm の実行前の依存の確認が依存を入れ直し、リンク先の worktree の Vitest が 5.0.3 から 5.0.5 に変わった。直後の IT は 3 ファイルとも `SyntaxError: The requested module 'effect/Path' does not provide an export named 'make'` で読み込めず、0 件で終わった。`pnpm install --frozen-lockfile --force` で lockfile どおりに戻し、隔離の側の実行に `--config.verifyDepsBeforeRun=false` を付けてから、壊す検証と層をやり直した。

テストが 0 件で終わった実行は、通ったことにも落ちたことにも数えない。

## 準備のスクリプトは順に流す。並べると Swift のビルドが落ちる

#1316 の run は `build-webrtc-apm.sh` と `fetch-speaker-models.sh` を並べて流し、後者が Swift の `error: Build failed` で落ちた。APM のビルドが済んだ後に流し直すと通った。原因は確かめていない。AGENTS.md の Checks の順（APM → 話者のモデル → `pnpm typecheck`）で 1 つずつ流す。

## 出典

- チケット [#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287)、[PR #1292](https://github.com/daiki-beppu/live-mindmap/pull/1292)
- #1287 の takt の run（`20261017-060712-implement-using-only-the-files-sugyi4`）の計画・2 回の実装の報告と決定ログ
- 仕様 [#1305](https://github.com/daiki-beppu/live-mindmap/issues/1305) の子 [#1316](https://github.com/daiki-beppu/live-mindmap/issues/1316)・[PR #1367](https://github.com/daiki-beppu/live-mindmap/pull/1367) とその takt の run（`20261019-223538-implement-using-only-the-files-k85l61`・`20261019-224050-implement-using-only-the-files-zgghr9`）、[#1317](https://github.com/daiki-beppu/live-mindmap/issues/1317)・[PR #1368](https://github.com/daiki-beppu/live-mindmap/pull/1368) とその takt の run（`20261020-004956-implement-using-only-the-files-4gxc99`）
- 仕様 [#1304](https://github.com/daiki-beppu/live-mindmap/issues/1304) の子 [#1320](https://github.com/daiki-beppu/live-mindmap/issues/1320)・[PR #1340](https://github.com/daiki-beppu/live-mindmap/pull/1340)、[#1324](https://github.com/daiki-beppu/live-mindmap/issues/1324)・[PR #1362](https://github.com/daiki-beppu/live-mindmap/pull/1362)
