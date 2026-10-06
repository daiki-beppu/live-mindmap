# ヘルパーのライフサイクルは、stop を印で、サーバーの終了を Scope で止める

server を Effect 4 へ置き換える（[#193](https://github.com/daiki-beppu/live-mindmap/issues/193)）にあたって、ヘルパーのライフサイクル（起動、起動し直し #161、SIGTERM から 5 秒後の SIGKILL、stop、開始の失敗、サーバーの終了）を次の形で書く。ほかのモジュールを置き換えるときも、この形を手本にする。試作で 8 つの重なり方を確かめた（[#197](https://github.com/daiki-beppu/live-mindmap/issues/197)、ブランチ `prototype/effect4-helper-lifecycle`）。

- **Service は 3 つ**。外の世界（子プロセス、空きポート、ヘルパーへの WebSocket）を受け持つ `Helpers`、セッションの中身（updater、ログ、いま話している文字、書き出し）を開く `SessionSinks`、状態と start・stop・resume・status、起動し直しのループを持つ `Sessions`。テストでは `Helpers` と `SessionSinks` を偽物の Layer にして、TestClock で動かす
- **1 回分の起動は 1 つの Scope**。ヘルパーの停止は、その Scope の後始末にする
- **stop は中断しない**。stop は「止めて」の印（`Deferred`）を立てるだけにする。その回の起動の中で待っているファイバーがヘルパーを止め、ヘルパーが終われば接続待ち・読み取り・終了待ちがまとめてほどける。stop は起動し直しのループが終わるのを `Fiber.join` で待ち、close の前に届いた発言を読み終えてから書き出す
- **中断を使うのはサーバーの終了だけ**。セッションの Scope はサーバーの Scope の子にする。親を閉じれば、開始の途中でも起動し直しの最中でも、子プロセスと updater がまとめて片付く。今の `closing`・`controller.aborted`・`stillOwns` で確かめて回る作りをやめる
- 後始末は登録の逆順に走る。そのため、順番の要る停止（ヘルパーを止める → 読み終える → 書き出す）は本体に書き、後始末は中断されたときの安全網にする（ADR 0007 の `flush` と同じ考え方）
- **状態は `Ref` で持つ**。起動し直しのループだけが書く数（起動の回数、続けた失敗の数、起動し直した回数）も含める。取り込みの状態は resume と取り合うので、`Ref.modify` で確かめてから書き換える
- **子プロセスは `effect/process` の `ChildProcess`**。SIGTERM から 5 秒後の SIGKILL は `forceKillAfter` に任せる
- ヘルパーからのメッセージは、WebSocket をつないだのと同じ同期区間から `Queue` に流し、close で `Queue` を終える（`helperSocket.ts` の early バッファをやめる）
- 失敗は `Schema.TaggedError` で表す（`HelperExited`、`SessionBusy`、`NoSession`、`IntakeNotStopped`、`RestartGaveUp`、`Aborted` など）。HTTP のステータスへの対応は、境界の 1 か所に置く

## Considered Options

- **stop も中断で止める**: 中断が 1 種類で済む。ただし後始末は逆順に走るので、発言を落とさないには、ヘルパーの後始末の中で「止める → Queue を読み切る」まで行うことになり、発言を読む処理が後始末に入る
- **起動し直しのループを別の Service にする**: ループだけを単体で試せる。ただし Service が増え、今の段階で単体で試す理由が無い
- **`node:child_process` を自分で包む**: 安定した API だけで済み、依存も増えない。SIGKILL までを TestClock で試せる
- **起動は `effect/process`、止め方は本体に書く**: SIGKILL を送ったかどうかがわかり、TestClock で試せる。ただし `effect/process` に任せられる止め方を自分で書き直すことになる
- **ループだけが書く数は普通のフィールドにする**: 書くのは同時に 1 本のループだけで競合しないが、Effect の作法からはずれる

## Consequences

- `@stability unstable` の `effect/process` を使う。`effect` と `@effect/*` は exact pin にし、上げるときは `effect/process` の変更を確かめる
- `@effect/platform-node` に依存する（`NodeChildProcessSpawner` が FileSystem と Path の Layer を要る）。止めるときは、ヘルパーのプロセスグループごと止める
- `forceKillAfter` の 5 秒は Node のタイマーで測る。そのため SIGKILL までのテストは、本物の時間で 5 秒待つ。TestClock で試すのは、起動し直しの判断（60 秒）や接続の再試行など、Effect の時計で待つところ
- `kill` は SIGKILL まで送ったかどうかを返さない。シグナルで終わったときの `exitCode` も、文面にシグナルを埋め込んだ `PlatformError` で失敗する。今の「録音が不完全かもしれない」という警告の条件は、終わり方から読み取る。どう読み取るかは仕様で決める
