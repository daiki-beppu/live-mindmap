# 会議アプリのウィンドウから共有画面を取り込む手段と権限の調査（Issue #180）

Map #179 の研究チケット。選んだ会議アプリのウィンドウから**共有画面**を取り込むのに、macOS のどの手段が使えて、何が要るかを、一次情報（Apple のドキュメント・WWDC・Apple 開発者フォーラムの DTS の回答・各会議アプリの公式ヘルプ）で調べた。Zoom・Teams の実機の確認はしていない（この Mac で起動していなかった）。Chrome のウィンドウの並びだけ、`SCShareableContent` で手元の値を見た。非公開 API は候補に入れていない。結論は次のとおり。

- **手段は ScreenCaptureKit（macOS 12.3〜）。** `SCShareableContent` が返すウィンドウ（`SCWindow`）は、持ち主のアプリ（`owningApplication.bundleIdentifier`・`processID`）を持つ。今の「選んだ会議アプリ」の bundle id（`MeetingApps.swift` が音声プロセスを束ねた先のアプリ本体の id）と、そのまま突き合わせられる。Chrome では、音は helper のプロセスから出るが、ウィンドウはアプリ本体（`com.google.Chrome`）が持っていた。
- **変わったときだけ取る手がかりは、OS が出す。** ストリームのフレームには状態（`SCFrameStatus`）が付き、画面が変わらなければ `idle`（新しいフレームを作らない）になる。変わった範囲（`dirtyRects`）も付く。取る頻度の上限は `minimumFrameInterval` で絞れる。単発なら `SCScreenshotManager`（macOS 14〜）。
- **権限は、音とは別に「画面収録」が要る。** システム設定の「画面とシステムオーディオの録音」は、画面と音の両方か、音だけかを分けて許可する。今のプロセスタップ（音だけ）の許可では、画面は取れない。ヘルパーは CLI で、ターミナルから起動したサーバーの子プロセスなので、許可は今と同じく起動したアプリ（ターミナルなど）に付く見込み（音の許可がそうだった。画面での確認はしていない）。
- **ピッカーを使わずに直接取ると、macOS 15 以降は「1 か月ごとの確認」が出る。** Apple の DTS が、`SCShareableContent` から直接取るコードでこの警告を再現している。避け方は、システムのピッカー（`SCContentSharingPicker`）で利用者に毎回選んでもらうか、VNC 向けの申請制のエンタイトルメントだけ。ピッカーは「会議アプリのウィンドウだけを候補に出す」設定を持たない（除外の指定だけ）。どちらにしても、利用者に新しい手順か確認を課す。
- **共有画面がウィンドウのどこに・どのウィンドウに映るかは、会議アプリと利用者の設定で変わる。** Zoom は既定で会議ウィンドウの中（横並び・デュアルモニターの設定で変わる）、Teams と Meet は共有画面を別ウィンドウに出せる。Meet はブラウザのタブなので、利用者が同じウィンドウで別のタブに切り替えると、ウィンドウには Meet ではなく別のページが映る。
- **「共有画面が無い（顔だけ）」を会議アプリから教えてもらう公開の手段は見つからなかった。** 手がかりになりうるのは、ウィンドウの数とタイトルの変化（別ウィンドウに出す設定のとき）と、画像そのもの（文字の量・顔の検出）。どれも会議アプリと設定に依存し、確実ではない。

## 今の「選んだ会議アプリ」の特定（コード）

- `helper/Sources/HelperCore/CoreAudioProcesses.swift` の `currentAudioProcesses()` が、Core Audio のプロセス一覧（`kAudioHardwarePropertyProcessObjectList`）から、bundle id と「いま音を出しているか」（`kAudioProcessPropertyIsRunningOutput`）を取る。`currentRunningApps()` は `NSWorkspace` の起動中の通常アプリ（`activationPolicy == .regular`）。
- `helper/Sources/HelperCore/MeetingApps.swift` の `meetingApps(audioProcesses:runningApps:)` が、音を出しているプロセスを、bundle id の前方一致（`.` の境界）でアプリ本体にまとめる。`list` が出し、`run --app <bundle id>` に渡るのは**アプリ本体の bundle id**（例: `us.zoom.xos`、`com.google.Chrome`）。
- `tapTargets(forApp:in:)` が、本体と helper のプロセスすべてをタップの対象にし、`helper/Sources/HelperCore/ProcessTap.swift` が `CATapDescription(stereoMixdownOfProcesses:)` でタップを作る。
- 共有画面の取り込みも、同じ bundle id から始められる。`SCShareableContent.applications` の `SCRunningApplication.bundleIdentifier` が一致するアプリ、または `SCWindow.owningApplication.bundleIdentifier` が一致するウィンドウを選ぶ。

### 手元で見た値（Chrome、2026-10-05）

`SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)` で、起動中の Chrome のウィンドウを並べた（会議は開いていない）。

- Chrome のウィンドウは 11 個。持ち主はすべて本体（`com.google.Chrome`、同じ pid）。helper のプロセス（音を出す側）が持つウィンドウは無かった。
- タイトルが付いていたのは、ブラウザのウィンドウ 1 個だけ（1710×1074、タイトルは**前面のタブのページのタイトル**）。残りはタイトルの無いウィンドウ（1710×38 の帯が 4 個、943×139 と 943×89 が 1 個ずつ、1×1 が 2 個、レイヤー 3 と 103 の小さなものが 1 個ずつ）。大きさとタイトルで、本体のウィンドウを選び分ける必要がある。
- `isOnScreen` は、この時点ですべて `false` だった（画面の状態は記録していない）。ウィンドウの選び方を `isOnScreen` だけに頼ると外れることがある。

## 手段: ScreenCaptureKit

### 何を対象にできるか

- `SCShareableContent` は、取り込める画面・アプリ・ウィンドウの集まり（[SCShareableContent](https://developer.apple.com/documentation/screencapturekit/scshareablecontent)）。
- `SCWindow` は、ウィンドウ ID・枠・タイトル・画面上にあるか（最小化されているか）を読み取り専用で持ち、持ち主のアプリを持つ（[WWDC22 10156 Meet ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/)、[SCWindow.owningApplication](https://developer.apple.com/documentation/screencapturekit/scwindow/owningapplication)、[SCWindow.title](https://developer.apple.com/documentation/screencapturekit/scwindow/title)、[SCWindow.isOnScreen](https://developer.apple.com/documentation/screencapturekit/scwindow/isonscreen)）。
- `SCRunningApplication` は `bundleIdentifier` と `processID` を持つ（[bundleIdentifier](https://developer.apple.com/documentation/screencapturekit/scrunningapplication/bundleidentifier)、[processID](https://developer.apple.com/documentation/screencapturekit/scrunningapplication/processid)）。
- 絞り込み（`SCContentFilter`）は 2 種類ある（WWDC22 10156）。
  - **ウィンドウ 1 つ**: `init(desktopIndependentWindow:)`。ウィンドウを画面をまたいで動かしても、そのウィンドウを取り続ける（[init(desktopIndependentWindow:)](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:))）。
  - **画面 1 つ ＋ アプリで絞る**: `init(display:including:exceptingWindows:)`。指定したアプリが持つウィンドウだけを、その画面の配置のまま取る（[init(display:including:exceptingWindows:)](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:including:exceptingwindows:))）。会議アプリが共有画面を別ウィンドウに出したときも 1 本で拾えるが、会議アプリの小さな帯やポップアップも入る。
- 音の絞り込みはアプリ単位だけ（WWDC22 10156）。今の音はプロセスタップのままにし、ScreenCaptureKit では画面だけを取る（`capturesAudio` は既定で `false`。[capturesAudio](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio)）。

### 変わったときだけ取る

- ストリームの各フレームには状態が付く。`complete` は新しいフレーム、`idle` は「画面が変わらなかったので新しいフレームを作らなかった」（[SCFrameStatus.idle](https://developer.apple.com/documentation/screencapturekit/scframestatus/idle)、WWDC22 10156）。
- フレームの付加情報 `dirtyRects` は、描き直された範囲と動いた範囲の和（[SCStreamFrameInfo.dirtyRects](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects)）。カーソルや動画の部分だけが変わったかを、範囲の大きさで見分ける材料になる（しきい値は #179 の「まだ決めていない」の範囲）。
- 受け取る頻度の上限は `minimumFrameInterval` で決める（既定 0 は最大のフレームレート。[minimumFrameInterval](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/minimumframeinterval)）。
- 単発の撮影は `SCScreenshotManager`（macOS 14〜。[SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)）。ピッカーで作った絞り込みでも使える（[WWDC23 10136 What's new in ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2023/10136/)）。ストリームで「変わった」を検知し、そのフレームを使えば、一定間隔で撮る必要はない。

### 使わないもの

- `CGWindowListCreateImage`・`CGDisplayStream` は非推奨で、macOS 15 では「詳しい情報を集められるかもしれない」という警告を出しうる。ScreenCaptureKit と `SCContentSharingPicker` に移るよう、リリースノートが求めている（[macOS Sequoia 15 Release Notes](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)、120910350）。
- アクセシビリティ API（`AXUIElement`）で会議アプリの UI の文言を読む案は、公開 API だが、アクセシビリティの許可という新しい権限が要る。下の「共有画面が無いときの見分け」で候補として触れるだけにする。

## 権限

### 画面収録は、音とは別の許可

- ScreenCaptureKit は、取り込む前に画面収録の許可を利用者から得る必要がある。Info.plist に `NSScreenCaptureUsageDescription` を書く（[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)）。
- プロセスタップは `NSAudioCaptureUsageDescription`（macOS 14.2〜）で、初めてタップ入りの集約デバイスから録るときに「システムオーディオ録音」の許可を求める（[Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)、[NSAudioCaptureUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription)）。
- システム設定の「画面とシステムオーディオの録音」では、画面と音の両方を許すか、音だけを許すかを選べる（[Mac で画面とシステムオーディオの録音へのアクセスを制御する](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)）。**音だけの許可では画面は取れない**ので、共有画面を足すと、利用者に新しい許可を 1 つ求めることになる。
- 許可の有無は `CGPreflightScreenCaptureAccess()`（確認だけ、ダイアログを出さない）、求めるのは `CGRequestScreenCaptureAccess()`（macOS 10.15〜。[CGPreflightScreenCaptureAccess()](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess())、[CGRequestScreenCaptureAccess()](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess())）。開始時に確認し、無ければ共有画面だけを止めて音は続ける、という作りにできる。

### ヘルパー（CLI）の許可は、起動したアプリに付く

- ヘルパーは `.app` ではなく、Info.plist の無い実行ファイル（`helper/Package.swift` の `.executable`）。サーバー（`server/src/server.ts` の `launchHelper`）が子プロセスで起動し、サーバーは `pnpm dev` でターミナルから起動する（`README.md`）。
- 今の音とマイクの許可は、ヘルパーを起動したアプリ（ターミナルなど）に付いている（`docs/adr/0002-local-stt-helper.md` の Consequences、`docs/knowledge/2026-09-30.md` の 4）。画面収録も同じく、起動したアプリの許可で動く見込み。Apple の文書でこの帰属の仕組みを説明したものは見つけていない。試作で確かめる。
- この調査を走らせた環境（Orca の端末から起動したエージェント）では `CGPreflightScreenCaptureAccess()` が `true` で、`SCShareableContent` の一覧がダイアログ無しで取れた。起動元のアプリに許可が付いていれば、子プロセスの CLI でも使える、という観察と合う。
- 帰属先が端末アプリになることの副作用: その端末から起動した他のプログラムも画面を取れる状態になる。将来ヘルパーを `.app` に包めば、許可をヘルパー自身に付けられる（今の設計の範囲外）。

### ピッカーを使わない取り込みは、1 か月ごとに確認が出る（macOS 15〜）

- Apple の DTS（Quinn）が、`SCShareableContent.excludingDesktopWindows` で一覧を取り、`SCScreenshotManager.captureImage` で撮るだけのコードで、次の警告を再現している。「"SomeApp" is requesting to bypass the system private window picker and directly access your screen and audio. …」。選択肢は「1 か月間許可」と「システム設定を開く」（[Apple Developer Forums 765103](https://developer.apple.com/forums/thread/765103)）。
- 同じ回答で、避け方は 2 つとしている。(1) `com.apple.developer.persistent-content-capture` のエンタイトルメント、(2) `SCContentSharingPicker` で利用者に都度選んでもらう。(1) は VNC アプリ向けで、Apple への申請が要る（[Persistent Content Capture](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)）。この用途で通る見込みは低い。
- macOS 15.1 で、非推奨の取り込み手段について「既に受け入れたアプリでは確認を減らす」と変わった（[macOS Sequoia 15.1 Release Notes](https://developer.apple.com/documentation/macos-release-notes/macos-15_1-release-notes)、133431080）。MDM では `forceBypassScreenCaptureAlert` で警告を出さないようにできる（macOS 15.1〜、[Restrictions](https://developer.apple.com/documentation/devicemanagement/restrictions)）。個人の Mac では使えない。
- 間隔が週から月に変わったことは、Apple の文書ではなく二次情報（[TidBITS 2024-08-19](https://tidbits.com/2024/08/19/apple-reduces-excessive-sequoia-permission-requests-shifts-to-monthly)）でしか確かめていない。警告の選択肢が「1 か月間許可」であることは、上の DTS の引用と合う。
- macOS 26 のリリースノートに、この警告や画面収録の許可の変更は見つからなかった。

### ピッカー（SCContentSharingPicker）

- システムが出す選択の UI で、ウィンドウ・アプリ・画面を利用者が選ぶ。選んだ結果が `SCContentFilter` としてアプリに届く（[SCContentSharingPicker](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker)、WWDC23 10136）。Apple は自前の選択 UI より、こちらを勧めている（[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)）。
- 設定（`SCContentSharingPickerConfiguration`）でできるのは、選べるモード（ウィンドウ 1 つ・複数・アプリ・画面）、除外する bundle id とウィンドウ ID、選んだ後に変えられるか、の指定（[SCContentSharingPickerConfiguration](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpickerconfiguration-swift.struct)）。**「この bundle id のウィンドウだけを候補に出す」指定は無い**。会議アプリを自動で選ぶことはできず、利用者がセッションごとにウィンドウを選ぶ手順が増える。
- ピッカーを使えば上の 1 か月ごとの警告は出ない（DTS の回答）。ピッカー経由なら画面収録の許可そのものが要らなくなるかは、Apple の文書で確かめられなかった。
- 画面を持たない CLI のヘルパーからピッカーを出せるかも、確かめていない（WWDC23 の例は、アプリのボタンから `present` を呼ぶ形）。

### 「利用者に新しい前提を課さない」との関係

どの経路でも、利用者に 1 つは新しいことを求める。

| 経路 | 初回 | 以後 | 会議アプリの自動の選択 |
|---|---|---|---|
| `SCShareableContent` で直接 | 画面収録の許可（起動したアプリに付く） | 1 か月ごとの確認（macOS 15〜） | できる（bundle id で突き合わせ） |
| ピッカー | 許可が要るかは未確認 | セッションごとにウィンドウを選ぶ | できない（除外の指定だけ） |
| エンタイトルメント | 画面収録の許可 | 確認なし | できる。ただし VNC 向けの申請制で、通る見込みが低い |

「使い方の前提を課さない」方針に近いのは 1 つ目（初回の許可と月 1 回の確認だけで、毎回の操作は増えない）。共有画面の許可が無い・拒否されたときは、共有画面を取らずに音だけで続ける作りにすれば、前提にはならない。

## 会議アプリごとのウィンドウ構成

Zoom・Teams は公式ヘルプの記述、Meet は Google の公式ヘルプとブログの記述。いずれも、相手の共有をどう見せるかを利用者が変えられる。

### Zoom（デスクトップアプリ、`us.zoom.xos`）

- 既定では、相手の共有画面は会議ウィンドウの中に出る。共有を見ている参加者は「横並び（side-by-side）」に切り替えられ、共有画面と話者・ギャラリーの表示を 1 つのウィンドウに並べる。設定の「画面の共有」で、共有が始まったら自動で横並びにできる。横並びを抜けると、映像のサムネイルは、ウィンドウ表示なら共有画面の上、全画面なら右上に重なる（[Side-by-side mode for screen sharing](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067526)）。
- 「デュアルモニターを使用」を有効にすると、モニターごとに Zoom のウィンドウが 1 つずつ出て、映像のレイアウトと共有画面が別のウィンドウに分かれる。この設定では横並びは使えない（[Using the dual monitors display](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064500)、KB0067526）。
- 取り込み側から見ると、既定では共有画面は会議ウィンドウの一部（サムネイルや帯と一緒）に映る。ウィンドウ単位では共有画面だけを切り出せない。デュアルモニターのときは、共有画面のウィンドウが別にできる。

### Microsoft Teams（デスクトップアプリ）

- 相手の共有画面（画面共有・PowerPoint Live・ホワイトボード）は、デスクトップ版では「新しいウィンドウで開く」で別ウィンドウに出せる。共有画面は拡大・縮小やドラッグで見る範囲を変えられる（[Share content in Microsoft Teams meetings](https://support.microsoft.com/en-au/office/share-content-in-a-meeting-in-teams-fcc2bf59-aecd-4481-8f99-ce55dd836ce8)）。
- 会議ウィンドウを最小化すると、隅に小さな会議ウィンドウが出て、話者・共有画面・参加者を出す（[Multitask during a Microsoft Teams meeting](https://support.microsoft.com/en-US/teams/meetings/multitask-during-a-microsoft-teams-meeting)）。
- 取り込み側から見ると、共有画面は会議ウィンドウの中か、利用者が開いた別ウィンドウに映る。利用者が拡大していれば、共有画面の一部しか映らない。チャットやメモも別ウィンドウにできるので、Teams のウィンドウが複数あっても共有画面とは限らない。

### Google Meet（ブラウザ）

- Meet はブラウザのタブで動く。ウィンドウの持ち主はブラウザ本体（上の Chrome の観察）。ウィンドウのタイトルは前面のタブのタイトル。
- **利用者が同じウィンドウで別のタブに切り替えると、そのウィンドウには Meet ではなく別のページが映る**（ウィンドウの取り込みは、ウィンドウに描かれているものを取る。背景のタブは描かれない）。そのまま Claude に送ると、会議と関係のない画面を送ることになる。タイトルが Meet のタブのものかを見て、違えば取らない、といった守りが要る。
- Chrome では、タブを切り替えたときや画面を共有したときに、自動で「ピクチャー イン ピクチャー」（Meet の UI の小さな浮いたウィンドウ）になる設定がある。Chrome のパソコン版だけ（[Use picture-in-picture with Google Meet](https://support.google.com/meet/answer/13665919)）。
- 2026 年 2〜3 月から、共有画面を「新しいウィンドウで開く」で単独のウィンドウにできる（[Google Workspace Updates 2026-02](https://workspaceupdates.googleblog.com/2026/02/move-shared-content-in-google-meet-to.html)）。そのウィンドウもブラウザ本体が持つはず（未確認）。
- 表示の形（スポットライト・サイドバー・タイル）でも、共有画面の大きさが変わる。共有画面の固定を外すと、タイルの 1 枚として小さく映る（[Learn about the Meet layout for your computer](https://support.google.com/meet/answer/10550593?hl=en)）。
- 音のプロセスタップは、ブラウザを選ぶとブラウザ全体の音になる（Meet のタブだけには絞れない。`docs/knowledge/2026-09-30.md` の 4）。画面も同じく、ブラウザ単位でしか選べない。別のブラウザのウィンドウで会議と関係ないページを開いていれば、それも候補に入る。

### まとめると

- どのアプリも「選んだ会議アプリのウィンドウ」が 1 つとは限らない。候補は、大きさ・タイトル・画面上にあるかで絞り、最後は「共有画面らしさ」（下）で選ぶことになる。
- 会議アプリが共有画面を別ウィンドウに出す設定（Zoom のデュアルモニター、Teams・Meet の新しいウィンドウ）のときは、そのウィンドウだけを取れば、顔のサムネイルが混ざらない。既定の設定では、共有画面は会議ウィンドウの一部として取ることになる。

## 共有画面が無いとき（顔だけ）の見分け

- 会議アプリが「いま相手が共有している」を外のアプリに知らせる公開の手段は、Apple の API にも各社の公式ヘルプにも見つからなかった（Zoom・Teams・Meet の会議の SDK は、自分で会議に参加するアプリ向けで、利用者のデスクトップアプリの状態は読めない）。
- 手がかりの候補（どれも未検証）:
  - **ウィンドウの増減とタイトル**: 共有画面を別ウィンドウに出す設定では、共有の開始・終了でウィンドウが増減する。`SCShareableContent` を取り直せば分かる。既定の設定では増減しない。
  - **画像の中身**: 文字の量（ローカル OCR、Vision）や、顔の検出（Vision の顔の矩形）の割合で、スライドか顔の並びかを推す。渡し方（画像／OCR の文字）を比べる試作と一緒に確かめられる。
  - **変化の仕方**: 顔の映像は常に細かく動き、スライドは止まっていて切り替わるときだけ大きく変わる。`SCFrameStatus` と `dirtyRects` の出方で、ある程度は分かれる見込み。
  - **アクセシビリティ API**: 会議アプリの UI の文言（例: 「〜の画面を表示しています」）を読む。公開 API だが、アクセシビリティの許可という別の権限が要り、文言はアプリの版と言語で変わる。
- 確実な判定は無いので、「共有画面が無いのに顔の画像を送り続ける」ことを費用と精度の両方で抑える作り（変わったときだけ・文字が無ければ送らない、など）が要る。#179 の「中身が変わったことの判定」と一緒に試作で決める。

## まだ確かめていないこと（試作で見る）

- ターミナルから起動したサーバーの子プロセスのヘルパーで、画面収録の許可の求め方と帰属先（音と同じく起動したアプリに付くか）
- 1 か月ごとの確認が、CLI のヘルパー（起動したアプリ）でも出るか、出るなら誰の名前で出るか
- Zoom・Teams の実機で、共有中・非共有中のウィンドウの数・大きさ・タイトル
- `desktopIndependentWindow` の絞り込みで、ほかのウィンドウに隠れた・別の操作スペースにある・最小化した会議ウィンドウがどう取れるか
- Meet のタブが前面にないときの、ウィンドウのタイトルと取れる画像
- ピッカー経由なら画面収録の許可が要らないか、CLI からピッカーを出せるか
