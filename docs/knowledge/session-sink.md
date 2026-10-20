# セッションの sink

server のセッションの sink（`server/src/sessionSinks.ts`）と、その内側の 3 つのモジュールを触るときに読む文書。3 つは語彙の `sessionVocabulary`、発言の流れの `remarkFlow`、録画の feed の `recordedFeed` で、ほかに再生の補正の `replayCorrection` もここに入る。規則をどのモジュールに置くか、ライブと録画からのセッションの違いをどこに書くか、どの層のテストで確かめるか、待ちと停止の競合をどう避けるかの基準を書く。決定そのものは仕様 [#1304](https://github.com/daiki-beppu/live-mindmap/issues/1304) と、その元の [#1242](https://github.com/daiki-beppu/live-mindmap/issues/1242)・[#1243](https://github.com/daiki-beppu/live-mindmap/issues/1243)・[#1294](https://github.com/daiki-beppu/live-mindmap/issues/1294) の解決コメントにある。

- 用語: [録画からのセッション・再生・発言・途中結果・字幕・語彙・一時停止・共有画面](../../GLOSSARY.md)
- ADR: [0008 ヘルパーのライフサイクルは、stop を印で、サーバーの終了を Scope で止める](../adr/0008-helper-lifecycle-on-effect.md)（Service は 3 つ）、[0015 語彙での補正はサーバーが発言を締めるときにかけ、読みはヘルパーが送る](../adr/0015-correct-remarks-in-server-readings-from-helper.md)

## 規則は 3 つのモジュールのどれかに置き、そのモジュールの unit で確かめる。sink のクロージャに戻さない

`SessionSinks` は組み立てるだけの役で、規則を持たない。規則ごとの置き場所は次のとおり。

| 規則 | 置き場所 | unit |
|---|---|---|
| 頼んだ語の集合、画面の候補、読みの 2 段の取得、`from`、中断したときの行、`RemarkCorrection` | `sessionVocabulary` | `sessionVocabulary.test` |
| settling → 補正 → 採番（`r1`・`s1`）→ 字幕の表 → `session.push` → relay の順 | `remarkFlow` | `remarkFlow.test` |
| 画面の待ち行列、2 トラックの並べ替え、溜まり、等速、`roomForRemark`、hold、一時停止の知らせ、作った発言の end | `recordedFeed` | `recordedFeed.test` |

3 つとも `Context.Service` にはせず、引数の関数とレコードだけに依存する。FileSystem も使わない。こうすると、偽の `ReadingSource`・`Inlet`・`session` と TestClock だけで規則を試せて、ADR 0008 の「Service は 3 つ」も崩れない。溜まり（語彙の pool）のファイルの読み書きと書き出しは sink に残っている。

分ける前は、規則が 1 つのクロージャに埋まっていた。録画の並びの規則は、CLI と server を通す `cliRecorded.it` でしか試せなかった。`recordedFeed.test` は今 28 件あり、TestClock の上で並び・等速・一時停止・`discard`・再起動の位置を見ている。新しい規則を足すときも、まずこの 3 つのどれの規則かを決める。sink に `Ref` や分岐を足すのは避ける。

## ライブと録画の違いは、組み立ての 3 か所にだけ書く

`openSink` は、ライブ（`open` → `LiveSink`）と録画からのセッション（`openRecorded` → `RecordedSink`）で同じ道を通る。違いは次の 3 つだけ。

- **feed**: ライブは `directFeed`、録画は `recordedFeed`
- **`captions`**: ライブは `"途中結果から"`、録画は `"入れた発言だけ"`
- **画面の語彙を頼む時点**: ライブは画面を入れた後に `from` なしで頼む。録画は受け取った時点で `from` 付きで頼む

前は `backlog === undefined` の分岐が 10 か所に散っていた（[#1322](https://github.com/daiki-beppu/live-mindmap/issues/1322) で 3 か所に集めた）。録画にだけ要る振る舞いを足すときは、`recordedFeed` か `RecordedSink` の 3 メンバー（`drainForRestart`・`finishBacklog`・`discardBacklog`）に置く。`captions` の値で分岐する箇所は、増やさない。

`from` より前の途中結果と発言を捨てる処理（`applyRecordedEventFrom`）は、sink ではなく `sessions.ts` の録画の側にある。

## sink の型は、その経路を実際に呼ぶ口から決める。録画も話者の起動し直しと名前付けを使う

仕様の型の案では、`speakersRenumbered` と `nameSpeaker` を `LiveSink` だけに置いていた。けれども録画からのセッションも、ヘルパーを起動し直せば `speakersRenumbered` を呼ぶ（`sessions.ts` の再起動の知らせ）。名前付けも、ライブと同じ `POST /session/speaker-name` で受ける。そこで [#1324](https://github.com/daiki-beppu/live-mindmap/issues/1324)（[PR #1362](https://github.com/daiki-beppu/live-mindmap/pull/1362)）は、この 2 つを `SinkBase` に置き、`LiveSink` には `clearSpeaking` だけを残した。そうしても `cliRecorded.it` の「録画からのセッションでも、ライブと同じ POST /session/speaker-name で振られたラベルに名前を付けられる」と、起動し直した後のラベルのテストが通り続けた。

メンバーを片方の型から外すときは、`sessions.ts` でそのメンバーを呼んでいる箇所を、ライブと録画の両方の経路で探す。

## `recorded` の名前は録画からのセッションだけに使う。ログを書くセッションは `logged`

ライブ・再生・録画からのセッションが共通で通る「ログを書きながら動くセッション」は、`openLoggedSession`・`LoggedSessionOptions` と呼ぶ。テストは `loggedSession*.it` にある。過去のセッションのフォルダからログを読む CLI の関数は `loadSessionLog`、再生で流す行の判定は `isReplayedEvent` という名前になっている（[#1319](https://github.com/daiki-beppu/live-mindmap/issues/1319)）。`recorded` の付く名前（`RecordedSink`・`recordedFeed`・`/session/recorded`・`cliRecorded.it`・`sessionsRecorded.it`）は、どれも [録画からのセッション](../../GLOSSARY.md) を指す。

新しい名前を付けるときも、ログを書くことを指すなら `logged`、録画のファイルから組み立てることを指すなら `recorded` を使う。注に「記録したセッション」と書くと、どちらの意味か読み分けられない。「ログを書くセッション」か「過去のセッションのフォルダ」と書く。

## `remarkFlow` の feed の工場の中では、`Inlet` を呼ばない

`makeRemarkFlow` は、`Inlet` を作ってから `options.feed(inlet)` で feed を作り、その後で settling を作る。字幕の relay は、settling より前に作る。relay の `context` は settling の preview を参照するが、`context` が評価されるのは送るときだけなので、それまで settling が無くても困らない。この順にしたので、「flow が feed を要り、feed が flow を要る」循環を `Effect.suspend` で逃がす書き方が要らなくなった。

裏を返すと、feed の工場の中で `Inlet` を呼んで入力を入れると、まだ作られていない settling を読みに行く。feed の工場では、状態を作るだけにする。

sink の側にも、遅い束縛がもう 1 つある。`openLoggedSession` は、開いた時点で最初の差分更新の frame を送るので、そのときにはまだ feed が無い。そこで `observe` を `let` で持ち、feed を作った後に差し込んでいる。この束縛は sink の組み立ての中に閉じている。外へ広げない。

## 待ちを挟んで入れる段は、入れる直前にもう一度一時停止を見る（hold → pace → hold）

録画の溜まり（`server/src/recordedBacklog.ts`）は、1 件ずつ hold → pace（等速なら時刻まで待ち、発言なら `roomForRemark` も待つ）→ hold → deliver の順に進む。前は hold を pace の前に 1 回だけ見ていた。そのため、時刻を待っている間に一時停止へ変わると、一時停止の最中に発言が入った。[#1323](https://github.com/daiki-beppu/live-mindmap/issues/1323)（[PR #1360](https://github.com/daiki-beppu/live-mindmap/pull/1360)）が pace の後にも hold を足した。確かめているのは `recordedFeed.test` の「時刻待ち中にpausedへ変わるとframeが届く前でも入れない」。

形式仕様（#1304 の Formal Spec のコメント）の `invNoAdmitWhilePaused` は、「一時停止でない」と「入れる」を同じ 1 歩で扱っている。待ちを挟む段に新しい待ちを足すときは、その待ちの後で、入れる条件を見直す。

`hold` と `roomForRemark` は、状態を読む前に合図（`frameChanged` の Deferred）を取ってから読む。読んでから合図を取ると、読んだ直後に来た変化を取りこぼす。

## 停止と待ちの解除の競合は、IT で時刻に任せず、unit で順を決めて試す

`cliRecorded.it` の「処理を待つ発言の数が上限で待っている間の Ctrl-C は…待っていた発言は入れず…」は、手元の Mac では毎回落ち（4 回中 4 回）、CI では通っていた（[#1273](https://github.com/daiki-beppu/live-mindmap/issues/1273)）。テストは `Fiber.interrupt` を fork した直後に、差分更新の gate を解いていた。中断が届くより先に gate が開くと、待っていた `r3` が入る。製品の規則（stop を受けた時点で待っている発言を捨てる）は崩れておらず、壊れていたのはテストの組み方だった。

`recordedFeed.test` の「上限で待つ1件をdiscardし、その後に待ちを解いても入らずfinishが戻る」は、待っている 1 件があることを確かめてから `discard` を呼び、その後で待ちを解き、入らないことを見る。順はテストが決めるので、マシンの速さに左右されない。CLI の Ctrl-C が `/session/stop` に届くまでの配線は、`cliRecorded.it` の Ctrl-C のテストに残っている。

停止・一時停止・再起動と待ちが絡むテストを書くときは、`recordedFeed` に偽の `session`（Ref で状態を切り替える）と `Inlet` を渡し、待ちに入ったことを `until` で確かめてから次の操作をする。

## 語彙の `settled` は待つだけで、裏の失敗を運ばない。失敗を返したいときは `addUser`・`addScreen` が返す join を待つ

`settled` の正体は `FiberSet.awaitEmpty` で、中では `Fiber.await` をしている。読みを作る fiber が vocab の行を書けずに落ちても、`settled` は成功で返る。[#1325](https://github.com/daiki-beppu/live-mindmap/issues/1325)（[PR #1363](https://github.com/daiki-beppu/live-mindmap/pull/1363)）は takt のレビューでこの点を指摘された。そこで `addUser`・`addScreen` が `Effect<Effect<void>>`（外側は頼むだけで、すぐ返る。内側はその fiber の join）を返すように直した。

- **ライブの sink**: 内側を捨てる（`Effect.asVoid`）。語を足すたびに発言の流れを止めないため
- **再生の補正**: `settled` を待った後に、内側も待つ。ログの書き込みの失敗を `pushScreen` と decorator を開く処理へ返すため（`replayCorrection.test` の「screen保存後の語彙ログ失敗をpushScreenへ伝える」）

## 再生は発言の流れに通さない。語彙だけを共有し、画面ごとに `settled` を待つ

`withReplayCorrection` は、`makeSessionVocabulary` の上に載っている。読みは `logReadings`（ログの vocab の行から、表記ごとに最初の null でない読みを引く）から取り、読みのサブコマンドもモデルも呼ばない。ライブとは次の点が違うので、`remarkFlow` の 3 本目の feed にはしない（[#1243](https://github.com/daiki-beppu/live-mindmap/issues/1243)）。

- 再生の入力はもう締めた発言で、settling・採番・字幕・並べ替えのどれも要らない
- `play --realtime` は、ライブと同じ呼び方での遅れを測るためのもの。詰まりの待ちを入れると測れなくなる
- 画面の規則が違う。再生は `start <= 発言の start`、録画は `start < 発言の end` で、再生の画面の語には `from` を付けない
- 再生は語彙の pool をわざと読まない。同じログからは同じ結果を出すため

`pushScreen` は `addScreen` の後に `settled` を待ってから返す。待たないと、画面の直後の発言がその語で直るかどうかが fiber の順で決まり、実行ごとに再生の結果が変わる。

## 起動し直す位置は `drainForRestart` の 1 回で取る。並べ替えの保留は出さずに数える

`RecordedSink.drainForRestart` は、settling だけを締め（`flow.drainForRestart`）、続けて `recordedFeed.prepareRestart` を呼ぶ。返すのは、トラックごとの作った発言の end。並べ替えの保留も溜まりの未反映の分も、作った発言として数える。先読みの画面のうち、その end の最大より後のものは刈る。刈った画面は、ヘルパーが読み直したときにもう一度届く。前は「drain → `lastRemarkEnds` の読み取り」の 2 回を sessions が順に呼んでいて、その順の約束を呼ぶ側が覚えておく必要があった（[#1324](https://github.com/daiki-beppu/live-mindmap/issues/1324)）。

起動し直した後の screen-off も、同じ sink へ渡す。同じ印が二度入らないようにするのは `recordedFeed` の役目で、端末への知らせは sessions の側が 1 回だけにしている（[#1323](https://github.com/daiki-beppu/live-mindmap/issues/1323)、`sessions.test` の「音声1本とscreen-off不在では通知せず、複数音声とscreen-offは再起動をまたいで1回だけ通知する」）。

## IT は、値がその境界を越えた後で決まるものだけにする。CLI を通すのは CLI が決める値だけ

線引きは [#1118](https://github.com/daiki-beppu/live-mindmap/issues/1118) に従い、同じ契約を 2 つの層で確かめていたら低い層を残す。仕様 #1304 と [#1305](https://github.com/daiki-beppu/live-mindmap/issues/1305) の後、IT に残っているものは次のとおり（件数は 2026-10-20 の main で、`.each` を 1 件と数える）。

- **`cliRecorded.it`（33 件）**: CLI が NDJSON を受けてから決める値（標準出力のパス・進み具合の行・知らせの行・失敗の文面・Ctrl-C で `/session/stop` を送ること・引数の誤り）
- **`sessionsRecorded.it`（4 件）**: `Sessions` と本物の録画の sink を、偽のヘルパー（`test/fixtures/recordedHelper.ts`）でつないだもの。ファイルを書くことだけを見る（録音のファイル・題名と語彙のログ・諦めたときと接続待ちで止めたときの書き出し）。CLI のプロセスは通さない。[#1323](https://github.com/daiki-beppu/live-mindmap/issues/1323) が `cliRecorded.it` から移した 14 件のうち、フォルダ名と時刻の基準・起動し直しの `--from`・書き込みの失敗などの配線は、[#1317](https://github.com/daiki-beppu/live-mindmap/issues/1317) が `sessions.test` の「録画の開始と再送の配線」へ下ろした（[取り込みの試行](intake-attempts.md)）
- **`sessionSinks.it`（32 件）**: log.jsonl の行の並び（vocab の行が remark の行より前）・書き出し・溜まりのファイルの往復・Scope とフォルダ、それとライブと録画の組み立ての代表

`audioFileNames`（録音のファイル名の採番）は、sink に依らない関数として `sessionSinks.test` で試している。

重なりを消すだけでも速くなる。[#1320](https://github.com/daiki-beppu/live-mindmap/issues/1320)（[PR #1340](https://github.com/daiki-beppu/live-mindmap/pull/1340)）は、触った 3 ファイルの軽い IT を 226 件から 154 件に減らし、同じマシンで 9.4 秒から 8.2 秒になった。テストを unit へ下ろすときは、それが置き換える IT のテストを同じ PR で消す（[CODING_STANDARDS.md](../../CODING_STANDARDS.md) の Tests の replace, don't layer）。

## 出典

- 仕様 [#1304](https://github.com/daiki-beppu/live-mindmap/issues/1304)（Formal Spec のコメントを含む）、親 [#1318](https://github.com/daiki-beppu/live-mindmap/issues/1318)
- チケット [#1319](https://github.com/daiki-beppu/live-mindmap/issues/1319)・[PR #1327](https://github.com/daiki-beppu/live-mindmap/pull/1327)、[#1320](https://github.com/daiki-beppu/live-mindmap/issues/1320)・[PR #1340](https://github.com/daiki-beppu/live-mindmap/pull/1340)、[#1321](https://github.com/daiki-beppu/live-mindmap/issues/1321)・[PR #1358](https://github.com/daiki-beppu/live-mindmap/pull/1358)、[#1322](https://github.com/daiki-beppu/live-mindmap/issues/1322)・[PR #1359](https://github.com/daiki-beppu/live-mindmap/pull/1359)、[#1323](https://github.com/daiki-beppu/live-mindmap/issues/1323)・[PR #1360](https://github.com/daiki-beppu/live-mindmap/pull/1360)、[#1324](https://github.com/daiki-beppu/live-mindmap/issues/1324)・[PR #1362](https://github.com/daiki-beppu/live-mindmap/pull/1362)、[#1325](https://github.com/daiki-beppu/live-mindmap/issues/1325)・[PR #1363](https://github.com/daiki-beppu/live-mindmap/pull/1363)
- [#1273](https://github.com/daiki-beppu/live-mindmap/issues/1273)（停止と待ちの解除の競合）
- 仕様 [#1305](https://github.com/daiki-beppu/live-mindmap/issues/1305) の子 [#1317](https://github.com/daiki-beppu/live-mindmap/issues/1317)・[PR #1368](https://github.com/daiki-beppu/live-mindmap/pull/1368)（IT の件数と、知らせのテストの名前）
