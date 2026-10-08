# 各テストファイルが使う本物の資源と所要時間（issue #460）

map #459（テストの層を決める）の材料。server・web の vitest と helper の Swift テストについて、ファイル（Swift はスイート）ごとに、本物の資源を使うかと所要時間を並べる。

## 測り方

- 対象のコミット: `86d5da2`（main）。
- 機械: Apple M4（10 コア）・メモリ 16 GB・macOS 27.0.1、Node v26.9.0、vitest 5.0.3、Apple Swift 6.4（Command Line Tools）。手元の Mac で各スイートを 1 回ずつ流した。CI（ubuntu / macOS のランナー）ではもっと遅い（`server/vitest.config.ts` の `testTimeout: 20_000` のコメント）。
- server: `cd server && pnpm exec vitest run --reporter=json --outputFile=…`。1099 件すべて成功。**全体の実時間 59.6 秒**（user 169 秒 / sys 37 秒。ファイルは並列に走る）。
- web: 同じ手順。932 件すべて成功。**全体の実時間 2.7 秒**。
- helper: `bash helper/scripts/build-webrtc-apm.sh`（新しい worktree なので初回のビルド。実時間 71.9 秒）の後、`cd helper && pnpm test` を 2 回（1 回目はビルド込み、2 回目はビルド済み）。
- 表の「時間」は vitest の JSON の、ファイルの `endTime - startTime`（ファイル内のテストの実行時間。ファイルの import・収集の時間は含まない）。Swift はスイートごとの経過時間（swift-testing の出力）。
- 資源の判定はテストのコードを読んで決めた（`mkdtemp`/`tmpdir`、`child_process`/`effect/process` の本物の spawner、`listen`/`fetch`/`WebSocket`、`playwright`/`vite`、`vi.mock` と偽の Layer）。

資源の略号:

| 略号 | 意味 |
| --- | --- |
| FS書 | 本物の filesystem に書く（一時ディレクトリを作る） |
| FS読 | リポジトリのファイルを読むだけ（書かない） |
| 子 | 本物の子プロセスを起動する（`node`・`sips`・偽のヘルパー `test/fixtures/fake-helper.ts` など） |
| 網 | localhost で待ち受ける・つなぐ（HTTP・WebSocket・生の TCP） |
| Cr | Chromium（Playwright）を起動する |
| Vite | Vite のサーバーまたはビルドを本物で動かす |
| なし | 上のどれも使わない（偽の Layer・TestClock・`vi.mock`・メモリの中だけ） |

## server（vitest、45 ファイル・1099 件・実時間 59.6 秒）

遅い順。

| ファイル | 件数 | 時間 | 資源 | 内訳・メモ |
| --- | ---: | ---: | --- | --- |
| `cliProcess.test.ts` | 45 | 54.2 秒 | 子・FS書 | 全件が `execFile(process.execPath, [src/cli.ts, …])` で CLI を別プロセスとして起動（1 件 0.8〜3.3 秒。Node の起動と import が大半）。`apps` の接続失敗は localhost の閉じたポートへつなぐ。server 全体の実時間をこのファイルが決めている |
| `http.test.ts` | 49 | 26.1 秒 | 網・FS書・（一部）子 | 全件が本物の HTTP サーバー（`startup`）を `port: 0` で立て、`fetch`／`ws` でつなぐ。2 種類の準備がある。① `resource()`: 本物の Helpers の Layer で、`start` すると偽のヘルパー（`node fake-helper.ts`）を子プロセスで起動する。「HTTP 本文の検証」17 件（14.4 秒、1 件 0.65〜1.1 秒）、「HTTP の失敗応答」6 件、「Origin 制限」12 件（9.1 秒。うち close フレームに応答しない接続の 1 件が 3.0 秒）、「処理中の保護」1 件が使う。② `resourceWithFakeHelpers()`: 偽の Helpers の Layer（子プロセスなし、HTTP は本物）。「失敗応答」の resume 2 件、「新しい入口」10 件（計 0.19 秒）、「共有画面」1 件。子プロセスを起動するのは、`start` まで進む ① のテストだけ（404・409 だけ見るテストは起動しない） |
| `server.test.ts` | 6 | 19.8 秒 | 子・網・FS書 | 全 6 件が偽のヘルパーの子プロセス・本物の HTTP・`/ws` を通す契約（ファイル冒頭のコメントのとおり、それ以外は `sessions.test.ts` などに移済み）。うち「SIGTERM を無視するヘルパーを 5 秒後に SIGKILL」が 12.8 秒（実時間で 5 秒を 2 回待つ）、疎通が 3.4 秒、残り 4 件は 0.5〜1.6 秒。CI ではこのファイルだけ 4 ジョブに割っている |
| `capture.test.ts` | 7 | 16.4 秒 | Cr・Vite・網・FS書 | 全 7 件が `MapCapture.layer`（本物）で、撮影のたびに Vite の開発サーバーと Chromium を起動する（1 件 1.5〜3.5 秒）。CI では別ジョブ（`server (capture)`） |
| `benchProcess.test.ts` | 10 | 12.4 秒 | 子・FS書 | 全件が `execFile(node, bench/*.ts)`（1 件 0.8〜1.8 秒） |
| `serverMain.test.ts` | 3 | 9.6 秒 | 子・網・FS書 | 全件が `spawn(node, src/server.ts)` で本物のサーバーを起動し、`fetch`・`WebSocket` でつないでからシグナルを送る（1 件 2.6〜4.0 秒） |
| `reviewBuild.test.ts` | 1 | 2.2 秒 | Vite・Cr・FS書 | 本物の `ReviewBuild.layer`（Vite の single-file ビルド）で map.html を書き、Chromium で `file://` で開く。CI では `capture` と同じ別ジョブ |
| `eval.test.ts` | 89 | 2.1 秒 | FS書 | `play` を流してランのフォルダを作り（`mkdtemp`）、`eval` で読む。`claude.ts` と `openListener` は `vi.mock`（網なし）。`bench の正解ファイル` 4 件はリポジトリのファイルを読むだけ |
| `cli.test.ts` | 52 | 1.7 秒 | FS書・（1 件）網 | `runCli` を同じプロセスで呼ぶ。全件が `mkdtemp` の保存先と `NodeServices.layer`（本物の FS）を使う。`claude.ts` は `vi.mock`、配信の待受け `openListener` は偽物（`fakeListener`）、撮影・ビルド・mix・JPEG 変換は偽の Layer。**「ブラウザへの配信」の 1 件（L957「反映のたびに…WebSocket で届く」、0.18 秒）だけ**本物の `openListener` に戻し、localhost の WebSocket でつなぐ |
| `audioMix.test.ts` | 5 | 1.5 秒 | 子・FS書 | 「AudioMix の実物の Layer」4 件は本物の spawner で `node fake-helper.ts mix` を起動。「AudioMix.unavailable」1 件は資源なし |
| `sttReplayCommand.test.ts` | 13 | 1.3 秒 | FS書 | bench の Command を同じプロセスで。`claude.ts` は `vi.mock`。最初の 1 件の 1.1 秒はほぼ import の時間 |
| `playScreen.test.ts` | 13 | 1.2 秒 | FS書 | `play --screen`。`AgentSdk` の query と `openListener` が偽物 |
| `screenJpeg.test.ts` | 5 | 1.1 秒 | 子・FS書 | 本物の `ScreenJpeg.layer` が macOS の `sips` を子プロセスで呼ぶ。`darwin` 以外では skip |
| `sessions.test.ts` | 70 | 0.96 秒 | なし | 偽の Helpers・SessionSinks の Layer と TestClock |
| `playSession.test.ts` | 18 | 0.74 秒 | FS書 | `play <セッションのフォルダ>`。`claude.ts` と `openListener` が偽物 |
| `sessionSinks.test.ts` | 33 | 0.60 秒 | FS書 | SessionSinks の実物 Layer を一時ディレクトリと偽の updater・撮影で |
| `helpers.test.ts` | 4 | 0.52 秒 | 網 | 子プロセスは偽の spawner だが、偽の起動が `net.createServer` で localhost に待ち受け、Helpers が本物の TCP でつなぐ |
| `claude.test.ts` | 114 | 0.50 秒 | なし | Agent SDK の query は偽物 |
| `session.test.ts` | 108 | 0.44 秒 | なし | TestClock・偽の Layer |
| `recordedSessionScreens.test.ts` | 4 | 0.38 秒 | FS書 | |
| `restore.test.ts` | 45 | 0.31 秒 | FS読 | 「今の形式の log.jsonl（fixtures）からの復元」が `fixtures/session.log.jsonl` を読む。ほかは資源なし |
| `cliEffect.test.ts` | 11 | 0.29 秒 | FS書 | `fetch` は `vi.spyOn` で偽物、`openListener` も偽物（網なし） |
| `benchCommand.test.ts` | 17 | 0.23 秒 | FS書 | 入力ファイルを一時ディレクトリに書いて Command に渡す |
| `review.test.ts` | 23 | 0.23 秒 | FS書 | `NodeFileSystem.layer`。ビルドは偽物 |
| `sttAccuracy.test.ts` | 9 | 0.22 秒 | FS書 | 「sttAccuracy の Command」2 件だけファイルを書く。残り 7 件（正規化・突き合わせ・採点）は資源なし |
| `ws.test.ts` | 12 | 0.21 秒 | なし | Socket は偽物 |
| `speakingRelay.test.ts` | 10 | 0.11 秒 | FS書 | 「仮の文字…消える範囲」5 件が `mkdtemp` の保存先でセッションを開く。「途中結果の間引き」5 件は資源なし |
| `helperSocket.test.ts` | 3 | 0.11 秒 | 網 | `net.createServer` の生の TCP サーバーに WebSocket でつなぐ |
| `remarkSettling.test.ts` | 9 | 0.11 秒 | なし | |
| `sessionScreen.test.ts` | 31 | 0.11 秒 | なし | |
| `truthFile.test.ts` | 17 | 0.10 秒 | FS書 | 正解ファイルを一時ディレクトリに書いて読む |
| `live.test.ts` | 34 | 0.06 秒 | なし | |
| `coreSchema.test.ts` | 29 | 0.06 秒 | FS読 | `helper/README.md` と bench の正解ファイルを読む |
| `captureLifecycle.test.ts` | 7 | 0.06 秒 | FS書 | `vite`・`playwright` は `vi.mock`。`mkdtemp` だけ本物 |
| `export.test.ts` | 12 | 0.06 秒 | なし | |
| `playback.test.ts` | 19 | 0.06 秒 | なし | |
| `entrypoints.test.ts` | 3 | 0.06 秒 | FS読 | `src`・`bench` のソースを読んで呼び出しを数える |
| `sttLatency.test.ts` | 29 | 0.05 秒 | なし | |
| `settle.test.ts` | 51 | 0.03 秒 | なし | |
| `sessionStats.test.ts` | 6 | 0.03 秒 | FS書 | 「並べたフォルダを渡すと…」1 件だけ `mkdtempSync` でフォルダを作る。残り 5 件は文字列を数えるだけ（資源なし） |
| `changes.test.ts` | 26 | 0.02 秒 | なし | |
| `intake.test.ts` | 30 | 0.02 秒 | なし | |
| `diffUpdater.test.ts` | 1 | 0.02 秒 | なし | `claude.ts` を `vi.mock` |
| `logMetrics.test.ts` | 13 | 0.01 秒 | なし | |
| `helperPath.test.ts` | 3 | 0.00 秒 | なし | 名前に fake-helper が出るが文字列だけ |

（`test/benchRun.ts`・`test/fakeListener.ts`・`test/fixtures/*` は補助。`fixtures/fake-helper.ts` は子プロセスとして起動される偽のヘルパーで、`ws` で WebSocket サーバーを立てる。）

## web（vitest、34 ファイル・932 件・実時間 2.7 秒）

DOM の環境（jsdom など）は使っていない。コンポーネントは `react-dom/server` の `renderToStaticMarkup` で文字列に描き、hook は `vi.mock("react")` の代役で動かす。

| ファイル | 件数 | 時間 | 資源 | メモ |
| --- | ---: | ---: | --- | --- |
| `SessionView.test.tsx` | 33 | 0.44 秒 | なし | `renderToStaticMarkup`。`MapView`・`useIntakeNotice` は `vi.mock` |
| `useLiveFeed.test.ts` | 2 | 0.09 秒 | なし | `react` と `WebSocket` を代役にする（網なし） |
| `ReviewControls.test.tsx` | 25 | 0.07 秒 | なし | |
| `viewing.test.ts` | 325 | 0.06 秒 | なし | |
| `styles.test.ts` | 17 | 0.01 秒 | FS読 | `src/styles.css` を読む |
| 残り 29 ファイル | 530 | 各 0.04 秒以下 | なし | `reviewTimeline`・`MapNode`・`SessionViewEnter`・`ChangeList`・`folding`・`EvidencePanel`・`reviewKeys`・`camera`・`KeyList`・`reviewPlayback`・`SessionViewPointChange`・`relocation`・`imeKey`・`App`・`motion`・`ViewingNotice`・`evidence`・`ScreenNotice`・`intakeNoticeStore`・`liveFeed`・`layout`・`useImeKeyRedispatch`・`kinds`・`changes`・`captions`・`intake`・`Captions`・`IntakeNotice`・`enterFold` |

web は全ファイルが unit 相当で、層を分ける必要はない。

## helper（Swift、2 ターゲット・52 スイート（struct）・全体の実行で 319 件）

### 全体の時間

| 回 | 実時間 | 内訳 |
| --- | ---: | --- |
| `build-webrtc-apm.sh`（新しい worktree での初回） | 71.9 秒 | `uv` で入れた meson・ninja で WebRTC AEC3 の静的ライブラリをビルド。2 回目以降は何もしない |
| `pnpm test` 1 回目（ビルド込み） | 142.0 秒 | `swift build` 73.2 秒 + テスト 51.8 秒（スイートは並列） |
| `pnpm test` 2 回目（ソースは変えていない） | 199.9 秒 | `Build complete!` まで 101.9 秒（変更なしでもビルドの手順が走った）+ テスト 75.9 秒 |

`pnpm test` は毎回 `swift test`（ビルドから）を走らせる。テストの部分は、AEC3 の 2 スイートが CPU を占めるあいだ他のスイートも待たされ、並列の出力ではどのスイートも 7〜20 秒に見える。そのため下の表の「単独の時間」は、ビルド済みの状態で `swift test --skip-build --filter <ターゲット>.<スイート>/` をスイートごとに流した値（swift-testing の `Test run … after N seconds`）。プロセスの起動に別に 1〜1.5 秒かかる。件数も単独の実行が数えた値で、足すと 349 件になり、全体の実行の 319 件と合わない（数え方の違いと見られ、ここでは追っていない）。

### スイートごと（単独で流したときの時間の長い順）

| ファイル | スイート（struct） | 件数 | 単独の時間 | 資源 | メモ |
| --- | --- | ---: | ---: | --- | --- |
| `EchoCancellerTests.swift` | `EchoCancellerStartupTests`（エコーキャンセルの開始直後） | 3 | 60.8 秒 | AEC3 | 本物の WebRTC AEC3（`WebRTCEchoCanceller`、`helper/.deps` の静的ライブラリ）に合成音声を数十秒分通す。プロセス内の計算だけだが重い |
| `EchoBenchTests.swift` | `WindowResultsTests`（エコー計測: 出力の遅れと残り方の数字） | 6 | 17.3 秒 | なし | 偽の canceller（`DelayingCanceller` など）だが、長い合成信号の相関を計算するので CPU で重い |
| `EchoCancellerTests.swift` | `EchoCancellerTests`（実際の WebRTC AEC3） | 1 | 10.7 秒 | AEC3 | 同上 |
| `WebSocketServerTests.swift` | `WebSocketServerTests`（localhost の WebSocket） | 11 | 0.1 秒（1 回だけ 5.4 秒で失敗） | 網 | 本物の `WebSocketServer(port: 0)` に `URLSession` でつなぐ。単独で 4 回流したうち 1 回、「切断したクライアントは一覧から外れる」が 5 秒の待ち（`waitForClients`）を超えて失敗した。全体の 2 回は成功。時間に頼るテストで揺れる |
| `SilenceFilteringTests.swift` | `SilenceFilteringTests` | 19 | 3.4 秒 | なし | 偽の Transcriber。音声のバッファを作る計算 |
| `ScreenChangeTests.swift` | `ScreenBrowserTabTests` | 7 | 2.8 秒 | なし | 合成画像の判定（ScreenCaptureKit は呼ばない） |
| 〃 | `ScreenMotionExclusionTests` | 8 | 2.4 秒 | なし | 〃 |
| 〃 | `ScreenSpeakerFrameTests` | 6 | 1.7 秒 | なし | 〃 |
| 〃 | `ScreenChangeDetectorTests` | 14 | 1.4 秒 | なし | 〃 |
| `MixTests.swift` | `MixTests`（録音の混合） | 17 | 1.2 秒 | FS書 | 一時ディレクトリに m4a を `AVAudioFile` で書き、混合した結果を読み戻す |
| `DuplicateRelayTests.swift` | `DuplicateRelayTests`（重複の印を付ける転送） | 30 | 0.7 秒 | 網 | 全件が本物の `WebSocketServer(port: 0)` と `URLSession` の WebSocket で受け取る |
| `EchoBenchTests.swift` | `EchoCandidateTests` | 5 | 0.6 秒 | FS書（一部） | wav を書く 1 件（L186）が一時ファイルを使う。ほかは計算だけ |
| `RelayTests.swift` | `MultiTrackRelayTests` | 4 | 0.4 秒 | 網 | `WebSocketServer` と `URLSession` |
| `RecognizeTests.swift` | `RecognizeTests` | 2 | 0.4 秒 | FS書 | 一時ファイルに wav を書き、偽の Transcriber で流す |
| `EchoCancellationStreamTests.swift` | `EchoCancellationStreamTests` | 5 | 0.3 秒 | なし | 記録するだけの偽の canceller |
| `SpeechAnalyzerTranscriberTests.swift` | `SpeechAnalyzerTranscriberTests` | 1 | 0.2 秒 | 音声認識 | 本物の SpeechAnalyzer（ja-JP のモデル）。`CI` の環境変数があると `.disabled` |
| `StreamSplitTests.swift` | `StreamSplitTests` | 5 | 0.2 秒 | なし | |
| `ScreenChangeTests.swift` | `ScreenEventEmitterTests` | 15 | 0.2 秒 | なし | |
| 〃 | `ScreenEventTests` | 5 | 0.1 秒 | なし | |
| `RecordingTests.swift` | `RecordingTests`（録音） | 8 | 0.1 秒 | FS書 | 一時ディレクトリに m4a を書いて読む |
| `RelayTests.swift` | `RelayTests` | 1 | 0.07 秒 | 網 | |
| `ScreenChangeTests.swift` | `ScreenStartTimeTests` | 3 | 0.05 秒 | なし | |
| `RecordingTests.swift` | `RecordingStreamTests`（録音のラッパー） | 7 | 0.03 秒 | FS書 | |
| `FinalizeStepTests.swift` | `FinalizeStepTests` | 2 | 0.02 秒 | なし | 偽の finalize |
| `EchoAlignmentTests.swift` | `EchoAlignmentTests` | 10 | 0.01 秒 | なし | 記録するだけの偽の canceller |
| `ScreenChangeTests.swift` | `ScreenWindowGoneTests` | 4 | 0.01 秒 | なし | |
| 残り 26 スイート | `CoverageTests`・`IsDuplicateTests`・`IsDuplicatePartialTests`・`EventsTests`・`ExitCodeTests`・`MeetingAppListTests`・`TapTargetTests`・`MicrophoneCaptureTests`・`MicrophoneConfigurationChangeTests`・`MixArgumentsTests`・`OutputRouteTests`・`ProcessTapTests`・`RecordingFileNameTests`・`RunArgumentsTests`・`ScreenThresholdTests`・`ScreenShowsMeetingTests`・`ScreenFrameToJudgeTests`・`ScreenWindowSelectionTests`・`ScreenWindowSearchTests`・`ScreenFitSizeTests`・`ScreenCapturePlanTests`・`TimelineTests`・`BuildMicrophoneTests`・`RunCancellerTests`・`SynthTimelineTests`・`MixTests`（SttBench、音声の重ね合わせ） | 150 | 各 0.005 秒以下 | なし | マイク・プロセスタップは start 前の stop と通知の差し替えだけで、本物の機器に触れない |

資源の略号のうち helper だけのもの: **AEC3** は本物の WebRTC AEC3 の静的ライブラリをプロセス内で動かす（`build-webrtc-apm.sh` が要る）。**音声認識** は OS の SpeechAnalyzer と ja-JP のモデル。どのスイートも子プロセスは起動しない。どのテストを流すにも `swift build`（初回 73 秒前後）と AEC3 のライブラリが要る。

## まとめ

### 遅いもの

1. server: `cliProcess.test.ts` 54.2 秒（45 件すべてが node の子プロセス）。server 全体（59.6 秒）の実時間をほぼこれ 1 つで決めている。
2. helper: `EchoCancellerStartupTests` 60.8 秒と `EchoCancellerTests` 10.7 秒（本物の AEC3）、`WindowResultsTests` 17.3 秒（偽物だが計算が重い）。加えて `pnpm test` は毎回 `swift build` を走らせ、手元で 73〜102 秒かかった。
3. server: `http.test.ts` 26.1 秒、`server.test.ts` 19.8 秒（うち SIGKILL の 1 件が 12.8 秒）、`capture.test.ts` 16.4 秒（Vite + Chromium）、`benchProcess.test.ts` 12.4 秒、`serverMain.test.ts` 9.6 秒。
4. 上の 6 ファイルを除いた server の残り 39 ファイルは、各ファイルの時間を足しても 17.7 秒（大半は 1 秒未満）。web は全体で 2.7 秒。

### 1 つのファイルに層が混ざっているもの

| ファイル | 混ざり方 |
| --- | --- |
| `server/test/http.test.ts` | 全件が本物の HTTP。そのうち `resource()` を使う 36 件は本物の Helpers の Layer（`start` で偽のヘルパーの子プロセス）、`resourceWithFakeHelpers()` を使う 13 件は偽の Helpers（子プロセスなし、計 0.2 秒）。「HTTP の失敗応答」の describe の中でも両方が混ざる |
| `server/test/cli.test.ts` | 51 件は同じプロセス・一時ディレクトリ・偽の待受け。「ブラウザへの配信」の 1 件だけ本物の `openListener` と localhost の WebSocket |
| `server/test/audioMix.test.ts` | 実物の Layer の 4 件は子プロセス、`AudioMix.unavailable` の 1 件は資源なし |
| `server/test/speakingRelay.test.ts` | 「途中結果の間引き」5 件は資源なし、「仮の文字…消える範囲」5 件は一時ディレクトリ |
| `server/test/sttAccuracy.test.ts`・`sessionStats.test.ts` | 計算の unit と、ファイルを書く Command・フォルダ走査の数件 |
| `server/test/restore.test.ts`・`eval.test.ts` | ほぼ全件と、リポジトリのファイル（fixtures・bench の正解）を読むだけの数件 |
| `helper/Tests/SttBenchTests/EchoBenchTests.swift` | 4 スイートのうち `WindowResultsTests` だけ重く、`EchoCandidateTests` の 1 件が一時ファイル |
| `helper/Tests/HelperCoreTests/RecordingTests.swift` | `RecordingTests`・`RecordingStreamTests` は一時ディレクトリに書き、`RecordingFileNameTests` は資源なし |

`server/test/server.test.ts` は、ファイル冒頭のコメントのとおり Issue #240 で本物の子プロセス・HTTP・WebSocket を通す 6 件だけに絞ってあり、unit は混ざっていない（偽の Layer で確かめられる振る舞いは `sessions.test.ts`・`sessionSinks.test.ts`・`http.test.ts` に移済み）。

### 気づいたこと

- server の重い IT（子プロセス・Chromium）は 6 ファイルにまとまっている: `cliProcess`・`http`・`server`・`capture`・`benchProcess`・`serverMain`（＋数秒の `reviewBuild`）。子プロセスを使うがすぐ終わる `audioMix`（1.5 秒）・`screenJpeg`（1.1 秒、`sips`）もある。
- 一時ディレクトリを使う（軽い IT 相当の）server のファイルは 20 ほどあるが、どれも 2 秒以下。
- localhost の網だけを使い速いもの: server の `helpers.test.ts`（0.5 秒）・`helperSocket.test.ts`（0.1 秒）、helper の `DuplicateRelayTests`・`RelayTests`・`WebSocketServerTests`（1 秒未満）。ただし helper の `WebSocketServerTests` は 6 回中 1 回落ちた。
- web は全件が unit 相当（DOM も網も使わない）。
