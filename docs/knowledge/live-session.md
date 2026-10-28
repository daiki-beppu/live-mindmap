# helper のライブのセッション

helper のライブのセッション（`cli start` から helper が取り込む経路）を触るときに読む文書。触る場所は、`helper/Sources/HelperCore/LiveSession.swift`（入口と 5 段の片付け）・`LiveDevices.swift`（機器の 7 枠）・`LiveSettings.swift`、イベントの送り口 `WebSocketServer.send(_:)` と、残すかどうかを決める `Events.swift` の `HelperEvent.delivery(retained:)`。片付けの順、イベントの残し方と溜め方、送り手の待ち方、テストの置き場所を書く。決定そのものは仕様 [#1639](https://github.com/daiki-beppu/live-mindmap/issues/1639) と、その元の [#1559](https://github.com/daiki-beppu/live-mindmap/issues/1559)（終わらせ方）・[#1560](https://github.com/daiki-beppu/live-mindmap/issues/1560)（残すイベント）・[#1561](https://github.com/daiki-beppu/live-mindmap/issues/1561)（interface）・[#1562](https://github.com/daiki-beppu/live-mindmap/issues/1562) にある。

- 用語: [ライブのセッション・共有画面・自分の休止・話者分離・トラック](../../GLOSSARY.md)
- ADR: [0002 音声取得と STT はローカルのヘルパーが行い、Web アプリには文字起こしのイベントだけを渡す](../adr/0002-local-stt-helper.md)、[0013 話者分離はヘルパーが STT とは別のイベントで流し、サーバーが発言を話者で切る](../adr/0013-diarize-in-helper-split-remarks-by-speaker.md)
- 関連する知識文書: [helper のイベントの見本](helper-events.md)（イベントの JSON の形）、[録画からのセッションの helper の経路](recorded-helper-relay.md)（同じ `send` を使う録画の経路）、[helper の IT の時間切れ](helper-it-timeouts.md)（`LiveSessionITTests` を足すときの協調スレッドの罠）

## `main.swift` に残すのは、引数・本物の機器・signal・終了コードだけ。組み立ては `LiveSession` に足す

入口は `LiveSession` の `start()`（準備と待ち受けまで。待ち受けたポートを返す）・`run()`（取り込みと片付け）・`stop()`（何度呼んでもよく、`run` の前でもよい）の 3 つ。`main.swift` は、引数と環境変数を読み、本物の機器を作って `LiveDevices` に詰め、`listening on ...` を書き、SIGINT・SIGTERM を `stop()` に結び、失敗を終了コードに変えるだけにする。

機器（`tap`・`microphone`・`makeTranscriber`・`makeDiarizer`・`inputUsage`・`screen`・`clock`）は `LiveDevices` の 7 枠で、テストでは偽物に差し替える。`WebSocketServer`・録音・エコー消し・音の分岐は枠に入れず、`LiveSession` の中で本物を作る。「送り終わりを待ってから閉じる」は本物の server でしか確かめられないからだ。`RunAudio` は `LiveSession` の内側の seam で public ではない。時刻（原点・無音の判定の 10 秒・休止の監視の 0.5 秒・`speaker-off` の時刻）は、すべて `clock` の枠から取る。ホストの時刻を直に読むと、偽の時計のテストで値が決まらない。

## 片付けは 5 段。守る順は段の並びで、段の中は順不同

`run()` の片付けは、止める → 流し切る → 送り終わりを待って server を閉じる → 指示の Task を待つ → 失敗を選ぶ、の順に書いてある。段の中の順は守る順ではないので、並べて待ってよい。段の中の順を確かめるテストは足さない。

- **送り終わりの待ちは、共有画面の有無によらず段 3 に置く。** 前は共有画面の Task の末尾がついでに `waitUntilSent` を呼んでいただけで、`--no-screen` や画面収録の許可が無い Mac では誰も待たず、止める直前の発言・話者の区間・`self-pause-state` が落ちえた（[#1666](https://github.com/daiki-beppu/live-mindmap/issues/1666)）。送り手の Task の中で待ちを済ませる形に戻さない。
- **指示の Task は段 3 の後で待つ。** server の受け取りの流れ（`messages`）は server を止めたときにしか終わらないので、逆にするとハングする。
- **失敗は、本処理 → `相手` の録音 → `自分` の録音の順に最初のものを投げる。** マイクの機器の変化（`MicrophoneError.configurationChanged`、終了コード 75）を録音の失敗で上書きすると、server が起動し直しを失敗として数える。

どの段のハングも失敗としては出ず、SIGTERM から 5 秒後の SIGKILL として出る（録音のファイルが閉じられずに残る）。片付けを変えたら、`LiveSessionITTests` の期限つきの待ちで「`run()` が戻る」を見る。かかった時間では合否を出さない。

## 止める前にイベントを出す送り手は、片付けが待てる形で持つ。投げっぱなしの `Task` で送らない

段 2 は「送り手がもう出さない」ことを待つ段なので、誰も持っていない `Task { await server.send(event) }` は待てない。`tap-silent` がそうなっていて、止める直前に判定が重なると server を閉じた後に送られて落ちえた（[#1667](https://github.com/daiki-beppu/live-mindmap/issues/1667)）。

今は、話者のイベントと `tap-silent` が `LiveSession` の 1 本の `AsyncStream`（`eventContinuation`）に入り、段 2 がそれを閉じて読み終わるまで待つ。新しい送り手を足すときも、この流れに `yield` するか、段 2 で待つ Task を持つ。`LiveCapture` に `server` を渡さず、`emitEvent` の閉包だけを渡しているのはそのためだ。

## 残すかどうかは `HelperEvent.delivery(retained:)` の表が決める。呼ぶ側は key を書かず、`default` を足さない

送り口は `WebSocketServer.send(_ event: HelperEvent)` だけで、ライブ・録画のどの経路もこれを使う（[#1665](https://github.com/daiki-beppu/live-mindmap/issues/1665)）。後から接続したクライアントに最新の 1 件を送り直すか（`.retain(枠)`）、最初の接続まで溜めるか（`.bufferUntilFirstClient`）、今つながっている相手にだけ送るか（`.connectedOnly`）は、`delivery(retained:)` の網羅の `switch` が返す。`HelperEvent` に case を足すと、ここに行を書くまでコンパイルが通らない。`default` で吸収すると、その決め忘れが黙って通る。

- 枠はエンコードした文字列ではなく `HelperEvent` で持つ。`screen` の行が、覚えている `start` より前の画像を `.connectedOnly` にする（遅れて出る前の時刻の画像で、新しい画面を上書きしない）。呼ぶ側に `latestStart` のような状態を持たせない。
- 接続したときは、覚えた枠を `HelperEventRetentionSlot` の宣言順（`origin` が先頭）に送り、その後に溜めた分を送った順に送る。起動の段取りでイベントの出る順が変わっても、届く順は変わらない。
- 溜めるのは最初の接続までで、その後は全接続が切れても溜め直さない。helper のクライアントは server の 1 本だけで、つなぎ直しは別の helper プロセスになる。
- ライブの経路は `waitForClient()` で待たない（`audio.run` の前に待つと、SIGINT で戻らない）。溜めるので待たなくても落ちない。録画の経路の `waitForClient()` は「つながってから読み始める」合図として残っている。
- エンコードに失敗したイベントは、`send` は投げず、標準エラーに種類の名前だけを書いてその 1 件を送らない。`EncodingError` の文には発言の本文や画像が入りうるので、中身は書かない。

表は socket なしの unit（`HelperEventDeliveryTests`）、溜め方と接続時の順は本物の server とクライアントの light IT（`WebSocketServerITTests`）が持つ。`LiveSessionITTests` では「後から来たクライアントに残す」を確かめない（同じ壊れ方を 2 つの層で見ない）。

## `waitUntilSent` は「送信の完了のコールバックが返った」までで、受け手が読み終えたことではない。大きなフレームの直後に閉じると届かないことがある

#1666 の実装の run で、server だけを立てて「`origin` → 524,288 文字の発言（JSON で 1,573,025 バイト）→ `waitUntilSent` → `stop`」とすると、未完了の送信が 0 件・完了のコールバックに失敗なしでも、受け手には `origin` しか届かなかった。同じ入力で、受け取った後に `stop` すると届いた。

本物の認識がこの量の発言を作る根拠は無いので、要件にはせず、テストの発言は通常の一文にした（直したとは扱っていない。比べたコードは run の `.takt/close-timing-*` に残したが、worktree とともに消える）。ただし、共有画面の `screen` は JPEG の base64 を載せるので、発言より大きなフレームになる。どの大きさから読み残しが起きるかは測っていない。止める直前の画面が届かない報告が来たら、まずここを疑い、段 3 の待ちを「受け手が読んだ」まで延ばすかを決める。

## テストは `LiveSessionITTests`（light IT）に置き、偽の `LiveDevices` は同じファイルの private に置く

越えるのは localhost の socket と一時フォルダへの書き込みだけなので light IT で、本物の server を使うので unit にはできない（`server/scripts/check-test-layers.ts`）。`makeTranscriber`・`makeDiarizer` は偽物、重複の印は付けない設定（エコー消しを動かさない）、録音は本物を一時フォルダに書く。録音の失敗を起こすテストだけ、internal の `init(devices:settings:recording:sendEvent:)` で失敗する録音を差す。public の `init` と `LiveDevices` の 7 枠は、テストのために変えない。偽の `LiveDevices` を他のファイルでも使うようになったら `…TestSupport.swift` に出す（前例: `EchoTestSupport.swift`・`FileReadingGateTestSupport.swift`）。

偽の機器のフックの中で、テスト本体が解くセマフォを待たない。フックは協調スレッドで動くので、スレッドの少ない CI では他の IT まで止まる（[helper の IT の時間切れ](helper-it-timeouts.md)）。

`main.swift` に残る配線のテストは足さない。子プロセスを立てる heavy IT が要るのに、`RunArgumentsTests`・`ExitCodeTests` で捕まらない壊れ方を示せない。

## 出典

- [helper のライブのセッションを差し替えられる module にしたら、止める直前のイベントの欠けが直り、CI の時間切れの 1 つはテスト自身が協調スレッドを塞いでいた話](../devlog/2026-10-28.md#live-session-module)
- 仕様 [#1639](https://github.com/daiki-beppu/live-mindmap/issues/1639)（Formal Spec のコメントを含む）、親 [#1658](https://github.com/daiki-beppu/live-mindmap/issues/1658)
- チケット [#1665](https://github.com/daiki-beppu/live-mindmap/issues/1665)・[PR #1679](https://github.com/daiki-beppu/live-mindmap/pull/1679)、[#1666](https://github.com/daiki-beppu/live-mindmap/issues/1666)・[PR #1680](https://github.com/daiki-beppu/live-mindmap/pull/1680)、[#1667](https://github.com/daiki-beppu/live-mindmap/issues/1667)・[PR #1683](https://github.com/daiki-beppu/live-mindmap/pull/1683) の差分
- #1666 の takt の run（`20261027-151836-issue-1666-raibunosesshonwo-li-13zueu`）の plan・implementation-report・coder-decisions
