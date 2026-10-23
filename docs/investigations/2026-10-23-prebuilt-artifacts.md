# ビルド済みの成果物を配って初回のビルドを省く方法と、要るもの（Issue #1417）

地図 [#1415](https://github.com/daiki-beppu/live-mindmap/issues/1415)（初回インストール時のビルドを速くする）の調べ物。初回の準備でビルドしている AEC3 の静的ライブラリと helper の Swift ビルドを、ビルド済みの成果物を配ることで省けるかを、一次情報（Apple の開発者文書・DTS の回答、Swift Evolution の提案と SwiftPM のソース、GitHub の文書）で調べた。SwiftPM の挙動は、手元（Swift 6.4、Command Line Tools のみで Xcode なし、Apple Silicon）の小さな試作でも確かめた。

## 結論

- **AEC3 は `binaryTarget` で配れる。署名は要らない。** 静的ライブラリはリンクされて helper の実行ファイルに入り、署名はその実行ファイルに付くためだ。Apple の環境で文書が保証している形式は XCFramework で、作るには `xcodebuild -create-xcframework`（Xcode）が要る。artifact bundle の `staticLibrary`（SE-0482）は、提案の対象が Apple 以外の環境になっている。ただし macOS でも、手元の Swift 6.4 では動いた。どちらの形式でも、URL で取るときは `checksum` が必須になる。ビルドに 2 分半かかっている部分を、ダウンロード（`lib` の実測で 6.4 MB）に置き換えられる。
- **helper の実行ファイルを配る場合、要るものは取り方で決まる。** `curl`・Node の fetch・npm で取るなら quarantine が付かないので、リンカーが付ける ad-hoc 署名のまま動く（前例: AudioTee.js）。ブラウザで取ると quarantine が付き、ad-hoc 署名では Gatekeeper を通らない。その場合は、Developer ID 署名・Hardened Runtime・secure timestamp・公証がすべて要る。そのために Apple Developer Program（年 99 USD、Account Holder が証明書を作る）に入る必要がある。
- **TCC の許可は、いまの起動の経路では helper の署名に結び付かない。** ターミナルから起動したコマンドの子プロセスについては、TCC は「責任のあるコード」としてターミナルを見る（DTS の回答）。このため、helper を手元でビルドし直しても、配った版に差し替えても、画面収録・マイク・システム音声の許可を出し直す必要はない。注意点は 2 つある。この判定の手順は文書化されておらず、変わりうる。また、日本語の音声認識モデルの状態は、署名の識別子ごとに分かれる（過去の実測）。配る版でも識別子を `live-mindmap-helper` のまま保てば、影響はない。
- **FluidAudio をビルド済みで取る手段は、今のところ無い。** FluidAudio はバイナリを公開していない。SwiftPM の prebuilts は swift-syntax 専用で、Swift のライブラリをバイナリで配る形（SE-0482）も対象外になっている。自分で XCFramework（library evolution 付き）を作れば配れるが、Xcode を使うビルドを保守し続けることになる。FluidAudio のビルドを省きたいなら、helper の実行ファイルごと配るほうが筋がよい。
- **似た構成の前例**: AudioTee.js は、Core Audio tap の Swift CLI を ad-hoc 署名のまま npm で配り、Node から子プロセスとして起動している。許可はターミナルに与えるよう案内している。aperture-node（ScreenCaptureKit）と get-windows は、公開時に `swift build` したユニバーサルバイナリを npm パッケージに入れている。FluidAudio 自身も、Rust の静的ライブラリを XCFramework にして、GitHub Releases から URL と checksum で取っている。

## 1. AEC3 の静的ライブラリを `binaryTarget` で取る

### いまの形

`helper/scripts/build-webrtc-apm.sh` は、固定コミット（`d0569cf…`）の webrtc-audio-processing を meson で静的ビルドする。できた `.a` を `helper/.deps/webrtc-apm/lib/`（23 本、手元で 6.4 MB、arm64 のみ）に、ソースとヘッダーを `src/`（23 MB）に置く。`Package.swift` の `CWebRTCAPM` は C++ のシム（`apm.cpp`）を source としてビルドする。このとき `unsafeFlags` で `-I…/src` などのヘッダーの場所を渡し、`linkerSettings: .unsafeFlags([...*.a])` で `.a` をリンクしている。

### SwiftPM が受け付ける形

- `binaryTarget(name:url:checksum:)` と `binaryTarget(name:path:)` の 2 つがある。URL の形では、成果物を zip にして、その中の最上位に置く。`checksum` は `swift package compute-checksum <zip>` で計算する。同じ版のまま checksum が変わったときは、依存の解決でエラーにする（[SE-0272](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0272-swiftpm-binary-dependencies.md) の Checksum computation と Detailed design）。path の形では、zip のほか、展開したままのディレクトリも置ける。
- Apple の環境向けの形式は XCFramework で、動的ライブラリと静的ライブラリのどちらも入れられる（SE-0272）。PackageDescription のソースのコメントにも「Binary targets are only available on Apple platforms」とある（[Target.swift](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Runtimes/PackageDescription/Target.swift)）。
- artifact bundle（`.artifactbundle/info.json`、`supportedTriples` で変種を選ぶ）は [SE-0305](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0305-swiftpm-binary-target-improvements.md) で入った。当初は実行ファイル用だった。[SE-0482](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0482-swiftpm-static-library-binary-target-non-apple-platforms.md)（Swift 6.2 で実装）が、これに `staticLibrary` の型（`headerPaths`・`moduleMapPath`）を足した。提案の題目は「non-Apple platforms」で、対象は C の API を持ち C の標準ライブラリだけに依存するライブラリとされている。
- SwiftPM の実装（`SPMBuildCore/BinaryTarget+Extensions.swift` の `parseLibraryArtifactArchives`）は、`supportedTriples` が一致するかしか見ておらず、Darwin を除外する処理はない。

### 手元での試作（Swift 6.4）

C++（`std::vector`・`std::string`）で書いた `extern "C"` の関数を `.a` にした。それを `staticLibrary` の artifact bundle（`supportedTriples: ["arm64-apple-macosx"]`、`include/module.modulemap`）にして、`binaryTarget(path:)` で Swift の実行ファイルから呼んだ。結果は次のとおり。

- `swift build` は通り、実行結果も正しかった。C++ の標準ライブラリは `linkerSettings: [.linkedLibrary("c++")]` で足りた（`unsafeFlags` は使っていない）。
- zip にすると、`swift package compute-checksum` で SHA-256 の 16 進が得られた。
- 試作は `// swift-tools-version: 6.2` で書いた。helper の `Package.swift` は 6.0 なので、6.0 の manifest のままで `staticLibrary` が読めるかは確かめていない。
- この Mac には Xcode が無く、`xcodebuild` が使えない。XCFramework は手元では作れず、試していない。CI の `macos-26` runner には Xcode がある。

### `unsafeFlags` との関係

`unsafeFlags` の害は、それを使った target を含む product が、他のパッケージから依存として使えなくなる点にある（[BuildSettings.swift](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Runtimes/PackageDescription/BuildSettings.swift) のコメント）。helper はルートのパッケージなので、いまも支障は無い。`binaryTarget` に移ると、`.a` のリンクとヘッダーの場所は SwiftPM が渡すようになり、`unsafeFlags` の大半が要らなくなる。

### `Package.swift` の書き方の候補

1. **シムまで含めてビルド済みにする（推奨の候補）**: `apm.cpp` もビルド済みに含める。webrtc の `.a` と合わせて 1 本の `.a` にまとめ（`libtool -static`）、公開するヘッダーは `CWebRTCAPM.h` だけにする。こうすると、webrtc のヘッダー（`src/` の 23 MB）を配らずに済み、`unsafeFlags` も無くなる。

   ```swift
   .binaryTarget(
       name: "CWebRTCAPM",
       url: "https://github.com/daiki-beppu/live-mindmap/releases/download/webrtc-apm-<版>/CWebRTCAPM.artifactbundle.zip", // または .xcframework.zip
       checksum: "<swift package compute-checksum の値>"
   ),
   .target(name: "HelperCore", dependencies: ["CWebRTCAPM", ...], linkerSettings: [.linkedLibrary("c++")]),
   ```

   この形には代償がある。`apm.cpp` を変えるたびに、成果物を作り直して公開し、checksum を書き換えなければならない。手元で直して試すときは、`path:` の形かいまの source の target に切り替える仕組みが別に要る。
2. **webrtc の `.a` とヘッダーだけをビルド済みにする**: シムは source のまま残す。ヘッダーは `headerPaths` で渡す（`src`・`src/webrtc`・`build` の設定ヘッダー・abseil の 4 か所、いまの `-I` と同じ）。シムを変えても成果物は作り直さずに済む。代わりに、ヘッダー一式（数十 MB）を配ることになる。

どちらの形でも、成果物の版（`build-webrtc-apm.sh` の `COMMIT`）とリリースのタグを揃える必要がある。また、配布物は 1 つにまとめる必要がある（いまの 23 本の `.a` は、どちらの形式でも 1 本にまとめるか、変種ごとに並べる）。

### 配る場所と作る場所

- GitHub Releases に置ける容量は 1 ファイル 2 GiB 未満で、リリースの合計と帯域には上限が無い（[About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)）。
- このリポジトリは public で、標準の GitHub-hosted runner は public リポジトリでは無料・無制限に使える。`macos-26`（arm64）がある（[GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)）。CI の `check.yml` でも、すでに `macos-26` を使っている。
- URL の形の `binaryTarget` は、取得した成果物を SwiftPM の共有キャッシュ（`<sharedCacheDirectory>/artifacts`、既定では `~/Library/Caches/org.swift.swiftpm`）にも置く（`Workspace+Configuration.swift`）。地図の Notes に従い、測るときは `--cache-path` で別の場所に向ける。

## 2. helper の実行ファイル（`live-mindmap-helper`・`live-mindmap-apple`）そのものを配る

### いまの署名

`swift build -c release` が作る `live-mindmap-helper` は、リンカーが付ける ad-hoc 署名になっている（`codesign -dv` で `flags=0x20002(adhoc,linker-signed)`、`Identifier=live-mindmap-helper`、`TeamIdentifier=not set`）。designated requirement は `cdhash H"…"`、つまりこの版のバイト列そのものだ。なお debug ビルドの識別子は `live-mindmap-helper-<hash>` で、release とは違う。

### 署名・quarantine・Gatekeeper

- Apple Silicon の Mac では、実行ファイルに署名が無いと実行できない。ただし ad-hoc 署名で足り、署名した Mac とは別の Mac でも検証は通る。一方で、身元を持たない署名なので「cannot pass through Gatekeeper」とされている（[macOS Big Sur 11.0.1 Universal Apps Release Notes](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes)）。
- quarantine を付けるのは、利用者向けのアプリ（Safari など）だ。`curl`・`scp` は、取ったファイルに quarantine を付けない。`tar`・`unzip` は、展開したファイルに quarantine を引き継がない。quarantine が付いたアプリを起動すると、必ず Gatekeeper が走る。それ以外のときに走る条件は文書化されておらず、変わりうる（DTS の Quinn「[Resolving Trusted Execution Problems](https://developer.apple.com/forums/thread/706442)」）。アプリが自分で作るファイルに quarantine を付けるかどうかは、`LSFileQuarantineEnabled` で決まる（[LSFileQuarantineEnabled](https://developer.apple.com/documentation/bundleresources/information-property-list/lsfilequarantineenabled)）。
- このため、**サーバーや CLI が Node の fetch で取る形や、npm の tarball に入れる形なら、ad-hoc 署名のままで動く見込みが高い**。Node・npm は利用者向けのアプリではなく、`curl` と同じ側にある。ただし、これは上の文書からの推論で、実機では確かめていない（取った後に `xattr -l` で quarantine が無いかを見ればわかる）。**README からブラウザでダウンロードさせる形では、Gatekeeper に止められる。**

### 公証（notarization）

- 公証に要るもの: すべての実行ファイルを Developer ID の証明書で署名すること（ad-hoc・Apple Development の証明書は不可）、Hardened Runtime、secure timestamp、`get-task-allow` を付けないこと（[Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)）。macOS 10.15 以降、Developer ID で配るソフトウェアは公証が必須になっている。
- 単体の実行ファイルにもチケットは発行されるが、staple（チケットを成果物に綴じ込むこと）はできない。zip も staple できない（[Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)）。zip で配る場合、Gatekeeper はオンラインでチケットを確かめる。オフラインでも通したいなら、pkg か dmg に入れて staple する。
- Hardened Runtime を有効にすると、マイクを使うのに `com.apple.security.device.audio-input` の entitlement が要る（[Audio Input Entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)）。ほかに要る entitlement があるかは、実機で洗い出す必要がある。
- 提出には `notarytool` を使う（Xcode 14 以降）。CI でやるなら、`macos-26` runner に証明書と App Store Connect の資格情報を secrets として置くことになる。

### 費用

- Apple Developer Program は年 99 USD（現地通貨のある地域ではその通貨）で、非営利団体・教育機関・政府機関は免除を申請できる（[What's included](https://developer.apple.com/programs/whats-included/)）。
- Developer ID の証明書を作れるのは、Apple Developer Program のチームの Account Holder に限られる（[Developer ID](https://developer.apple.com/developer-id/)）。

### 実行ファイルを配るときに別に要るもの

- 配った版と手元のソースが一致するかを見分ける鍵（たとえば helper のソースと `Package.resolved` のハッシュ）が要る。helper を変えた開発者は、これまでどおりビルドする。
- server は `helper/.build/release/live-mindmap-helper` の固定のパスから helper を起動している（`server/src/helperPath.ts`、`server/src/appleIntelligence.ts`）。置き場所を決めて、このパスとの関係も決める必要がある。
- テスト（`pnpm typecheck` の debug ビルドとテスト）は、配った成果物では省けない。地図の対象（README の手順から `pnpm dev` まで）に含まれるかを確かめる必要がある。

## 3. TCC の許可と実行ファイルの署名

- **designated requirement（DR）**: コードが「次に会ったときに自分だと見分ける方法」を表したもの。ad-hoc 署名のコードにも DR はあるが、その版に結び付いている。このため macOS は版をまたいでコードを追えない。たとえば、署名しない試作アプリがマイクを使うと、コードを変えて動かすたびに許可を聞き直される（[TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)）。Developer ID で署名したコードの DR は、識別子とチームで決まる。このため版を更新しても同じコードとして扱われ、許可も引き継がれる（同じ TN3127 の Mac App Store 版と Developer ID 版の例）。
- **責任のあるコード（responsible code）**: TCC は、許可を誰のものとして扱うかを「責任のあるコード」で決める。ターミナルから利用者が起動したツールではターミナル、アプリが子プロセスとして起動した helper ではそのアプリになる。ただし、この手順は文書化されておらず、過去に変わったことがあり、今後も変わりうる（DTS の Quinn、[How to grant command line tools full disk access](https://developer.apple.com/forums/thread/756510)）。
- **このリポジトリでの実測（2026-10-09 の開発ログ）**: helper には Info.plist が無く、許可は起動元（ターミナルなど）のものとして扱われた。一度も許可を求めたことのない新しいプログラムでも同じだった。いまの画面の文言（「システム設定で、起動したターミナルに許可を与え、ターミナルを開き直す」）も、これに合わせてある。
- **したがって**: 経路が「ターミナル → `pnpm dev`（Node）→ helper」である限り、TCC が見るのはターミナルの署名だ。helper を手元でビルドし直したとき（ad-hoc で cdhash が変わる）も、配った版に差し替えたときも、画面収録・マイク・システム音声（Core Audio tap は `NSAudioCaptureUsageDescription` を要求し、初回の録音時に聞かれる。[Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)）の許可は出し直さなくてよい。
- **署名が効いてくる場合**: helper を `.app` にする、`launchd` から起動する、Mac アプリから起動する、のいずれかで helper 自身（またはそのアプリ）が責任のあるコードになる場合だ。そのときは ad-hoc 署名だと再ビルドのたびに許可を出し直すことになり、Developer ID 署名なら更新しても許可が引き継がれる（TN3127）。
- **別の注意**: SpeechAnalyzer の日本語モデルの状態（`AssetInventory`）は、署名の識別子ごとに分かれる。新しい識別子では「ダウンロードが要る」と返った（同じ開発ログ）。配る版も識別子を `live-mindmap-helper` にしておけば（`codesign --identifier`）、手元のビルドと同じ扱いになる見込みだ。なお、識別子以外（チームなど）も見ているかは確かめていない。

## 4. FluidAudio など SwiftPM の依存をビルド済みで取る

- FluidAudio（固定コミット `ea63ac3`、Swift のファイル 380 本）の GitHub Releases にはバイナリが無い（v0.17.7 の assets は空）。`Package.swift` も source の target だけを公開している。
- SwiftPM の prebuilts（依存のビルド済みを自動で取る機能）が扱うのは swift-syntax だけだ（`Workspace+Prebuilts.swift` に「Currently only supports swift-syntax for macros」とある）。Swift 6.2 からは既定で有効になっている（[Swift Forums: Swift-Syntax Prebuilts for Macros](https://forums.swift.org/t/preview-swift-syntax-prebuilts-for-macros/80202)）。
- Swift のライブラリをバイナリで配る形（`.swiftinterface` 付きの静的ライブラリ）は、SE-0482 の Future directions に挙がっているだけで、まだ実装されていない。Apple の環境で今できるのは、library evolution を有効にして Xcode で作る XCFramework だけになる。これを自前で保守する（FluidAudio を上げるたびに作り直す）なら、FluidAudio だけを配るより、helper の実行ファイルごと配るほうが手間は小さい。
- 参考: FluidAudio は、依存の一部（`NemoTextProcessing`。Rust の `text-processing-rs` を静的ライブラリにしたもの）を、すでに XCFramework の `binaryTarget`（URL と checksum）で取っている。helper のビルドでも、この部分はダウンロードで済んでいる（`.build/artifacts/fluidaudio/NemoTextProcessing`）。

## 5. 似た構成の前例

| 前例 | 何を配るか | 署名 | 許可の扱い |
|---|---|---|---|
| [AudioTee.js](https://github.com/makeusabrew/audioteejs)（[AudioTee](https://github.com/makeusabrew/audiotee) の Node 版） | Core Audio tap の Swift CLI のユニバーサルバイナリを npm に同梱し、Node から子プロセスとして起動 | ad-hoc。Electron に同梱するときは親の署名に入れる。単体で配るなら Developer ID を勧めている | システム音声の許可は、使っているターミナルに与えるよう README で案内している（iTerm や VS Code のターミナルでは、許可を聞かれずに無音になることがある） |
| [aperture-node](https://github.com/wulkano/aperture-node)（画面収録） | `prepublish` で `swift build --arch arm64 --arch x86_64` したバイナリを npm に同梱 | 公開時のビルドのまま | — |
| [get-windows](https://github.com/sindresorhus/get-windows) | macOS 用は `swift build` したバイナリ `main` を npm に同梱 | 公開時のビルドのまま | — |
| FluidAudio の `NemoTextProcessing` | Rust の静的ライブラリの XCFramework を GitHub Releases に置き、`binaryTarget(url:checksum:)` で取る。作るのは `build-xcframework.sh` の `xcodebuild -create-xcframework` | 静的ライブラリなので不要 | — |

（aperture-node と get-windows は、`package.json` の scripts と files で確かめた。npm 経由での quarantine の有無は、各リポジトリには書かれていない。）

## 確かめていないこと

- `swift-tools-version: 6.0` の manifest で、`staticLibrary` の artifact bundle が読めるか（試作は 6.2）。
- Node の fetch や npm で取った実行ファイルに quarantine が付かないこと（Quinn の説明からの推論）。
- Developer ID で署名し Hardened Runtime を有効にした helper が、ScreenCaptureKit・Core Audio tap・SpeechAnalyzer・FluidAudio（Core ML）で、`audio-input` 以外の entitlement を要求するか。
- 署名し直した helper でも、日本語モデルの状態がそのまま「入っている」と返るか。
