# セッションの開始とブラウザへの送り口

`server/src/sessions.ts` の開始の括弧（`openSession`）・開始の準備（`prepareMap`）・状態の門番（`current`）と、`server/src/viewers.ts` の送り口（`forSession`）・frame の種類ごとの表（`END_FRAMES`）を触るときに読む。セッションの開始に段を足すとき、状態ごとに通す操作を変えるとき、ブラウザへ送る frame の種類を足すとき、セッションの終わりに画面から何を消すかを変えるときが当てはまる。形を決めたのは仕様 [#1436](https://github.com/daiki-beppu/live-mindmap/issues/1436) で、元の判断は [#1426](https://github.com/daiki-beppu/live-mindmap/issues/1426)・[#1428](https://github.com/daiki-beppu/live-mindmap/issues/1428) の解決コメントにある。

- 用語: [セッション・録画からのセッション・再生・ローカルモード・自分の休止・字幕・話者の名前](../../GLOSSARY.md)
- ADR: [0008 ヘルパーのライフサイクルは、stop を印で、サーバーの終了を Scope で止める](../adr/0008-helper-lifecycle-on-effect.md)（Service は 3 つ）、[0009 HTTP とブラウザ向けの WebSocket は effect/http で受ける](../adr/0009-http-and-browser-socket-on-effect-http.md)（先に購読してから保持値を送る）、[0023 CLI と server は 1 つの受け渡しのモジュールを共有する](../adr/0023-cli-and-server-share-one-protocol-module.md)
- 関連: [セッションの sink](session-sink.md)、[取り込みの試行](intake-attempts.md)

## 状態で操作を断る条件は門番 `current` の表に書く。操作の中で `Ref.get(state)` を見て guard を書かない

`current(need, claim?)` が、状態ごとの答えを 1 か所で決める。

| 状態 | `need: "live"` | `need: "any"` |
|---|---|---|
| idle | `NoSession` | `NoSession` |
| starting・stopping | `SessionTransition` | `SessionTransition` |
| recorded | `NotForRecordedSession` | 通す |
| live | 通す | 通す |

前は同じ guard が `resume`・`checkResume`・`liveSession`・`setSelfPause`・`setSpeakerName` に手で 5 回写されていた。そのうち `resume`・`checkResume` だけが、開始中・終了中のセッションに `NoSession`（「進行中のセッションがありません」）を返していた。[#1451](https://github.com/daiki-beppu/live-mindmap/issues/1451)（[PR #1461](https://github.com/daiki-beppu/live-mindmap/pull/1461)）がこれを門番に寄せた。`sessions.test` の `$state の $operation は $expected を返す`（5 操作 × 4 状態の 20 行）を先に書くと、その 4 行（starting・stopping × resume・checkResume）だけが赤くなった。状態で断る操作を足すときは、門番を呼び、この表に行を足す。

`stop` は `current("any", "stopping")` で呼ぶ。状態を確かめてから stopping へ移すまでを同じ `Ref.modify` の中で済ませ、間に別の stop が入る隙を作らない（`%s の flush 待機中の二重 stop は拒否し、書き出しと close は1回だけ行う`）。

門番に寄せないものもある。どれも答える問いが違う。

- `resume` の途中で「同じ live か」を 2 回確かめる所（`Aborted`）
- `reserveDeps`（idle の予約の数だけを見る）
- `concludeRecorded` の「この recorded か」の取り合い
- `status` と `claimStart`

## 開始に段を足すときは括弧の `body` に書く。状態の公開・`afterPublish`・`session-mode` の送りは括弧が持つ

`start` と `startRecorded` は、どちらも `openSession` を 1 回呼ぶだけになっている（[#1452](https://github.com/daiki-beppu/live-mindmap/issues/1452)、[PR #1465](https://github.com/daiki-beppu/live-mindmap/pull/1465)）。括弧は次の順で進む。

`claimStart` → `Scope.fork(serverScope)` → その Scope で `viewers.forSession` → `body(scope, send)` → `Ref.set(state, active)` → `afterPublish` → `send` で `session-mode`

`body` は状態に触れず、scope も閉じない。`body` が動いている間、状態は必ず starting で、門番は `SessionTransition` を返す。どの段で失敗しても、中断されても、括弧が scope を閉じて `idle{0}` に戻す。括弧は全体を `Effect.uninterruptibleMask` で包み、`body` だけを `restore` で中断できるように戻している。claim の直後に中断されても、starting や取りかけの scope が残らない。claim そのものに断られたとき（もう別のセッションがある）は後片付けの外に置き、今のセッションを idle に戻さない。

録画の終わりの見張り（`running.end` を待って `concludeRecorded` する fiber）は、`body` の中で fork せず、まだ走らせていない Effect のまま `afterPublish` で返す。`concludeRecorded` は状態が「この recorded」であることを確かめて取り合う。状態を公開する前に見張りが走ると、すぐ読み終えたときに結末を誰も引き取らない。

ライブと録画からのセッションの違いは、`body` の中の種類ごとの段（準備・取り込みの引数・イベントの振り分け・終わり方）にだけ書く。種類ごとの内側の記録（`SessionKind`）は作らないと決めている（#1426）。

## `prepareMap` は入口別の入力で `StartupChecks.prepare` を一回呼ぶ

`prepareMap` は Sessions の中に残る。`options` は `{ mode: "start"; screen: boolean } | { mode: "recorded" }` で受け、開始時の経路と計画を `StartupChecks.prepare` に渡す。`start` だけが `screen` を持ち、`recorded` は `noMap: false` を持つ。helper の確認方法を選ぶのは `StartupChecks` で、呼ぶ側から確認 Effect を渡さない。

`StartupChecks` は必須不足をまとめて停止し、そろえば `prepareUpdater(plan)` を呼ぶ。依存付きの準備失敗を `StartupDepsMissing` に変換し、準備の `notice` を確認警告の末尾へ一度だけ追加する。呼び出し元のセッション Scope は `prepareMap` から渡す。

録画の `noMap` と resume も同じ準備操作を一回呼ぶが、updater を組まず `warnings` だけを受け取る。resume と `checkResume` は、同じ Live に保持した開始時の経路・screen を使う。確認後の同一 Live の検証と、開始失敗・中断時に Scope を閉じる括弧の規則は維持する。

## HelperEvent を足したら、ライブの `applyEvent` と録画の `applyRecordedEvent` の両方に case を書く。`default` は置かない

`applyRecordedEvent` は、前は `default: Effect.void` で終わっていた。新しい HelperEvent を足しても、録画からのセッションでは型が何も言わずに捨てていた。#1451 で `default` を外し、録画で使わない 4 種類（`origin`・`tap-silent`・`self-pause`・`self-pause-state`）を、何もしない case として名前で並べた。今はライブも録画も、15 種類すべてを網羅する switch になっている。

戻り値の型 `Effect.Effect<void>` は関数に明示しておく。switch の後ろに無条件の `return Effect.void` を置くと、網羅の検査が効かなくなる。HelperEvent の振り分けを sink へ移す（`sink.accept`）ことはしないと決めている（#1426）。

## frame の種類を足すときは、`ViewerFrame` の union と `END_FRAMES` の 1 行だけを書く

`Viewers` が持つ口は `forSession`・`connect`・`drained` の 3 つだけになった（[#1453](https://github.com/daiki-beppu/live-mindmap/issues/1453)・[#1454](https://github.com/daiki-beppu/live-mindmap/issues/1454)）。前は種類ごとの送りのメソッドが 9 個あり、それぞれが「後からつないだ画面のために残すか」の規則を持っていた。種類を 1 つ足すには、メソッド・`Retained` の項目・`NOTHING_RETAINED`・`retainedFrames`・終わりの解除を、別々の場所でそろえる必要があった。

今は `END_FRAMES` が、frame の `type` をキーにした mapped type になっている。値は、セッションの終わりに送る解除の frame か `"keep"`（`snapshot`・`speaker-names`）のどちらか。union に種類を足して表の行を書かなければ、`pnpm typecheck` が落ちる。#1453 の run は、union に試しの種類を 1 つ足して `TS2741` で落ちることを確かめてから戻した。ソースの文字列を固定するテストは作っていない。

後からつないだクライアントに保持値を送る順は、`END_FRAMES` のキーの順になる。行を足す位置で、つないだ直後に届く順が決まる。

## 解除の frame は、その口で送った種類にだけ届く。「終わったら必ず X が届く」と前提にしない

`forSession` の口は、送った種類を `Ref` の集合に覚える。Scope が閉じると、そのうち `"keep"` でない種類の解除の frame を表の順に送る。何も送っていない口が閉じても、何も届かない。開始に失敗したセッションが `session-mode` や空のマップを出さないのは、この規則による。

前の `closeSession` は、intake の `none` を無条件に送っていた。それを前提にしたテストは、口へ送った種類だけを解除する形に変えると落ちる。#1454 の run では、`http.it.test` の許可された Origin のテストが、intake を一度も送らないまま `intake: none` を待っていて落ちた。`appleState.it.test` も、消した `openLogged` の finalizer が送っていた `diff-update: null` を待っていた。どちらも、製品に無条件の解除を戻さず、テストの期待を外した。

`forSession` は、取るだけでは何も送らない。開いた直後に空の名前の表を送る処理を `openLogged` に置いているのも、この性質を保つためだ。口を取る時に送ると、開始に失敗したときに前の地図の名前まで消してしまう。

## 解除が走る順は、`forSession` を取る位置で決まる。Scope を作った直後に取る

解除は Scope の finalizer として送られ、finalizer は登録の逆順に走る。括弧は `Scope.fork` の直後に `forSession` を取るので、解除はいちばん最後に走る。ヘルパーと updater の後始末、最後の差分更新の後に届く。前の `closeSession` が手で解除していた時点と同じになる。

`cli play` では、`viewers.drained` の finalizer を登録した後、`recordPlayback` より前に `forSession` を取る（`server/src/cli.ts` の `play`）。閉じる順は、ログを書くセッションの後始末 → 表示の解除 → `drained` になる。新しい呼び出し側で口を取るときも、後始末より先に、`drained` より後に取る。

## 解除の frame も「最後の 1 件」として残る。終わった後につないだ画面には解除が届く

残し方はどの種類も同じで、最後に送った 1 件を残す。解除の frame もその 1 件に入る。前は、captions・screen-notice・tap-notice・self-pause の解除の frame を受けると、残していた値を消していた。web の `applyOpen` が、つないだときに表示を初期値へ戻すので、画面の振る舞いは変わらない。

それでも、終わった後につないだクライアントが受け取る frame の列は変わる。#1453 では、`sessions.test` の 6 件の期待が空の列から `[null]` や `[false]` に変わった。その 3 件は、次の #1454 で `ws.test` の表のテストに寄せて消した。frame ごとの解除を `sessions.test` で見るテストは足さない。種類ごとの解除は `ws.test` の `it.effect.each` 1 本で見る。`sessions.test` には、stop の後につないだクライアントに解除が届くことを見る配線の 1 本だけを残す。

## `Viewers` の偽の socket で「何も届かない」を確かめるときは、`Queue.takeAll` で待たない

Effect 4 の `Queue.takeAll` は、キューが空だと 1 件届くまで待つ。#1453 の run では、「届かない」を確かめる 5 件（keep の 2 種類、何も送らない口、前の口の履歴を引き継がない、finalizer の順）が、20 秒のタイムアウトで落ちた。最小を 0 にした `Queue.takeBetween` も試したが、届いていても空の配列が返り、届いたかどうかを見分けられなかった。

`ws.test` の `receivedFrames` は、`Queue.size` で今の件数を取り、その数だけ `Queue.takeN` で読む。届いていないことを確かめるときは、この関数を使うか、`Queue.size` が 0 であることを見る。待ち時間を延ばしても直らない。

## starting・stopping のセッションは、偽の launch と flush を `Deferred` で止めて作る

門番の表のテストは、状態の `Ref` に値を入れず、公開の操作で状態を作る。starting は、偽の `Helpers` の `launch` に着いた知らせを `Deferred` で受け、`connectGate` で起動を止めたまま操作を呼ぶ。stopping は、偽の sink の `flush` に着いたところで止めたまま操作を呼ぶ。同じ `Sessions` の上で「launch 待ち → live → flush 待ち → idle」と進めるので、決まった秒数の sleep は要らない。recorded で通す操作は、成功したことに加えて、`liveSession` の戻り値と `nameSpeaker` に渡った引数も確かめる。

振る舞いを変えない作り替えでは、テストは実装の前から通る。#1452 の括弧の失敗のテスト（`$kind の $failure 失敗で準備資源を閉じ、modeを送らず、同じサーバーで再開始できる`）がそうだった。サーバーの Scope が閉じたおかげで通っているのではないことは、次の 3 点で見ている。失敗の直後に準備の資源が `opened: 1, closed: 1` になっている。`session-mode` を受けた列が `[]` のまま。同じ `Sessions` で開き直すと `opened: 2, closed: 1` になる。

## `Viewers` と sink の口を変えたら、heavy の fixture と web のテストも呼び出し側として探す

#1454 で、sink に渡す口が `publish`・`speak`・`speakerNames`・`diffUpdate` の 4 本から `send` 1 本になった。このとき直す範囲は light のテストだけではなかった。heavy の `localModeView.heavy.test.ts` と fixture の `test/fixtures/appleLiveServer.ts` も `args.speak` を使っていて、`args.send` に移した。run は `pnpm --filter @live-mindmap/server test:it:heavy test/localModeView.heavy.test.ts` で、その 1 ファイルを流して確かめた。

web の `web/test/liveFeedWire.test.ts` は、server の `Viewers.layer` を直に使い、送った frame が web の decoder を通ることを見ている。#1454 の run の最中に、このテストを含む [PR #1505](https://github.com/daiki-beppu/live-mindmap/pull/1505)（スナップショットの frame に `type: "snapshot"` を足す変更）が main に入った。run の計画には入っておらず、`viewers.publish` から `forSession` への書き換えは main を取り込んだときに足された。`Viewers` の口を変えるときは、`rg "Viewers" server web` で両方の側の呼び出しを探す。

## 出典

- 仕様 [#1436](https://github.com/daiki-beppu/live-mindmap/issues/1436)（Formal Spec のコメントを含む）、親 [#1450](https://github.com/daiki-beppu/live-mindmap/issues/1450)
- チケット [#1451](https://github.com/daiki-beppu/live-mindmap/issues/1451)・[PR #1461](https://github.com/daiki-beppu/live-mindmap/pull/1461)、[#1452](https://github.com/daiki-beppu/live-mindmap/issues/1452)・[PR #1465](https://github.com/daiki-beppu/live-mindmap/pull/1465)、[#1453](https://github.com/daiki-beppu/live-mindmap/issues/1453)・[PR #1495](https://github.com/daiki-beppu/live-mindmap/pull/1495)、[#1454](https://github.com/daiki-beppu/live-mindmap/issues/1454)・[PR #1507](https://github.com/daiki-beppu/live-mindmap/pull/1507)
- takt の run: `20261024-044654-issue-1451-sessions-no-no-wo-1-c3mkub`、`20261024-062211-issue-1452-raibuto-karanosessh-vmobcg`、`20261024-085250-issue-1453-viewers-ni-sesshonn-km6w3y`、`20261024-110450-issue-1454-sesshonto-cli-play-lrmuz3` の計画・テストの報告・実装の報告・決定ログ・レビュー
- [PR #1505](https://github.com/daiki-beppu/live-mindmap/pull/1505)（`web/test/liveFeedWire.test.ts` の出どころ）
