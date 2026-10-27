# takt の run

takt でチケットを実装させるとき、その run の報告を読むとき、run が層を「未実証」で返したときに読む文書。takt の作業場所で検査の層を通すための前提と、run の報告に出る失敗の読み方を書く。takt の並べ方と PR の更新は [ADR 0022](../adr/0022-align-behind-prs-from-local-resident-script.md) にある。

- 用語: 無し
- ADR: [0022 予約済みで BEHIND の PR は、手元の常駐スクリプトが 1 件ずつ揃える](../adr/0022-align-behind-prs-from-local-resident-script.md)

## takt の作業場所には依存が入っていない。ルートの層の前に `pnpm install --frozen-lockfile` が要る

takt が作る worktree（`takt-worktrees/` の下）は Orca の worktree ではないので、`orca.yaml` の setup（`vp install`）が走らない。[#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287) の run の 1 回目の実装は、server と e2e の `node_modules` が無いまま層を回し、ルートの `pnpm test` は server の `vitest` が無くて落ち、`pnpm typecheck` は exit 127 で落ち、`pnpm test:it` と smoke は回せなかった。実装の担当は「依存を入れるのは要求の範囲外」と判断して層を未実証のまま返し、2 回目の計画が `pnpm install --frozen-lockfile`（`e2e/README.md` の回し方の最初の手順）を採ってから、すべての層が通った。lockfile は変わらない。

2026-10-24 の [#1442](https://github.com/daiki-beppu/live-mindmap/issues/1442) の run でも同じで、最初のルートの `pnpm typecheck` は web と e2e の `tsc: command not found` で落ち、実装の担当が `pnpm install --frozen-lockfile` を入れてから同じコマンドが通った。この run は依存を入れる判断を自分でしたので、止まらずに 1 周で通った。

チケットの完了条件にルートの層を書くときは、依存を入れることも作業に含まれると読ませる。

依存が無いまま fallow まで届くと、偽の dead-code が出る。#1452 の run の `fallow.log` は `Failed: dead-code (6 issues)` で落ちた。中身は、使っている依存（`@ai-sdk/openai`・`ai`・`@effect/platform-browser`・`tailwindcss`）を「使われていない」とし、`web/src/styles.css` の `tailwindcss/theme.css` などを「解決できない import」とするものだった。依存を入れた後には消えた。依存の名前が並ぶ fallow の失敗は、コードを直す前に `node_modules` があるかを見る。

計画の段も同じ影響を受ける。AGENTS.md が読ませる `server/node_modules/effect/AGENTS.md` は依存を入れるまで無いので、[#1316](https://github.com/daiki-beppu/live-mindmap/issues/1316)・[#1317](https://github.com/daiki-beppu/live-mindmap/issues/1317) の計画は「未確認」と書いて先へ進み、テストを書く段で依存を入れてから読んだ。別の checkout の資料で代わりにしない。

## 仕様はリンク先に置かず、issue の本文かコメントに写す。takt のエージェントはリンク先の issue を読めない

heavy IT を速くする親 [#1151](https://github.com/daiki-beppu/live-mindmap/issues/1151) の子は、本文に「テストごとの振り分けの一次資料: #1147 の解決コメント」とだけ書いていた。#1155・#1160・#1161 の run は振り分けの表を読めないまま実装し、移す先を取り違えたり、残すはずのテストを落としたりして、レビューで止まった（手で引き取り、[PR #1337](https://github.com/daiki-beppu/live-mindmap/pull/1337)・[#1338](https://github.com/daiki-beppu/live-mindmap/pull/1338)・[#1339](https://github.com/daiki-beppu/live-mindmap/pull/1339) で直した）。残りの子に「## 一次資料の写し（takt 用）」のコメントで表を写してから流すと、#1153〜#1158・#1165〜#1168 は止まらずにマージまで進んだ。

積む前に takt スキルの `lint-issue.mjs` を流すと、「一次資料」「解決コメント」のようなリンク頼みの書き方を警告する。写しの節の見出しに「写し」を入れると、写した issue 番号は警告から外れる。

## ルートの層の SIGKILL は、先に出た最初の失敗を見る。それが無ければ、同じコマンドを 1 回流し直す

ルートの `pnpm typecheck` は workspace を並べて流し、1 つが落ちると pnpm が走っている残りを止める。#1452 の run の `root-typecheck.log` では、web と e2e が `tsc: command not found`（exit 127）で落ち、その後に server と helper が `Command failed with signal SIGKILL`、最後に `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` が出ていた。この SIGKILL は、依存が無いことの巻き添えで止められた跡で、`pnpm install --frozen-lockfile` の後に流し直すと 0 で通った。#1461 のマージの run でも、CI の直しの報告は「server 側は pnpm に停止された」と書いている。

#1287 の run でも、ルートの `pnpm typecheck` で server と helper が SIGKILL で終わり、それぞれを単体で流すと通った。テストの型エラー（TS4104）を直して同じ 1 コマンドを流し直すと、終了コード 0 で SIGKILL は出なかった。原因は確かめていないが、型エラーの巻き添えだった形と合う。

先に落ちた workspace が無く、SIGKILL だけが出ているときは環境の側を疑い、同じコマンドを 1 回流し直す。並列 3 の takt で Swift のビルドが同時に走り、SIGKILL で実装をやり直した前例がある（[2026-10-08 の開発ログ](../devlog/2026-10-08.md)）。どちらの場合も、完了条件はルートの 1 コマンドの終了コードなので、単体で通ったことを代わりにせず、流し直した結果で判断する。

## テストは行番号でなくテスト名で指す。行番号も、置き場のファイルも、先に入った子の PR で変わる

#1147 の振り分けの表は 2026-10-15 時点の行番号でテストを指していた。同じ親の子が先に何本もマージされると、同じファイルの行番号はずれる。後から流した子の run は、行番号の指す先が別のテストになっていても気づけない。issue に写すときは、ファイル名とテスト名（`describe` と `it` の文字列）で指す。

ファイルも動く。仕様 [#1304](https://github.com/daiki-beppu/live-mindmap/issues/1304) の子 [#1324](https://github.com/daiki-beppu/live-mindmap/issues/1324) は `cliRecorded.it` のテストを消すと書いていた。けれども、先に入った [#1323](https://github.com/daiki-beppu/live-mindmap/issues/1323) が、そのテストを新しい `sessionsRecorded.it` へ移していた。#1324 の run はテスト名で探し直して、移った先から消した（[PR #1362](https://github.com/daiki-beppu/live-mindmap/pull/1362) の報告）。子の issue には、テスト名で探させる一文を入れておく。

件数も動く。仕様 [#1638](https://github.com/daiki-beppu/live-mindmap/issues/1638) は `sessionScreen.test.ts` の 44 件のうち「14 件を移し、30 件を残す」と書いていた。先に入った [#1652](https://github.com/daiki-beppu/live-mindmap/issues/1652) がその一部を移し、[#1653](https://github.com/daiki-beppu/live-mindmap/issues/1653) の計画の時点では 36 件になっていた。消すはずのファイル（`screenSelection.ts`）も、もう無かった。#1653 の計画は件数を当てはめず、規則ごとに「キューのテストにあるか」を照合して 6 件を消し、仕様どおりの 30 件になった。仕様にテストの行き先を書くときは、件数より、規則の名前とテスト名で書く。

## `.each` の片方だけを動かす指示は、残す側の引数の値で書く。「〜の側と 1 件」は逆にも読める

[#1320](https://github.com/daiki-beppu/live-mindmap/issues/1320) は、`.each` のうち 1 行だけを外すテストを 4 つ含んでいた。そのうちの 1 つは「1358 の user の側と 1 件」と書かれていて、user の側を消すのか、user の側にまとめて残すのか、どちらにも読めた。takt の run は実装まで済んだが、査読がどちらを外すかを決められずに BLOCKED で止まった。結局、手で引き取って出どころ user の側を外した（[PR #1340](https://github.com/daiki-beppu/live-mindmap/pull/1340)）。

`.each` の一部を消す・下ろす行は、「`source: "user"` の行を外し、`source: "screen"` の行を残す」のように、外す値と残す値の両方を書く。

## 起票の後に main が動いたチケットは、積む前に「今の場所（takt 用）」のコメントを足す。計画が食い違いを見つけると ABORT する

[#1316](https://github.com/daiki-beppu/live-mindmap/issues/1316) の 1 本目の run は、計画の段だけで 5 分で ABORT した（`[PLAN:3] 要件が不明確`）。チケットの表は録画の `observe(connected)` を「何もしない」としていたが、今の main は話者の枠を振り直していた。下ろすはずの 5 件のテストも、先にマージされた [#1323](https://github.com/daiki-beppu/live-mindmap/issues/1323) が動かしていた。自動の requeue で始まった 2 本目も、同じ点を選択肢つきで問い返した。利用者が「本文のテスト → 今の main の場所」の表と、扱い（消えたものも移ったものも新しい unit に書く、重なる分だけ消す、今のコードの振る舞いを保つ）をコメントに書いてからは、どの段も迷わず、12 イテレーション・69 分で通った。#1317 も同じ形のコメントを積む前に足し、1 周・33 分で通った。

前の子が後の子の作業を済ませてしまうこともある。仕様 [#1437](https://github.com/daiki-beppu/live-mindmap/issues/1437) の 2 本目 [#1448](https://github.com/daiki-beppu/live-mindmap/issues/1448) は「`cli play` のときだけ送り口を渡す」を作るものにしていたが、送り口は前提の仕様 #1436 で渡されていて、1 本目の #1447 で名前の frame も送るようになっていた。計画の段がそれをコードで確かめ、本番コードの差分は 0 行、テスト 2 ファイルと README だけで通った（[PR #1520](https://github.com/daiki-beppu/live-mindmap/pull/1520)）。ABORT しなかったのは、受け入れ条件が「`cli play` の最中に `speaker-names` の frame が送り口に届く」という見える結果で書かれていて、配線の有無に依らず満たし方を決められたからだ。子の本文の「作るもの」には配線より見える結果を書いておく。

同じ親の子が並んでいて、前の子がテストやコードを動かすとき、後の子を積む前に main と本文を照らす。ずれていれば「## 下ろすテストの今の場所（takt 用、日付）」のように、表と扱いをコメントに写す。

## companion の findings 0 も、レビューの APPROVE も、テストを流し直した証拠ではない

#1316 の実装の後の companion レビュー（ai-antipattern と testing）は、1674 行の変更に findings 0 を返した。その後の本番のレビュー（architecture・backend・ai-antipattern）が、録画の正常完了の取り違えとライブの途切れの時刻の上書きの 2 つの退行を見つけた（[取り込みの試行](intake-attempts.md)）。testing のレビューは初めは APPROVE で、裁定役がテストの不足を同じ指摘にまとめた。#1446 でも同じ形になった。5 人のレビューのうち ai-antipattern だけが `cli publish --content map` の壊れた行の文の漏れを REJECT で挙げ、architecture・backend・security・testing は APPROVE だった。裁定役が testing の見落としを同じ指摘にまとめ、run は 11 段のうち 7 段をこの直しに使った（[過去のセッションのフォルダの読み側](session-folder-reading.md)）。#1447 では run の中の 5 人がみな APPROVE し、PR を作った後のマージの run のコーディングレビュー（1 人）が、名前を変えても `export.json` が書き直されない漏れを REJECT で挙げた（[話者の名前の表](speaker-names.md)）。#1317 では、レビューはテストを流し直さず、実装の段の証跡（`command-results.json`）と最終の差分の SHA-256 が合うことだけを見て APPROVE した。

run の報告を読むときは、どの段が実際にコマンドを流したかを証跡のログで見る。レビューの件数が 0 でも、まとめた経路の後処理の取り違えのような、テストが元々見ていない退行は残りうる。

レビューは「仕様に合っているか」に寄る。仕様 [#1593](https://github.com/daiki-beppu/live-mindmap/issues/1593) の子 3 本（#1595〜#1597）は、仕様が関数の型・呼ぶ場所・失敗の扱い・消すテストの名前まで書いていたので、5〜6 観点のレビューがみな APPROVE し、差し戻しは 0 だった。その一方で、計測の `Result` の通らない失敗の経路、区切りごとの反映で増えた仕事、仕様の字面に従ったコールバックの外の `let dropped` には、どの観点も触れなかった（[差分更新の反映](reflection.md)）。仕様に書いていない性能と、通らない経路は、PR の後に人が差分で見る。

## run の所要時間はレビューの待ちで決まる。1 つの観点が長く止まっても、コードのせいとは限らない

#1596 は 79 分のうちレビューが 38 分、#1597 は 82 分のうち 45 分だった。#1597 では、backend のレビューのレポートを書く段が 36 分止まって `Report phase provider returned status "error"` で落ち、やり直すと 25 秒で通った。ほかの観点も、ツールを使わない判定の段が約 10 分ずつかかり、終わる時刻がそろっていた。run が長いときは、コードの量より先に、trace で段ごとの時刻と提供元のエラーを見る。

## 1 回で通った run の PR の本文には、実装の報告が写らない。層の結果は CI の check で見る

仕様 [#1306](https://github.com/daiki-beppu/live-mindmap/issues/1306) の子 3 本（[PR #1326](https://github.com/daiki-beppu/live-mindmap/pull/1326)・[#1328](https://github.com/daiki-beppu/live-mindmap/pull/1328)・[#1370](https://github.com/daiki-beppu/live-mindmap/pull/1370)）は、どれも PR の本文の `## Execution Report` が「Workflow `default` completed successfully.」の 1 行だけだった。チケットの完了条件には「実行した層と結果を実装の報告に書く（PR の本文へ写される）」があり、#1309 には `cli eval` の前後の表も求めていた。どちらも PR からは辿れない。本文に報告が載ったのは、修正や検証の段が報告を書いた run だけだった（[PR #1362](https://github.com/daiki-beppu/live-mindmap/pull/1362) の「P1: 必須検証の実行報告」、[PR #1367](https://github.com/daiki-beppu/live-mindmap/pull/1367) の破壊検証の結果）。

マージの run が修正を積んだ PR でも同じだった。[PR #1517](https://github.com/daiki-beppu/live-mindmap/pull/1517)（#1447）は、マージの run が `export.json` の漏れを直してから入ったが、本文は 1 行のままだった。チケットが求めた `cli eval`・`peopleAccuracy`・`mapShape` の前後の表は、run の `implementation-report.md` にあるだけで、マージのレビューも「before/after 比較表は確認できず」と書いた。親 [#1443](https://github.com/daiki-beppu/live-mindmap/issues/1443) の完了条件「before/after が PR の本文に残っている」は、この形では満たせない。

PR のレビューの run（`evaluate-pull-request-*`）も、最終の段で「機械ゲートは審査しない」と書いて APPROVE する。#1370 のコーディングレビューは、GitHub の CI の check（型検査・unit・IT・heavy IT・E2E）の成功を見て、それを根拠にした。層が通ったかは CI の check で見る。PR の本文に結果を残させたいなら、報告を本文に書く手順をチケットの完了条件とは別に用意する。

裁定の段が、本文に無いことを指摘として採ることもある。[PR #1674](https://github.com/daiki-beppu/live-mindmap/pull/1674)（#1654）は、実装の run で 5 観点が全員 APPROVE だった。ところが PR のレビューの run の裁定が、「TLC の結果が PR に無い」「必須の検査の層と結果が PR に無い」の 2 件（中）を採った。実装の run の検査のログ（`.takt/issue-1654-*.log`）は、レビューの worktree からは見えない。fix の段が TLC と全部の層を回し直し、PR のレビューの run は 16 イテレーション・42 分かかった。回し直しても、マージされた本文は 1 行のままだった。

## PR の本文に書くこと（`Closes #N` など）を完了条件に入れない。run は確かめられず、レビューが全員 APPROVE でも ABORT を繰り返す

takt が PR を作るのは実装の run が終わった後なので、run の中からは PR の本文を確かめられない。[#1628](https://github.com/daiki-beppu/live-mindmap/issues/1628) は、別の issue（#1524）を同じ PR で閉じるために、完了条件に「PR の本文に `Closes #1524` を書く」を入れていた。1 本目の run は 36 分で 5 観点のレビューまで進み、全員 APPROVE、裁定も「直すものなし」だったが、最終の関門が「PR の本文の `Closes #1524` は未確認」で BLOCKED を出し、再計画が「外を待つだけ」として ABORT した。自動の再投入の 2 本も、再計画から約 2.5 分で同じ理由で ABORT した。

本文を「実装の報告に `Closes #1524` を載せる（PR の本文に写る）。確かめるのは実装の報告まででよい」に書き換えると、2 本目の worktree の run は 30 分で通った。けれども、上の節のとおり 1 回で通った run の報告は PR の本文に写らない。PR のレビューの run が「本文の実行報告は定型文と `Closes #1628` だけ」で止まり、案内役の review-fix のセッションが PR の本文を手で直してから通った（[PR #1668](https://github.com/daiki-beppu/live-mindmap/pull/1668)）。チケットを起こす段も、triage のコメントも、この文書にある「写らない」を前提にしていなかった。

ほかの issue を閉じる `Closes` や、PR の本文に残したい表は、チケットの完了条件に書かない。PR ができた後に人か案内役が本文に足す手順として、親 issue か仕様のコメントに書いておく。

## 実装の run の trace と reports は takt の worktree の中にあり、マージの後に消える

実装の run は、`takt-worktrees/<run>/.takt/runs/` に trace と reports を書く。その worktree はマージの後に片付けられる。#1310 の run（`takt-worktrees/20261020T0215-1310-…/.takt/runs`）は、学びをまとめる前に消えていた。#1308・#1309 の worktree も残っていなかった。本体の `.takt/runs/` に残るのは、PR のレビューの run（trace・`coding-review.md`・`review-resolution.md`）と、実装の run の `interventions.jsonl`（終わった時刻と状態だけ）だけだった。

実装の段の計画・決定ログ・層の結果を学びにしたいときは、マージを予約する前に worktree の `.takt/runs/` を読むか、どこかへ写しておく。消えた後に読めるのは、PR の差分とレビューの報告だけになる。

## 隔離コピーで `pnpm` を流すと、リンク先の依存が入れ直される。`verifyDepsBeforeRun` を切る

#1317 の破壊検証は、`server/` の下を隔離コピーし、`node_modules` をシンボリックリンクにして、コピーの `sessions.ts` だけを壊した。そのコピーで `pnpm test` を流すと、pnpm の実行前の依存の確認が依存を入れ直し、リンク先の worktree の Vitest が 5.0.3 から 5.0.5 に変わった。直後の IT は 3 ファイルとも `SyntaxError: The requested module 'effect/Path' does not provide an export named 'make'` で読み込めず、0 件で終わった。`pnpm install --frozen-lockfile --force` で lockfile どおりに戻し、隔離の側の実行に `--config.verifyDepsBeforeRun=false` を付けてから、壊す検証と層をやり直した。

テストが 0 件で終わった実行は、通ったことにも落ちたことにも数えない。

## 準備のスクリプトも、ルートの層も、1 つずつ順に流す。並べると helper の Swift のビルドを取り合って落ちる

#1316 の run は `build-webrtc-apm.sh` と `fetch-speaker-models.sh` を並べて流し、後者が Swift の `error: Build failed` で落ちた。APM のビルドが済んだ後に流し直すと通った。

ルートの層どうしでも同じことが起きる。#1454 の run は `pnpm test` と `pnpm test:it` を 2 分ずらして重ねて流し、ログに「Another instance of SwiftPM … is already running using '…/helper/.build'」が出た。helper の IT の `FileTranscriptionITTests` の 1 件（0〜2 秒が黒、2 秒からが白の動画）が `screen.lines != nil` の期待外れ（`CRImageReaderError 1`）で落ちた。コードを変えずに helper の IT を単独で流すと 150 件通り、ルートの `pnpm test:it` を流し直すと 0 になった。#1461 のマージの run でも、helper の初めてのビルドと並んで走った web の IT 3 件がタイムアウトで落ち、workspace ごとに順に流し直すと通った。#1447 の run も、ビルドとテストを並べた中で web の IT 3 件が 5 秒で時間切れになり、コードを変えずに `VITEST_MAX_WORKERS=2` を付けたルートの `pnpm test:it` で全件通った。そのマージの run は、並べた `pnpm test:it` が helper の映像・音声の同期のテストで 2 回落ち、`pnpm -r --workspace-concurrency=1 run test:it` で通した。どちらも原因は確かめていない。

AGENTS.md の Checks の順（APM → 話者のモデル → `pnpm typecheck` → `pnpm test` → `pnpm test:it`）で、前のコマンドが終わってから次を流す。

## コミットの分け方やマージの仕方を完了条件にしたチケットは、takt に流さず手で引き取る

[#1388](https://github.com/daiki-beppu/live-mindmap/issues/1388) は、「`git mv` だけのコミットを先に置き、英語版の新規作成とは別のコミットにする」を完了条件にしていた。takt の run はこれを満たせず、計画のやり直し（replan）で止まり、takt-sequence のセッションも止まって案内役が判断依頼を出した。結局、run が書いた文面を使って手でコミットを 2 つに分け、rebase でマージした（[PR #1392](https://github.com/daiki-beppu/live-mindmap/pull/1392)）。

takt の PR は squash で予約されるので、run がコミットを分けても main では 1 つになる。コミットの並びや rebase でのマージが要る作業（履歴を残す移動など。[README の 2 つの版](readme-versions.md)）は、起票の時点で手で行う作業として書き、takt-sequence に積む並びから外す。

## 実モデルの eval は完了条件に入れない。「マージ後に人が確かめること」の節に分ける

[#1312](https://github.com/daiki-beppu/live-mindmap/issues/1312) は起票の時点で、完了条件に「`cli eval` を同じサンプルで前後に回し、前後の表を実装の報告に書く」を入れていた。2026-10-18 の takt の run は、コードの直しとテストを済ませたが、この表が作れずに BLOCKED で止まり、案内役が判断依頼を出した。evals は鍵と費用の要る手作業で（AGENTS.md の Evals）、run が回せるとは限らない。2026-10-20 に、この行を完了条件から外して「## マージ後に人が確かめること」の節へ移すと、流し直した run はマージまで進んだ（[PR #1385](https://github.com/daiki-beppu/live-mindmap/pull/1385)）。同じ親の [#1313](https://github.com/daiki-beppu/live-mindmap/issues/1313) も同じ形で流れた。

回せる run もある。2026-10-24 の #1447 の run は、Claude で `cli eval --model`・`peopleAccuracy`・`mapShape` を変更前の main と変更後で同時に流し、表を `implementation-report.md` に書いた。それでも表は PR の本文に届かなかった（上の「1 回で通った run の PR の本文には、実装の報告が写らない」）。回せても回せなくても、表を PR に残すのは人の手になる。

完了条件に残すのは、エージェントが自分で満たせるもの（ルートの層の終了コード、テスト、grep で確かめられる残りの無さ）だけにする。

## 挙動を変えるチケットには、先に赤くなるテストを書いておく。振る舞いを変えない作り替えは、test-first の段で赤くならない

[#1451](https://github.com/daiki-beppu/live-mindmap/issues/1451) の本文は、5 操作 × 4 状態の表のテストについて「今の食い違い（resume・checkResume）は、この表で最初に赤くなる」と書いていた。run の write_tests の段では、その 4 行（期待 `SessionTransition`、実際 `NoSession`）だけが落ちた。175 件のうち 171 件が通り、テストが狙いを捉えていることを実装の前に確かめられた。

[#1452](https://github.com/daiki-beppu/live-mindmap/issues/1452) は、利用者に見える振る舞いを変えない作り替えだった。足した 4 条件のテストは、実装の前から全部通った。実装の担当は「失敗を作るために契約を広げない」と書いて先へ進み、レビューもそれを認めた。test-first の段で赤が出ないことを不備と読まない。代わりに、何が壊れたら落ちるテストかを本文に書いておく（[セッションの開始とブラウザへの送り口](session-start-and-viewers.md) の括弧の失敗のテスト）。

[#1624](https://github.com/daiki-beppu/live-mindmap/issues/1624) も同じ形だった。新しい作り方（`withoutTabDetection()`）の単体テストの red は、その作り方が無いことによるコンパイルエラーだけで、中で前の空文字を渡すだけの実装でも通る。守りたい約束（読み終えたら保留を流す）は今の入力では破れず、仕様も入口の IT を禁じていた。5 観点のうち 4 つが「動かして確かめていない」を指摘にしない懸念に書き、裁定は持ち越した。このときは、動かしていないことを実装の報告に書かせ、守りを作り方の名前と注に置く（[録画からのセッションの helper の経路](recorded-helper-relay.md) の最後の節）。

## 計画が置いた縛りの中で直しが成り立たないと、fix の段は完了を取り消して再計画へ戻す。縛りは計画の側で外す

[#1625](https://github.com/daiki-beppu/live-mindmap/issues/1625) の直しの計画は「判定器が画面の `start` を決めるやり方は変えない」と縛っていた。1 回目の fix は、黒い固定画面と全面が変わる画面で通り、いったん完了を報告した。その後に ai-antipattern の companion が、小さな変化が固定する動画で進みが止まる反例を出した。fix の担当は、その差分を無視すると後で過去の `start` の画面が出て順が壊れることも確かめ、縛りの中では両立しないと判断した。本番のコードに手を入れないまま完了を取り消し、run は fix-replan に進んで縛りを外した。2 回目の fix・検証・2 回目のレビューは全員 APPROVE で通った。

run の所要時間は、1 周で通った #1624 の 44 分に対して 1 時間 51 分で、増えた分のほとんどは 2 回の fix（19 分・16 分）と再計画（7 分）だった。計画の縛り（「〜は変えない」）は、直しの段で崩れることがある。仕様が決めたことでない縛りを計画が置いていたら、レビューの差し戻しの後に疑う。

## マージの run の「fix: apply TAKT PR review changes」は、CI の直しのことがある。中身は本体の `.takt/runs/` の報告で見る

[PR #1461](https://github.com/daiki-beppu/live-mindmap/pull/1461) には「fix: apply TAKT PR review changes」のコミットがある。けれども PR のレビューは APPROVE で、指摘は無かった。このコミットは、マージの run（`20261024-052049-merge-pr-1461-4jlyjc`）が CI の light IT の失敗を調べて直したものだった。直したのは、PR が持ち込んだのではないテストの待ちの不足だった（[セッションの sink](session-sink.md) の録画の stop の節）。run は、CI の失敗 → `investigate_ci`（判定 `defect`）→ `fix_ci` → 直しのレビュー → push → CI が緑、の順に進んだ。

このコミットの中身を知るには、PR の画面ではなく、本体の checkout の `.takt/runs/<日時>-merge-pr-<番号>-*/reports/` にある `ci-investigation.md`・`ci-fix.md`・`ci-fix-review.md` を読む。実装の run と違い、マージの run の報告はマージの後も残る。

## CLI を手で流す受け入れ条件は、合成のセッションと専用の HOME で回させる。本物の会議のフォルダを読ませない

[#1657](https://github.com/daiki-beppu/live-mindmap/issues/1657) の受け入れ条件には、`cli restore` の後の `export.json` と `cli export --format json` の名前を手で確かめることがあった。run は手元の会議のフォルダを使わず、実物の `openLogged` とファイルシステムで名前つきの合成のセッションを保存し、それを比較元にした。そのうえで、専用の HOME とセッションの置き場所で 2 つのコマンドを流した。

```sh
env HOME="$PWD/.takt/issue-1657-cli/home" \
  LIVE_MINDMAP_SESSIONS="$PWD/.takt/issue-1657-cli/sessions" \
  pnpm cli restore
env HOME="$PWD/.takt/issue-1657-cli/home" \
  LIVE_MINDMAP_SESSIONS="$PWD/.takt/issue-1657-cli/sessions" \
  pnpm cli export --format json
```

ライブの保存・restore の後・標準出力の 3 つで JSON 全体が一致し、`log.jsonl` は変わらなかった。会議の中身を読まずに、コマンドの端から端までを確かめられる。CLI の手の確かめを完了条件に入れるときは、この形（合成のセッション、`HOME` と `LIVE_MINDMAP_SESSIONS` を run の中に分ける、比較の結果をファイルに残す）を本文に書いておく。

## 出典

- チケット [#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287)、[PR #1292](https://github.com/daiki-beppu/live-mindmap/pull/1292)
- #1287 の takt の run（`20261017-060712-implement-using-only-the-files-sugyi4`）の計画・2 回の実装の報告と決定ログ
- 仕様 [#1305](https://github.com/daiki-beppu/live-mindmap/issues/1305) の子 [#1316](https://github.com/daiki-beppu/live-mindmap/issues/1316)・[PR #1367](https://github.com/daiki-beppu/live-mindmap/pull/1367) とその takt の run（`20261019-223538-implement-using-only-the-files-k85l61`・`20261019-224050-implement-using-only-the-files-zgghr9`）、[#1317](https://github.com/daiki-beppu/live-mindmap/issues/1317)・[PR #1368](https://github.com/daiki-beppu/live-mindmap/pull/1368) とその takt の run（`20261020-004956-implement-using-only-the-files-4gxc99`）
- 仕様 [#1306](https://github.com/daiki-beppu/live-mindmap/issues/1306) の子 [#1308](https://github.com/daiki-beppu/live-mindmap/issues/1308)・[PR #1326](https://github.com/daiki-beppu/live-mindmap/pull/1326)、[#1309](https://github.com/daiki-beppu/live-mindmap/issues/1309)・[PR #1328](https://github.com/daiki-beppu/live-mindmap/pull/1328)、[#1310](https://github.com/daiki-beppu/live-mindmap/issues/1310)・[PR #1370](https://github.com/daiki-beppu/live-mindmap/pull/1370) と、その PR のレビューの takt の run（`20261018-001428-evaluate-pull-request-1326-usi`・`20261018-022556-evaluate-pull-request-1328-usi`・`20261020-025344-evaluate-pull-request-1370-usi`）
- 仕様 [#1304](https://github.com/daiki-beppu/live-mindmap/issues/1304) の子 [#1320](https://github.com/daiki-beppu/live-mindmap/issues/1320)・[PR #1340](https://github.com/daiki-beppu/live-mindmap/pull/1340)、[#1324](https://github.com/daiki-beppu/live-mindmap/issues/1324)・[PR #1362](https://github.com/daiki-beppu/live-mindmap/pull/1362)
- 仕様 [#1386](https://github.com/daiki-beppu/live-mindmap/issues/1386) の子 [#1388](https://github.com/daiki-beppu/live-mindmap/issues/1388)・[PR #1392](https://github.com/daiki-beppu/live-mindmap/pull/1392) の本文と、#1386 の案内役のコメント
- 仕様 [#1439](https://github.com/daiki-beppu/live-mindmap/issues/1439) の子 [#1442](https://github.com/daiki-beppu/live-mindmap/issues/1442) の takt の run（`20261024-042021-issue-1442-no-no-be-no-wo-shi-hj3cz3`）の実装の報告と決定ログ
- 仕様 [#1303](https://github.com/daiki-beppu/live-mindmap/issues/1303) の子 [#1312](https://github.com/daiki-beppu/live-mindmap/issues/1312) の本文の編集の前後と、[#1296](https://github.com/daiki-beppu/live-mindmap/issues/1296) の triage のコメント、[PR #1385](https://github.com/daiki-beppu/live-mindmap/pull/1385)
- 仕様 [#1436](https://github.com/daiki-beppu/live-mindmap/issues/1436) の子 [#1451](https://github.com/daiki-beppu/live-mindmap/issues/1451)・[PR #1461](https://github.com/daiki-beppu/live-mindmap/pull/1461)、[#1452](https://github.com/daiki-beppu/live-mindmap/issues/1452)・[PR #1465](https://github.com/daiki-beppu/live-mindmap/pull/1465)、[#1454](https://github.com/daiki-beppu/live-mindmap/issues/1454)・[PR #1507](https://github.com/daiki-beppu/live-mindmap/pull/1507) の takt の run（`20261024-044654-issue-1451-sessions-no-no-wo-1-c3mkub`・`20261024-062211-issue-1452-raibuto-karanosessh-vmobcg`・`20261024-110450-issue-1454-sesshonto-cli-play-lrmuz3`）のログと報告、#1461 のマージの run（`20261024-052049-merge-pr-1461-4jlyjc`）の報告
- 仕様 [#1437](https://github.com/daiki-beppu/live-mindmap/issues/1437) の子 [#1447](https://github.com/daiki-beppu/live-mindmap/issues/1447)・[PR #1517](https://github.com/daiki-beppu/live-mindmap/pull/1517)、[#1448](https://github.com/daiki-beppu/live-mindmap/issues/1448)・[PR #1520](https://github.com/daiki-beppu/live-mindmap/pull/1520) の takt の run（`20261024-150123-issue-1447-no-no-miworoguwo-ku-yghm6h`・`20261024-181251-issue-1448-cli-play-de-shita-n-zxileb`）の報告と、#1447 のマージの run（`20261024-160015-merge-pr-1517-obxbck`）の報告。[開発ログ](../devlog/2026-10-25.md#speaker-name-wrap)
- 仕様 [#1438](https://github.com/daiki-beppu/live-mindmap/issues/1438) の子 [#1446](https://github.com/daiki-beppu/live-mindmap/issues/1446)・[PR #1515](https://github.com/daiki-beppu/live-mindmap/pull/1515) の takt の run（`20261024-133903-issue-1446-cli-no-mi-wo-sessio-ruhfky`）のレビューと裁定の報告。[開発ログ](../devlog/2026-10-25.md#session-log-reader)
- 仕様 [#1637](https://github.com/daiki-beppu/live-mindmap/issues/1637) の子 [#1657](https://github.com/daiki-beppu/live-mindmap/issues/1657) の takt の run（`20261027-122913-issue-1657-de-speaker-name-no-1xwjc1`）の実装の報告と決定ログ。[開発ログ](../devlog/2026-10-27.md#speaker-names-in-session)
- 仕様 [#1593](https://github.com/daiki-beppu/live-mindmap/issues/1593) の子 [#1595](https://github.com/daiki-beppu/live-mindmap/issues/1595)・[#1596](https://github.com/daiki-beppu/live-mindmap/issues/1596)・[#1597](https://github.com/daiki-beppu/live-mindmap/issues/1597) の takt の run（`20261026-061655-issue-1595-wo-1-tsuno-mi-minis-2ryel7`・`20261026-072819-issue-1596-raibuno-no-wo-no-mi-ufij5c`・`20261026-094505-issue-1597-logmetrics-wo-no-mi-uu6mix`）の trace と報告。[開発ログ](../devlog/2026-10-26.md#reflect-fold)
- 仕様 [#1612](https://github.com/daiki-beppu/live-mindmap/issues/1612) の子 [#1624](https://github.com/daiki-beppu/live-mindmap/issues/1624)・[PR #1641](https://github.com/daiki-beppu/live-mindmap/pull/1641)、[#1625](https://github.com/daiki-beppu/live-mindmap/issues/1625)・[PR #1644](https://github.com/daiki-beppu/live-mindmap/pull/1644) の takt の run（`20261026-170454-issue-1624-no-no-wo-tabuwo-shi-q0xe0t`・`20261026-185815-issue-1625-karanosesshonno-hel-hdfs52`）の trace と reports、[録画を読む経路を 1 本にしたとき](../devlog/2026-10-27.md#recorded-relay-one-path)
- 仕様 [#1611](https://github.com/daiki-beppu/live-mindmap/issues/1611) の子 [#1628](https://github.com/daiki-beppu/live-mindmap/issues/1628)・[PR #1668](https://github.com/daiki-beppu/live-mindmap/pull/1668) の takt の run（`20261026-221216-issue-1628-cli-play-to-cli-eva-vgx5ew`・`20261026-224854-issue-1628-cli-play-to-cli-eva-6vpoxw`・`20261026-225131-issue-1628-cli-play-to-cli-eva-0y5ej7`・`20261027-035023-issue-1628-cli-play-to-cli-eva-ne56xj`）の trace と reports、PR のレビューの run（`20261027-042106-merge-pr-1668-8k68gv`・`20261027-044534-merge-pr-1668-1-q4glf1`）、[開始前の確かめを入口の表 1 つにまとめたとき](../devlog/2026-10-27.md#startup-checks-module)
- 仕様 [#1638](https://github.com/daiki-beppu/live-mindmap/issues/1638) の子 [#1652](https://github.com/daiki-beppu/live-mindmap/issues/1652)・[#1653](https://github.com/daiki-beppu/live-mindmap/issues/1653)・[#1654](https://github.com/daiki-beppu/live-mindmap/issues/1654)（[PR #1674](https://github.com/daiki-beppu/live-mindmap/pull/1674)）の takt の run（`20261027-084931-issue-1653-raibu-session-no-wo-66bcbk`・`20261027-101629-issue-1654-pushscreen-wo-scree-7q88my`）の計画、PR のレビューの run（`20261027-104833-merge-pr-1674-j8t7cz`）の裁定、[共有画面の持ち越しを 1 つのキューにしたとき](../devlog/2026-10-27.md#screen-queue)
