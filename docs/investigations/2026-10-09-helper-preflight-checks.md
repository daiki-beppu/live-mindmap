# ヘルパーが開始前に確かめられること（Issue #622）

地図 #619 の「開始前に確かめるだけのもの」（SpeechAnalyzer の日本語モデル・ヘルパーのビルド・画面収録とマイクの許可）を、どの API で、ダイアログを出さずに、どこまで確かめられるかを一次資料（Apple の API リファレンスと SDK のヘッダ・swiftinterface、このリポジトリのコード）と、この Mac での小さな実測で調べた。結論は次のとおり。

- **日本語モデル**: ダイアログを出さずに確かめられる。`AssetInventory.status(forModules:)` が `installed` / `supported`（取りに行く必要がある）/ `downloading` / `unsupported` を返す。ただし **この値はアプリ（コード署名の識別子）ごとの予約に紐づく**。端末に入っているかは `SpeechTranscriber.installedLocales` で別に分かる。**容量（ダウンロードの大きさ）を事前に知る公開 API は無い**。
- **画面収録**: `CGPreflightScreenCaptureAccess()` で、ダイアログを出さずにいまの状態（あり / なし）だけ分かる。「まだ聞いていない」と「断られた」は区別できない。
- **マイク**: `AVCaptureDevice.authorizationStatus(for: .audio)` か `AVAudioApplication.shared.recordPermission` で、ダイアログを出さずに `notDetermined` / `denied` / `authorized`（`undetermined` / `denied` / `granted`）が分かる。
- **システム音声（プロセスタップ）**: 許可（System Audio Recording）を、ダイアログを出さずに確かめる公開 API は見つからなかった。
- **許可はヘルパー単体ではなく、起動したアプリ（ターミナルなど、責任プロセス）に付く**。確かめる側は、会議でヘルパーを起動するのと同じ経路（同じプロセスの系列）で走らせないと、答えがずれる。
- **ヘルパーとビルド**: server の `resolveHelperPath` は、既定の実行ファイルがあるかだけを見ている。AEC3 は静的にリンクされるので、実行ファイルがあれば AEC3 の有無を実行時に別に確かめる必要は無い。
- **いまのヘルパーに「確かめるだけ」の口は無い**。サブコマンドは `list`・`run`・`mix` の 3 つで、`run` は開始時にモデルを取りに行き、マイクと画面収録の許可を求める（ダイアログが出る）。`cli check` と `start` で使うには、副作用の無い `check` サブコマンドを足す必要がある。

## 1. SpeechAnalyzer の日本語モデル

### API と分かること

| API | 分かること | 副作用 |
|---|---|---|
| `SpeechTranscriber.supportedLocales` / `supportedLocale(equivalentTo:)` | この端末で扱える言語（未導入でも取得できるもの含む）。端末が transcriber に対応しなければ空 | 無し |
| `SpeechTranscriber.installedLocales` | 端末に入っている言語（システム全体） | 無し |
| `AssetInventory.status(forModules:)` | `installed`（入っていて使える）/ `supported`（取りに行く必要がある）/ `downloading`（取得中・条件待ち）/ `unsupported`（この構成では動かない）。複数のモジュールで違えば `unsupported` → `downloading` → `supported` → `installed` の順で当てはまるものを返す | 無し |
| `AssetInventory.reservedLocales` / `maximumReservedLocales` | このアプリの言語の予約と、その上限（端末の空き容量で変わる） | 無し |
| `AssetInventory.assetInstallationRequest(supporting:)` | `installed` なら `nil`。そうでなければ要求を返す | **予約していない言語を自動で予約する**（上限を超えると throw） |
| `AssetInstallationRequest.downloadAndInstall()` | 取得と導入 | 取得する。接続の問題などで失敗しても、システムが後で自動で再試行する |

出典:
- [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory)（取得の 4 段階、資産はシステムが管理しアプリ間で共有、「しばらく使われていない資産からアプリの購読を外すことがある」）
- [status(forModules:)](https://developer.apple.com/documentation/speech/assetinventory/status(formodules:))、[AssetInventory.Status](https://developer.apple.com/documentation/speech/assetinventory/status) の各 case（[installed](https://developer.apple.com/documentation/speech/assetinventory/status/installed)・[supported](https://developer.apple.com/documentation/speech/assetinventory/status/supported)・[downloading](https://developer.apple.com/documentation/speech/assetinventory/status/downloading)・[unsupported](https://developer.apple.com/documentation/speech/assetinventory/status/unsupported)）
- [assetInstallationRequest(supporting:)](https://developer.apple.com/documentation/speech/assetinventory/assetinstallationrequest(supporting:))（「`.installed` なら nil」「予約していない言語は自動で予約し、上限を超えるなら throw」）
- [downloadAndInstall()](https://developer.apple.com/documentation/speech/assetinstallationrequest/downloadandinstall())、[reservedLocales](https://developer.apple.com/documentation/speech/assetinventory/reservedlocales)、[maximumReservedLocales](https://developer.apple.com/documentation/speech/assetinventory/maximumreservedlocales)、[reserve(locale:)](https://developer.apple.com/documentation/speech/assetinventory/reserve(locale:))
- [SpeechTranscriber.installedLocales](https://developer.apple.com/documentation/speech/speechtranscriber/installedlocales)、[supportedLocales](https://developer.apple.com/documentation/speech/speechtranscriber/supportedlocales)
- SDK の `Speech.swiftmodule/arm64e-apple-macos.swiftinterface`（Command Line Tools の macOS SDK）。`AssetInventory` の公開メンバーは上の表のものと `release(reservedLocale:)` だけ。`AssetInstallationRequest` は `ProgressReporting` に準拠し、`progress: Progress` と `downloadAndInstall()` だけを持つ

### 容量は事前に分からない

公開 API に、ダウンロードや導入の大きさを返すものは無い（swiftinterface で確認）。`AssetInstallationRequest.progress` は `Progress`（`kind` は file、`fileOperationKind` は downloading）だが、`downloadAndInstall()` を呼ぶ前の `totalUnitCount` は 0 だった（下の実測）。stderr に出す「容量の目安」は、実測した値を固定で持つしかない。

### 実測（2026-10-09、macOS 27.0.1、この Mac）

小さな Swift の実行ファイルを `swiftc` でビルドして動かした（ad-hoc 署名。識別子は出力ファイル名になる）。

- `installedLocales` に `ja_JP` があり（en_* と ja_JP の 10 個）、`supportedLocales` は 45 個、`maximumReservedLocales` は 5。
- 新しい識別子（`probe`）の実行ファイルでは、`reservedLocales` が空で、ja-JP の `status` は **`supported`**（端末には入っているのに）。
- 同じコードを識別子 `live-mindmap-helper`（ヘルパーと同じ）でビルドすると、`reservedLocales` は `["ja_JP"]`、ja-JP の `status` は **`installed`**。識別子 `stt-bench` でも同じ。別のパスに置いた同じ識別子の実行ファイルどうしは予約を共有した。つまり **予約と `status` はコード署名の識別子ごと**で、パスではない。
- `assetInstallationRequest(supporting:)` を fr-FR で呼ぶと、ダウンロードしなくても `reservedLocales` に `fr_FR` が入った（予約の副作用）。そのときの `progress.totalUnitCount` は 0。確かめた後に `release(reservedLocale:)` で戻した（同じ識別子の実行ファイルから呼ばないと `false` で外れなかった）。
- これらの呼び出しで、ダイアログは出なかった。`run` も Speech の認可（`SFSpeechRecognizer.requestAuthorization`）は求めていない（`SpeechAnalyzerTranscriber.prepare()`）。

### 確かめ方への示唆

- 「会議でヘルパーが取りに行くことになるか」を正しく答えるのは、**ヘルパーと同じ識別子のプロセスで `status(forModules:)`** を呼んだときだけ。server（Node）や別の道具から確かめると、端末に入っていても `supported` になりうる。
- `status` が `supported` でも `installedLocales` に `ja_JP` があれば、`downloadAndInstall()` は予約だけで「すぐ終わる」ことが多い（Apple の説明: 既にプリインストール・他のアプリが取得済みなら即座に終わることがある）。`check` は両方を返すと、「取りに行く（数百 MB の可能性）」と「予約するだけ」を分けて示せる。
- 確かめるときは `assetInstallationRequest(supporting:)` を呼ばない（予約が付く）。`status(forModules:)` と `installedLocales` だけにする。
- ヘルパーは今、いつも ja-JP の `SpeechTranscriber` を `[.volatileResults, .fastResults]`・`[.audioTimeRange]` で作る（`helper/Sources/HelperCore/SpeechAnalyzerTranscriber.swift`）。`check` も同じ構成で作る。

## 2. 画面収録の許可

- `CGPreflightScreenCaptureAccess()`: 「プロンプトを出さずに、現在のプロセスが画面の内容を取り込む許可を既に持っているかを返す」。`false` なら `CGRequestScreenCaptureAccess` で求めるよう書かれている（SDK の `CoreGraphics.framework/Headers/CGWindow.h` のコメント。[リファレンス](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()) は本文が空）。
- `CGRequestScreenCaptureAccess()`: 未決定ならプロンプトを出す。**一度断られたプロセスには再び出さず**、システム設定 > プライバシーとセキュリティ > 画面収録で有効にする必要がある（同ヘッダ。[リファレンス](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess())）。
- 返り値は `Bool` だけなので、「まだ聞いていない」と「断られた」は区別できない。
- いまのヘルパーは `run` の開始時に `CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()` を 1 回だけ呼ぶ（`helper/Sources/live-mindmap-helper/main.swift`、判定は `ScreenCapturePlan.swift`）。許可が無ければ throw せず、`screen-off`（`許可なし`）を流して音声だけで続ける。地図の「欠けても一部の出力が減るだけ」の扱いと合う。

## 3. マイクの許可

- `AVCaptureDevice.authorizationStatus(for: .audio)`: アプリの現在の状態を返す。`notDetermined` なら `requestAccess(for:completionHandler:)` で求める。許可が無い・未回答のとき、録音は無音になる（[リファレンス](https://developer.apple.com/documentation/avfoundation/avcapturedevice/authorizationstatus(for:))）。
- `AVAudioApplication.shared.recordPermission`: 録音の許可（`undetermined` / `denied` / `granted`）。`requestRecordPermission()` は未決定ならユーザーの入力を待つ（[recordPermission](https://developer.apple.com/documentation/avfaudio/avaudioapplication/recordpermission-swift.property)、[requestRecordPermission](https://developer.apple.com/documentation/avfaudio/avaudioapplication/requestrecordpermission(completionhandler:))）。
- どちらも読むだけならダイアログは出ない（下の実測でも出なかった）。画面収録と違い、未決定と拒否を区別できる。
- いまのヘルパーは `run` で `AVAudioApplication.requestRecordPermission()` を呼び、`false` なら `MicrophoneError.permissionDenied` で終わる（`helper/Sources/HelperCore/Microphone.swift`。終了コードは 1）。

## 4. システム音声（プロセスタップ）の許可

- Apple のサンプル記事は、タップには `NSAudioCaptureUsageDescription` を Info.plist に入れること、「タップを含む集約デバイスから初めて録音を始めたときに、システム音声の録音の許可を求める」ことを書いている（[Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)）。
- この許可を、ダイアログを出さずに確かめる公開 API は見つからなかった（CoreAudio のヘッダに認可の API が無い。`kAudioDevicePermissionsError` は hog モードの話）。開始前の確かめの対象からは外すか、「確かめられない」と明示するしかない。

## 5. 許可はプロセスごとか（ヘルパーか、起動したターミナルか）

- ヘルパーは Info.plist を持たない素の実行ファイル（`helper/Package.swift` は `executableTarget` だけ）。Apple は、使用目的の文字列なしにマイクを使うとアプリが終了すると書いているが（requestRecordPermission の説明）、ヘルパーは動いている。許可は、ヘルパーではなく **起動元のアプリ（責任プロセス。ターミナルなど）** に付いて判定されている。`helper/README.md` も「システム音声の取得とマイクの使用は、起動したターミナルの権限で動く」と書き、`main.swift` の stderr の文言も「起動したターミナルに許可を与え、ターミナルを開き直す」としている。
- 実測: この作業のプロセス（Orca の端末の下のエージェント）から、一度も許可を求めたことの無い新しい実行ファイル（`probe`）を動かすと、`CGPreflightScreenCaptureAccess()` は `true`、`AVCaptureDevice.authorizationStatus(for: .audio)` は `authorized`、`recordPermission` は `granted` だった。新しいバイナリ自身ではなく、起動元の許可が返っている。
- 帰結: **確かめる側は、会議でヘルパーを起動するのと同じ系列で動かす必要がある**。server がヘルパーの `run` を起動する（`server/src/sessions.ts`）ので、server を起動したターミナルの許可が会議で効く。`cli check` が自分のプロセスからヘルパーを直接起動すると、エージェントの端末の許可を見てしまい、server を別の端末やアプリから起動していると答えがずれる。地図の「導入はサーバーが行う」と同じく、確かめもサーバーから起動したヘルパーで行うのが正しい。
- 一方、モデルの予約（1 章）は責任プロセスではなく、**実行ファイルの識別子**ごと。こちらはヘルパー自身が呼べばよい。

## 6. ヘルパーの実行ファイルと WebRTC AEC3（server で確かめられること）

- `server/src/helperPath.ts` の `resolveHelperPath`: `LIVE_MINDMAP_HELPER` があればそれを（存在を確かめずに）使う。無ければ `helper/.build/release/live-mindmap-helper` が **あるか（`existsSync`）だけ** を見て、無ければビルドのコマンド（`swift build -c release --package-path helper`）を含む文を返す。実行できるか、ソースより古くないか、版は見ていない。
- 使われ方: `server/src/server.ts` は起動時に呼び、無ければ stderr に文を出して終了コード 1 で終わる（セッションを始める前に止まる）。`server/src/cli.ts` は、無ければ録音の mix（`map-audio.html`）だけを諦める Layer に差し替える。
- AEC3: `helper/Package.swift` が `helper/.deps/webrtc-apm/lib/*.a` を `CWebRTCAPM` に **静的にリンク** する。無ければビルドが止まる。したがって AEC3 はビルドの前提で、実行時の依存ではない。release の実行ファイルがあれば AEC3 も入っている。server が確かめるのは実行ファイルだけでよい。ビルドを促すときは `bash helper/scripts/build-webrtc-apm.sh`（`uv` が要る。済んでいれば何もしない）が先に要る。今の文言はこれに触れていない。

## 7. いまのヘルパーに「確かめるだけ」の口はあるか

無い。`helper/Sources/live-mindmap-helper/main.swift` のサブコマンドは次の 3 つ。

- `list`: 音声を出している会議アプリの一覧を JSON で出す（Core Audio のプロセスの一覧。許可は求めない）。server の `helpers.ts` が使う。
- `run`: 開始時に、2 つの `SpeechAnalyzerTranscriber.prepare()`（言語の対応を確かめ、要るなら **モデルを取りに行く**）、`requestMicrophonePermission()`（未決定なら **ダイアログ**）、`CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()`（未決定なら **ダイアログ**）を順に行う。確かめと準備と開始が一体で、確かめだけを取り出せない。
- `mix`: 録音を混ぜる。

`cli check` と `start` で使うには、`run` の前段から副作用を外した `check` サブコマンド（例: JSON で `speech`（`supportedLocale`・`installedLocales` に ja があるか・`status`）、`microphone`（`AVCaptureDevice.authorizationStatus`）、`screen`（`CGPreflightScreenCaptureAccess`）を返し、ダイアログもダウンロードも予約もしない）を足す形になる。server がこれを、会議と同じ経路で起動して読む。

## 残る問い

- 日本語モデルの容量の目安（公開 API では分からない。実測した値を固定で持つか、出さないか）。
- `status` が `supported` で `installedLocales` に ja がある（予約するだけ）ときを「足りない」と扱うか、開始してよいか。
- 画面収録が「まだ聞いていない」ときの扱い。いまは `run` の開始時にダイアログが出る。開始前の確かめで「無い」と出たとき、地図の方針（開始したうえで警告）のままダイアログを `run` に残すか。
- システム音声の許可は確かめられない。拒否されていると `相手` が無音になるだけで気付きにくい。開始後の検出（一定時間まったく音が来ない等）が要るか。
- `cli check` の確かめを、server が起動していないときにどう行うか（責任プロセスがずれる）。
