---
name: verify-intake-attempts
description: 取り込みの再起動（server/src/intakeAttempts.ts の openIntake: launch・connect・serve・run のループ・finishAttempt・send・stop・reached・end）か、再起動の判断（server/src/core/intake.ts の decideIntakeRestart）を変えたとき、または変える前に、TLA+ のモデルを TLC にかけて、ヘルパーを同時に 2 つ動かさない・stop の後の起動を起動し直しと数えない・止まった表示は諦めたときだけ・一時停止の指示がつながったヘルパーに効いている・resume の待ちがいつか決まる・stop の後に end が返る、が成り立つか確かめる。ヘルパーが落ちて起動し直すまわりの順序の不具合（一時停止が効かない、resume が返らない、stop が終わらない）を調べるときにも使う。
---

# 取り込みの再起動を TLC で確かめる

`server/formal/IntakeAttempts.tla` は、`openIntake`（`server/src/intakeAttempts.ts`）がヘルパーの子プロセスを起動し、落ちたら起動し直し、止める要求で終えるまでのモデルです。モデルの 1 つの遷移は、コードの中で他の Fiber に割り込まれない 1 歩、つまり `Ref`・`SynchronizedRef`・`Deferred` の 1 回の操作か、非同期の境目までの同期の区間に当たります。`send` と `connect` はどちらも `SynchronizedRef.updateEffect` の中なので、それぞれ 1 歩です。`Deferred.isDone(stopRequested)` で見てから動くところ（:116・:124・:129・:132・:144）は、見る歩と動く歩の間に stop が入れます。遷移の条件の注釈に、対応する行を書いてあります。

モデルに入る外の者は、利用者（`stop`・`send`）、ヘルパーの子プロセス（落ちる・ソケットを閉じる・stop の後に kill される）、`sessions.ts` の `resume`（live だけ。表示が stopped のときに、前の run の `end` を待ってから次の run を始める）です。

## 守っている約束

| 性質 | 平易に言うと | 破れたときの害 |
|---|---|---|
| `InvOneHelperAtATime` | ヘルパーを同時に 2 つ動かさない | マイクと録音を取り合い、同じ音声から発言が二重に入る |
| `InvNotCountedAfterStop` | stop の要求の後に起動した試行を、起動し直した・running に着いたと数えない | 止めている最中に「起動し直しました」と出て、`restarts` と `intake-restarted` のログが実際とずれる。resume が止める途中で成功を返す |
| `InvStoppedOnlyWhenGaveUp` | 取り込みの表示が stopped になるのは、起動し直しを諦めて run が終わるときだけ | 止まったと表示しているのに次の起動が続き、resume が新しい run を重ねる |
| `InvSelfPauseFollowsUser`（live） | 自分の一時停止の最後の指示が、つながって読んでいるヘルパーに効いている | 押した一時停止・再開が、ヘルパーの起動し直しの後に効いていない |
| `InvReadingPauseFollowsUser`（recorded） | 読み上げの一時停止の最後の指示が、つながって読んでいるヘルパーに効いている | 録画の取り込みが、一時停止中なのに先へ進む |
| `PropReachedSettles`（live） | resume が待つ reached は、いつか決まる | `resume` が返らず、CLI の resume が待ち続ける |
| `PropEndAfterStop` | stop の後、`end` はいつか返る | stop が終わらず、セッションが閉じない |

今のコードでは `InvSelfPauseFollowsUser` と `PropReachedSettles` が破れます（末尾の「既知の発見」）。どちらも `server/formal/IntakeAttempts.checks` に `known` として載せてあり、`check.sh` は `KNOWN` と出して終了コードに数えません。直さずに残す不具合を新しく見つけたときは、その性質を `known` に足し、「既知の発見」に反例を書きます。

## 手順

1. **変更がモデルの範囲に触れるか見る。** 下の「範囲」の関数か、そこから呼ぶ `Ref`・`SynchronizedRef`・`Deferred` の操作の順番・条件を変えたら触れています。イベントの中身・`apply` の書き込み・ログの文言だけを変えたのなら触れていないので、ここで終えます。
2. **モデルをコードに合わせる。** 変わった歩を、モデルの対応する遷移に移します。`isDone(stopRequested)` のような見る歩が増えたら遷移を 1 つ分け、`SynchronizedRef` の中にまとめたら遷移を 1 つにします。`decideIntakeRestart` の分かれ道を変えたら `Finish` を直します。新しい条件や状態は、コードの名前のまま変数や条件に足します。注釈の行番号も直します。直さずに済むのは、操作の回数・順番・条件が変わっていない変更（名前の変更、ログの文言など）だけです。
3. **検査する。** repo のルートで `bash server/formal/check.sh --model IntakeAttempts` を流します。性質を絞るときは名前を並べます（例 `bash server/formal/check.sh --model IntakeAttempts InvOneHelperAtATime`）。1 回目は TLC（tla2tools.jar 1.7.4、SHA-256 を照合）を `server/formal/.tla/` に取ってきます。Java 11 以上が要ります。全体で 30 秒ほどかかります。出力の行は `pass`（成り立つ）・`FAIL`（新しく破れた）・`KNOWN`（既知の発見のとおり破れた）・`PASS?`（既知の発見が通るようになった）・`ERROR`（TLC が調べ切れない）のどれかです。終了コードは、`FAIL` が無ければ 0、あれば 1、`ERROR` があれば 2 です。
4. **結果を読む。** `FAIL`・`KNOWN` には、反例の手順（遷移の名前の列）と、全文のファイル `server/formal/.tla/traces/IntakeAttempts-<性質>-<構成>.txt` が付きます。反例と状態図は pstack の `/statechart` スキルで読みます。`/statechart` は、反例を平易な最短の手順に直し、変更がどの違反を直すかを示します。通ったときは、状態がどう移るかの図を描きます。`/statechart` が使えないときは全文のファイルを開き、`State N: <遷移の名前 line ...>` ごとに、`pc`・`cur`・`target`・`pending`・`helper` の各枠の `alive`・`sock`・`applied`、`stopRequested`・`reached`・`shown` が前の状態からどう変わったかを追います。`helper` は複数行にわたるので、行ごとの grep では切れます。そのうえで、次のどちらかを決めます。
   - **コードの不具合**: 反例の手順をコードの行で辿れて、各遷移が実際の 1 歩と合っている。性質もモデルも弱めずに、反例を手順で報告します。product のコードを直すのは、頼まれたときだけです。
   - **モデルの書き違い**: 反例の中に、コードでは 1 歩で起きることが 2 歩に分かれている遷移や、コードには無い条件がある。モデルを直して、手順 3 に戻ります。

   `PASS?` が出たら、変更が既知の発見を直しています。`IntakeAttempts.checks` の `known` からその性質を外し、「既知の発見」の節からその項を消します。
5. **性質が空振りしていないか確かめる**（性質を足した・変えたとき、または遷移や変数を足した・消したとき。既存の遷移の条件や代入を変えただけなら要りません）。その性質が守っている条件をモデルから 1 か所だけ外した版を scratchpad に作り、`bash server/formal/check.sh --model IntakeAttempts --spec <その版の .tla> <性質>` が `FAIL` になることを見ます。版のファイル名は `IntakeAttempts.tla` のままにします。例: `AwaitExit` から `~helper[cur].alive` を外すと `InvOneHelperAtATime` が、`Check` から `~stopRequested` を外すと `InvNotCountedAfterStop` が、`Send` の `pending'` から `Mode = "recorded" \/` を外すと `InvReadingPauseFollowsUser` が、`Return` の `aborted` を外すと `PropReachedSettles` が、`Spec` から `WF_vars(HelperKilled)`（stop の後の kill、`helpers.ts` の `Deferred.await(stopRequested)` の後の `stop`）を外すと `PropEndAfterStop` が破れます。`FAIL` にならない性質は書き直します。
6. **モデルの変更の行き先を決める。** 変更がそのまま入るなら、モデルの変更も同じ PR に入れます。そして、下の「最後に合わせた」記録をその PR の番号に書き換えます。書き換えてよいのは、モデルが変更後のコードをそのまま表していると、手順 2 で確かめ終えたときだけです。コードの不具合と判定して変更を入れないなら、モデルの変更も戻します。

## 範囲

最後に合わせた PR: #2011（2026-11-09）

この PR が main に入った後に次のファイルが変わっていたら、手順 2 から見直します。PR の squash コミットは件名の末尾に `(#2011)` が付くので、`git log "$(git log -1 --format=%H --grep='(#2011)$' origin/main)"..origin/main -- <ファイル>` で後の変更を出せます。

- `server/src/intakeAttempts.ts`: `openIntake` の中の `launch`・`connect`・`serve`・`run`（`finishAttempt`・`readConnected`・`readNext`・`body`）・返す `send`・`stop`
- `server/src/core/intake.ts`: `decideIntakeRestart`・`isConfigurationChangeExit`・`MAX_CONSECUTIVE_FAILURES`・`MAX_CONFIGURATION_CHANGES`・`RESTART_WINDOW_MS`・`CONFIGURATION_CHANGE_WINDOW_MS`
- `server/src/helpers.ts`: `launch` の中の、stop の要求で kill する Fiber と `raceFirst(connect, helperEnded)`
- `server/src/helperSocket.ts`: `send` が `OPEN` でないときに捨てるところ、`close` で events を終えるところ
- `server/src/sessions.ts`: `openIntake` に渡す `commands`（`self-pause` が `pending-once`、`reading-pause` が `sticky`）と `launchOptions`（`selfPause` に `selfPauseState` を渡す）、`runLive` の `observe` が `live.intake` を変えるところ、`resume` の条件と順番

## 調べている範囲と前提

- 構成は 2 つです（`server/formal/intake-live.cfg`・`intake-recorded.cfg`）。live は start の取り込み（`self-pause` が `pending-once`、終了コード 0 でも起動し直す、resume が 1 回まで）。recorded は録画の取り込み（`reading-pause` が `sticky`、終了コード 0 で終える、resume は無い）。
- 構成の変化での終了を諦める上限は 2 回（本物の `MAX_CONFIGURATION_CHANGES` は 10）、続けての失敗の上限は本物と同じ 3 回、利用者の send は 2 回までです。それを超える振る舞いは調べ切れていません。
- 時刻は入れていません。落ちるたびに、60 秒より長く動いたか（`ranLong`）と、窓に残る構成の変化の数を、どちらも自由に選び直します（実際より広く調べます）。
- ヘルパーは、届いた指示をすぐ当てて、その状態を `self-pause-state` で返すとしています。届いた後、返す前に落ちる場合は含めていません。
- 起動中のヘルパーは、いずれソケットを開くか終わるとしています（いつまでも開かずに生き続ける場合は含めていません）。
- 含めていないもの: イベントの中身と `apply`・`log` の書き込み（`SessionWriteFailed` で止める `tapError` を含む）、`stats` の数、`openIntake` の最初の起動の失敗（start が失敗するだけなので、最初の試行はつながった状態から始めます）、セッション側の状態（`Sessions` の idle・starting・live・stopping）。
- 通ったときに言えるのは、この範囲のモデルで成り立つということだけです。システム全体で成り立つとまでは言えません。

## 既知の発見

### `InvSelfPauseFollowsUser`: ヘルパーが落ちた直後の一時停止の指示が消える（live）

1. ヘルパーがつながって読んでいる（`link.target` がその試行）。
2. ヘルパーの子プロセスが落ちる。ソケットはまだ閉じていないか、閉じても events のストリームは残りのイベントを `apply` している最中で、`serve` の `ensuring` が `link.target` を外す前（intakeAttempts.ts:84・:85）。
3. 利用者が自分の一時停止を押す（`setSelfPause` → `controller.send`）。`target` があるので `pending` に残さず（:163、`pending-once` は target が無いときだけ残す）、死んだ試行に送る（:164）。`helperSocket.ts:46` は `OPEN` でなければ捨て、`OPEN` でも相手のプロセスはもういない。
4. `serve` が終わり、`finishAttempt` が起動し直しを決め（:110）、次の試行を起動する。`launchOptions` の `selfPause` は、落ちたヘルパーが最後に返した `selfPauseState`（sessions.ts:308）で、押した指示を含まない。
5. 次の試行がつながる（:115）。`pending` は空なので何も送らない。ヘルパーは一時停止していない。画面も一時停止に変わらないので、押した利用者は効かなかったことに気づけるが、押し直すまで自分の声が取り込まれ続ける。

recorded の `reading-pause` は `sticky` なので、同じ順でも `pending` に残り、つながり直しで再送されます（`InvReadingPauseFollowsUser` は通ります）。

### `PropReachedSettles`: 起動のたびに 60 秒より長くかかって失敗すると、resume が返らない（live）

1. 起動し直しを諦めて表示が stopped になる（:102〜:108）。
2. 利用者が resume する。`sessions.ts` の `resume` が新しい run を始め（sessions.ts:555）、`running.reached` を待つ（sessions.ts:557）。
3. 新しい試行を起動する（:130）。ヘルパーはソケットを開かないまま 60 秒より長く動いてから終わる。`launch` は `HelperLaunchFailure` で失敗し（helpers.ts:276）、`connectionFailed` になる（:133）。
4. `decideIntakeRestart` は `ranMs > RESTART_WINDOW_MS` なので `failures` を 0 に戻して起動し直しを決める（intake.ts:58）。
5. 3〜4 が続く限り、`reached` は running にも gaveUp にもならず、`resume` が返らない。表示は interrupted のまま。構成の変化での終了（終了コード 75）がソケットを開く前に 6 秒より間を空けて続く場合も、`failures` が増えないので（intake.ts:53）同じになります。

起動のたびに 60 秒より長くかかってから失敗するヘルパーという条件付きです。stop すれば `end` は返ります（`PropEndAfterStop` は通ります）。
