# .app から起動したヘルパーのマイク・画面収録の許可の付き先（issue #1868）

調べた日: 2026-11-03。map #1865。手元の TCC はリセットも変更もしていない。出典は Apple の文書と、Apple の DTS の技術者（Quinn "The Eskimo!" ほか）が Developer Forums に書いた回答に限った。

- **[文書]** は、Apple の文書か DTS の回答に書いてあること。
- **[推論]** は、それらから導いたこと。Apple は明言していない。

## 結論

- **許可の付き先**
  - .app → Node のサーバー → Swift のヘルパーを、どれも普通の子プロセスとして起動すれば、TCC は許可を .app に付ける。.app が responsible process になる。
  - 確認のダイアログには .app の名前とアイコンが出る。説明の文言も .app の Info.plist から出る。システム設定にも .app の名前で並ぶ。
  - 条件: 鎖の途中で launchd（`SMAppService` の LaunchAgent を含む）を挟まない。デーモン化もしない。
- **許可が外れるか**
  - 許可は、コードの designated requirement（DR）で同じアプリかを見分けている。Developer ID の DR には bundle id と Team ID が入る。
  - 同じ Developer ID・同じ bundle id の Sparkle の更新では、許可は残る。
  - 外れる場合:
    - bundle id を変えたとき
    - 別の Team で署名し直したとき
    - ad-hoc 署名のとき（版ごとに別のコードと見なされる）
  - .app のファイル名だけを変えても、bundle id と署名が同じなら残る見込み [推論]。
- **GUI から状態を読む**
  - マイクと画面収録は公開 API で読める。
  - システム音声（プロセスタップ）の状態を読む公開 API は無い。
  - システム設定の該当の場所を開く `x-apple.systempreferences:` の URL は、Apple が文書にしていない。今は動くが、将来も動く保証は無い。

## このリポジトリが今使っている API

| 取り込むもの | API | 場所 |
|---|---|---|
| マイク | `AVAudioEngine` の入力。許可は `AVAudioApplication.requestRecordPermission()` で求める | `helper/Sources/HelperCore/Microphone.swift` |
| システム音声 | Core Audio のプロセスタップ（`CATapDescription(stereoMixdownOfProcesses:)`・`AudioHardwareCreateProcessTap`） | `helper/Sources/HelperCore/ProcessTap.swift` |
| 共有画面 | ScreenCaptureKit（`SCShareableContent`・`SCStream`）。許可は `CGPreflightScreenCaptureAccess() \|\| CGRequestScreenCaptureAccess()` で確かめる | `helper/Sources/HelperCore/ScreenCapture.swift`、`helper/Sources/live-mindmap-helper/main.swift` |
| 許可の状態（`check`） | `AVCaptureDevice.authorizationStatus(for: .audio)`・`CGPreflightScreenCaptureAccess()` | `helper/Sources/HelperCore/SystemCheck.swift` |

起動の仕方:

- サーバーは、`resolveHelperPath` が返す実行ファイル（既定は `helper/.build/release/live-mindmap-helper`）を、Effect の `ChildProcessSpawner` で子プロセスとして起動する（`server/src/helpers.ts`）。`run`・`check`・`list` などはどれもこの経路を通る。
- `detached: true` はプロセスグループを分けるだけで、launchd を通さない。そのため、responsible process の判定には影響しない見込み [推論]。

ヘルパーの今の状態:

- ヘルパーは Info.plist を持たない素の CLI である。`Package.swift` に `__info_plist` を埋め込む設定は無い。
- そのため、今の手元の開発では、起動したターミナル（Terminal・iTerm・Ghostty・VS Code など）が responsible process になっている。許可もターミナルに付く。`helper/README.md` の「起動したターミナルの権限で動く」はこのことを指す。

## 1. 許可はどのプロセスに付くか（responsible process）

- **[文書]** ヘルパーがダイアログの原因になったとき、TCC は responsible code を探す。見つけたアプリに対しては、次のようになるべきだとされる。
  - ダイアログにはアプリの名前と usage description が出る。
  - 決定はアプリ全体に記録される。
  - システム設定にはアプリの名前で並ぶ。

  探し方は経験則（heuristics）である。子が「変わったこと」（デーモン化など）をすると、アプリとのつながりが切れやすい。出典: https://developer.apple.com/forums/thread/678819
- **[文書]** 「TCC is primarily focused on apps… TCC needs to determine the responsible code, which isn't always easy.」 https://developer.apple.com/forums/thread/744577
- **[文書]** `fork()` と `execve()` で起動したヘルパーのカメラの事例がある。usage の文言をメインのアプリの Info.plist に足して、初めてダイアログが出た。usage の文言は responsible なアプリの Info.plist に置く。 https://developer.apple.com/forums/thread/701094
- **[文書]** usage description が無いまま `requestAccess` を呼ぶか、取り込みを始めると、例外になる。ダイアログとシステム設定には、この文言が出る。 https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media
- **[文書]** プロセスタップには `NSAudioCaptureUsageDescription`（macOS 14.2+）が要る。ダイアログは、タップを含む aggregate device を初めて開始したときに出る。
  - https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription
  - https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
- **launchd・SMAppService で起動する場合**
  - **[文書]** launchd のジョブを TCC にアプリへ結び付けさせるには、plist に `AssociatedBundleIdentifiers` が要る。 https://developer.apple.com/forums/thread/697278
  - **[文書]** それでも「TCC's ability to trace from a daemon to its container app is rather limited, even if the daemon is installed via `SMAppService`」とされる。launchd の daemon・agent の TCC の扱いは「basically no documentation」とも書かれている。 https://developer.apple.com/forums/thread/853725
  - **[推論]** サーバーやヘルパーを launchd で常駐させると、それぞれが自分の responsible process になりやすい。許可が .app と別に付くおそれがある。許可を 1 か所にまとめるなら、.app の子プロセスにする方が安全である。これは、map の「.app がサーバーとヘルパーをどう起動するか」の判断材料になる。
- **開発中**
  - **[文書]** Xcode やターミナルから単独で起動したツールでは、その起動ごとにダイアログが出た。 https://developer.apple.com/forums/thread/701094
  - **[推論]** 手元で `pnpm dev` から起動すると、許可はターミナルに付く。配布版の許可の動きは、署名した .app から起動して確かめる必要がある。

### 確認のダイアログに出る名前

- **[推論]** 子プロセスの鎖のままなら、.app の名前（`CFBundleDisplayName`／`CFBundleName`）とアイコンが出る。説明の文言は .app の Info.plist の `NSMicrophoneUsageDescription`・`NSAudioCaptureUsageDescription` から出る。
- 画面収録には usage description のキーが無い。ダイアログは OS の定型文になる。

## 2. 署名・更新・改名で外れるか

- **[文書]** 「macOS tracks code identity using the code's designated requirement (DR). Ad hoc signed code does not include a stable DR」。ad-hoc 署名では、版 N+1 が版 N と同じコードと見なされない。
  - https://developer.apple.com/forums/thread/795739
  - https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements
- **[文書]** 更新のたびにスクリーンショットの許可が外れるのは、「almost certainly a code signing issue」とされる。 https://developer.apple.com/forums/thread/697278
- **[推論（TN3127 から）]** Developer ID の DR には bundle id と Team ID（証明書の OU）が入る。
  - Sparkle の更新で、同じ Developer ID・同じ Team・同じ bundle id なら、許可は残る。
  - 別の Team の証明書で署名し直すと、DR が一致しない。許可は効かず、もう一度ダイアログが出る見込み。
  - bundle id を変える（改名の map #1857 の結論で変わりうる）と、別の TCC の利用者になる。許可は外れ、もう一度許可をもらう必要がある。
  - .app のファイル名・表示名だけを変えても、bundle id と DR が同じなら残る見込み。Apple の明言は無い。
  - ヘルパーを別に署名して埋め込んでも、付き先は .app なので、ヘルパーの署名の詳細は許可の保持にほぼ関係しない見込み。ただし、Team は揃えておく。
- **画面収録の再確認**
  - **[文書]** macOS 15 のリリースノート（125112908）: `CGDisplayStream`・`CGWindowListCreateImage` など非推奨の API で取り込むと、システムの確認が出ることがある。ScreenCaptureKit と `SCContentSharingPicker` へ移るよう求めている。 https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes
  - **[文書]** macOS 15.1 で、MDM の `forceBypassScreenCaptureAlert` が加わった。 https://developer.apple.com/documentation/macos-release-notes/macos-15_1-release-notes
  - **[文書]** DTS は、ScreenCaptureKit そのもの（`SCShareableContent` と `SCScreenshotManager.captureImage`）でも、2 回目の取り込みで「bypass the system private window picker」の確認を再現している。避ける方法として挙げたのは 2 つ。 https://developer.apple.com/forums/thread/765103
    - Persistent Content Capture の entitlement
    - `SCContentSharingPicker` を出すこと
  - **[文書]** Persistent Content Capture（`com.apple.developer.persistent-content-capture`、macOS 14.4+）は VNC のようなアプリ向けで、Apple へ申請が要る。 https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture
    - [推論] 会議の取り込みは対象外の見込み。
  - **[Apple の出典なし]** 確認がおよそ月 1 回出ることや、「1 か月許可」のボタンは、報道（例: https://www.macrumors.com/2024/10/07/apple-screen-recording-popup-update ）にしか無い。
  - macOS 26 のリリースノートに、画面の取り込み・TCC の項目は無い。macOS 26 で画面収録の許可がタップも兼ねる、という話は第三者の情報だけで、確かめられていない。
  - ヘルパーは `SCStream` でウィンドウを撮るので、配布版でも定期的な再確認が出る可能性がある。実機で確かめる。

## 3. Hardened Runtime の entitlement

- **[文書]** `com.apple.security.device.audio-input` は、マイクと Core Audio の入力を対象にする。Hardened Runtime で公証したアプリに付けないと、ダイアログも出ずに拒否される。
  - https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input
  - https://developer.apple.com/forums/thread/835256
- **[文書]** entitlement は実行ファイルに付ける。ライブラリは、それを読み込んだ実行ファイルの entitlement を引き継ぐ。 https://developer.apple.com/documentation/security/hardened-runtime
- **[推論]** API を呼ぶヘルパーと、responsible な .app の両方に `audio-input` を付ける。TCC がどちらを見るかは文書に無いので、両方に付けておく。
  - 同梱の Node は Hardened Runtime の JIT の entitlement（`com.apple.security.cs.allow-jit` など）が要るが、これは別の論点である。
- 画面収録には Hardened Runtime の entitlement は無く、TCC だけで決まる。`com.apple.private.*` は第三者には使えない。 https://developer.apple.com/forums/thread/683860
- プロセスタップは、`NSAudioCaptureUsageDescription` を .app の Info.plist に置けばよい。

## 4. GUI から許可の状態を読み、システム設定を開く

| 対象 | 状態を読む | 求める | 根拠 |
|---|---|---|---|
| マイク | `AVCaptureDevice.authorizationStatus(for: .audio)`、`AVAudioApplication.shared.recordPermission`（macOS 14+） | `AVCaptureDevice.requestAccess(for: .audio)`、`AVAudioApplication.requestRecordPermission()` | [文書] https://developer.apple.com/documentation/avfaudio/avaudioapplication/recordpermission-swift.property |
| 画面収録 | `CGPreflightScreenCaptureAccess()` | `CGRequestScreenCaptureAccess()`。拒否されると取り込みが `SCStreamError.Code.userDeclined` になる | [文書] https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess() |
| システム音声（タップ） | 公開 API は無い | タップを含む aggregate device を開始すると、初回だけダイアログが出る | [文書] https://developer.apple.com/forums/thread/756783 |

- システム音声の許可
  - **[文書]** Apple の技術者は「There is no API to determine whether an app still has permission to capture system audio.」と書いている。無音のバッファが続くことを、許可が取り消された兆しとして扱うよう勧めている。 https://developer.apple.com/forums/thread/756783
  - TCC の `kTCCServiceAudioCapture` は非公開の SPI なので使わない。
  - [推論] GUI では、ヘルパーが報告する「タップの無音」（既存の `TapSilentJudgement`）を許可の手がかりとして見せるしかない。
- **GUI が読む状態は、ヘルパーの許可と同じか**
  - [推論（678819 の「決定はアプリ全体に記録される」から）] ヘルパーが .app の子プロセスなら同じである。
  - そのため、次のどちらでもよい。
    - GUI 自身が上の API を呼ぶ。
    - 今の `live-mindmap-helper check` を .app の子として起動し、その JSON（`microphone`・`screenCapture`）を読む。
  - ヘルパーを launchd で起動する場合と、ターミナルから起動する場合は、この前提が崩れる。
- **システム設定を開く**
  - 今は次の URL で、プライバシーの該当の欄が開く。どれも Apple の文書には無い。
    - `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`
    - `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
    - `x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture`（システム音声）
  - **[文書]** Quinn は、文書に無い URL スキームを「unsupported… might work, or they might not」としている。macOS で文書にある設定の開き方は、`SMAppService.openSystemSettingsLoginItems()` だけである。
    - https://developer.apple.com/forums/thread/761314
    - https://developer.apple.com/forums/thread/765705
  - [推論] URL で開けなかったときに備えて、「システム設定 › プライバシーとセキュリティ › マイク」のように、手で辿る道順も文言で出しておく。

## 後の ticket への申し送り

- サーバーとヘルパーは .app の子プロセスにする。launchd（SMAppService）に常駐させると、許可が .app から外れるおそれがある。起動方式の ticket で、この点を判断材料にする。
- .app の Info.plist に `NSMicrophoneUsageDescription` と `NSAudioCaptureUsageDescription` を置く（日本語・英語の `InfoPlist.strings` も）。.app とヘルパーの両方に `com.apple.security.device.audio-input` を付ける。
- bundle id は改名の map #1857 で一度決めたら変えない。変えると、利用者全員に許可を取り直してもらうことになる。
- 署名は、開発中も Apple Development／Developer ID で行う。ad-hoc 署名のビルドで許可を試すと、版ごとに許可が外れる。
- 実機で確かめること（どれも Apple の文書だけでは決まらない）:
  - 署名した .app からの起動で、ダイアログの名前と、システム設定の並びが .app になるか。
  - `SCStream` の定期的な再確認が出るか。
  - 改名・更新の後も許可が残るか。
