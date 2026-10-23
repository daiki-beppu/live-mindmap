# ビルド済みの成果物を配って初回のビルドを省く方法と、要るもの（Issue #1417）

map #1415（初回インストール時のビルドを速くする）の調査。clone したばかりの Mac で README の初回の手順（`pnpm install` → `build-webrtc-apm.sh` → `fetch-speaker-models.sh` → `pnpm dev`）が走らせるビルドのうち、AEC3 の meson ビルドと helper の Swift のビルドを、ビルド済みの成果物を配って省く手を、一次情報（swift-package-manager のソースと proposal、Apple の公式ドキュメントと DTS の回答、GitHub Docs、各 OSS のソース）と手元の試し（scratch のディレクトリ。利用者のグローバルなキャッシュ・TCC には触れていない）で確かめた。どれを採るかは決めない（grilling の ticket で決める）。結論は次のとおり。

- **AEC3 は `binaryTarget` の xcframework で配れる。手元で組んで、helper の release ビルドが通ることを確かめた。** 23 個の `.a` を `libtool -static` で 1 つ（6.7 MB）にまとめ、ヘッダー（`.h` と `.inc`、686 個・6.1 MB）を `Headers` に入れた xcframework（zip で 4.2 MB）を `.binaryTarget(name:path:)` にすると、SwiftPM がヘッダーを `.build/…/Products/Release/include` に写してインクルードパスに足し、`.a` もリンクする。C++ のシム `CWebRTCAPM` はそれに依存するだけで、**`unsafeFlags` は要らなくなる**（`-std=c++17` は `cxxLanguageStandard: .cxx17`、`-D` は `.define`）。module map は要らない（Swift から直接 import せず、シムの C++ が `#include` するだけのため）。FluidAudio 自身が同じ形（Rust の静的ライブラリ＋ヘッダーの xcframework を GitHub Releases から `binaryTarget(url:checksum:)` で取る）をすでに使っている（[AEC3 を binaryTarget にする](#aec3-を-binarytarget-にする)）。
- **remote の `binaryTarget` は zip と SHA-256 の checksum が要り、Apple のプラットフォームだけで使える。** checksum は `swift package compute-checksum` の値（`shasum -a 256` と同じ値になった）。版を上げるたびに URL と checksum の 2 行を `Package.swift` で書き換える。`xcodebuild -create-xcframework` は Xcode が要り、この Mac（Command Line Tools だけ）では動かなかった。Info.plist を手で書いても SwiftPM は受け付けた。
- **`binaryTarget` にしなくても、`build-webrtc-apm.sh` が `helper/.deps/webrtc-apm` を固定版の tarball から展開するだけでも同じだけ縮む。** `Package.swift` は今のまま（`unsafeFlags` も残る）。checksum の照合はスクリプトで行う。
- **helper の実行ファイルそのものを配る場合、curl や Node の `fetch` で落とすなら、Gatekeeper・公証・Developer ID は要らない。** 落としたファイルに `com.apple.quarantine` は付かなかった（手元で確認。付いたのは `com.apple.provenance` だけ）。Gatekeeper は quarantine が付いたものにしか働かない（Apple DTS）。Apple Silicon で要るのは署名があることだけで、ad-hoc 署名で足りる（Apple のリリースノート）。今のビルドの成果物はリンカーが ad-hoc 署名済み（`flags=0x20002(adhoc,linker-signed)`）で、署名を外すと SIGKILL（exit 137）で止まることも確かめた。ブラウザで落とした zip を展開した場合は quarantine が付き、ad-hoc 署名では Gatekeeper を通らない。macOS 15 からは Control-クリックで開けず、システム設定で許可する手順になる（[実行ファイルを配る](#helper-の実行ファイルを配る)）。
- **Developer ID と公証を使うなら、Apple Developer Program（年 99 USD）の Account Holder が要る。** 公証には Developer ID の署名・Hardened Runtime・secure timestamp が要り、単体の実行ファイルには ticket を staple できない（zip ごと公証して、Gatekeeper はオンラインで ticket を引く）。公証は Xcode の `notarytool` で行うので、署名と公証は CI（Xcode のある macos ランナー）に置くことになる。
- **画面収録・システム音声・マイクの許可は、helper ではなく起動元のターミナル（responsible process）に付く。だから、手元でビルドし直しても、配った版に差し替えても、利用者は許可をやり直さない。** helper は Info.plist を持たず（`Info.plist=not bound`）、ADR 0002 と helper の README のとおり権限はターミナルに付いている。helper の署名の DR は `cdhash H"…"` で、ビルドのたびに変わる（TN3127 は ad-hoc 署名のコードの DR は「その版に結び付く」ので許可を版をまたいで覚えられない、と書く）。helper が自分で responsible process になる形（`open` で起動する .app にする等）に変えたときだけ、署名の識別が効いてくる（[TCC の許可と署名](#tcc-の許可と署名)）。
- **FluidAudio をビルド済みで取る手は、上流には無い。** FluidAudio の GitHub Releases に成果物（xcframework）は無く、SwiftPM の「prebuilts」は macro 用の swift-syntax だけが対象。自前で Swift のライブラリを xcframework にするには library evolution と Xcode が要る。helper の実行ファイルごと配れば FluidAudio のビルドも消えるので、FluidAudio だけを別に配る利点は小さい。
- **似た構成の前例がある。** `audiotee`（Core Audio taps でシステム音声を取る Swift の CLI を Node から子プロセスで起動する npm パッケージ）と `aperture`（Kap の画面収録。Swift の CLI を npm に同梱）は、ad-hoc 署名のビルド済みバイナリを npm で配っている。audiotee の README は、Node から起動したときに許可が付くのはターミナルだと書いている。
- **配るならライセンスの文言を同梱する。** webrtc-audio-processing（BSD-3-Clause と WebRTC の PATENTS）、その中の third_party（Ooura の FFT・pffft（FFTPACK）・rnnoise（BSD-3）・`modules/third_party/fft`・`spl_sqrt_floor`）、abseil（Apache-2.0）、FluidAudio（Apache-2.0）と FluidAudio が同梱する第三者（NemoTextProcessing ほか、`ThirdPartyLicenses/`）は、いずれも再配布できるが、バイナリで配るときは著作権表示と許諾文を添える条件がある。Apache-2.0 の abseil と FluidAudio に NOTICE ファイルは無かった。
- **初回の時間の見込み。** AEC3 を配れば meson のビルド（約 2 分半、`orca.yaml` のコメントの値）が数 MB のダウンロードに置き換わり、`uv` も前提から外せる。helper の実行ファイルまで配れば、`pnpm dev` の release ビルドと `fetch-speaker-models.sh` の debug ビルド（`swift run`）も消える。この Mac での release のクリーンビルドは 745 秒（他の作業で load average が 50〜80 の状態。CPU の user 時間は 460 秒）で、そのうち FluidAudio だけで 571 秒（user 320 秒）かかった。AEC3 より helper の Swift のビルド、とくに FluidAudio が大きい（[初回の時間の見込み](#初回の時間の見込み)）。

## 今の初回の手順で走るビルド

README.md の Getting started（README.ja.md は手順の詳細を各節に置く）:

```sh
pnpm install
bash helper/scripts/build-webrtc-apm.sh        # once: WebRTC audio-processing library
bash helper/scripts/fetch-speaker-models.sh    # once: speaker-diarization models
pnpm dev                                     # builds the helper, starts the server and the view
```

- `build-webrtc-apm.sh`: freedesktop の `webrtc-audio-processing` を固定コミット（`d0569cf…`）で取り、`uvx` の meson / ninja で静的ライブラリにビルドして `helper/.deps/webrtc-apm/lib` に 23 個の `.a` を平らに集める。abseil のヘッダーの場所に `abseil` のシンボリックリンクを張る。
- `fetch-speaker-models.sh`: `swift run --quiet live-mindmap-helper install-speaker-models`。debug の構成で helper を丸ごとビルドする。
- `pnpm dev`: `server` の `dev` が `swift build -c release --package-path ../helper` の後でサーバーを起動する。サーバーは `helper/.build/release/live-mindmap-helper`（`server/src/helperPath.ts`）と `helper/.build/release/live-mindmap-apple`（`server/src/appleIntelligence.ts`）を起動する。`LIVE_MINDMAP_HELPER` で helper の場所を差し替えられる。
- 開発者が `pnpm typecheck` を走らせると、`swift build --build-tests`（debug＋テスト）がもう 1 構成増える。

`Package.swift` は AEC3 を `unsafeFlags` で参照している。`cxxSettings` に `-I<.deps>/src`・`-I<.deps>/src/webrtc`・`-I<.deps>/build`・`-I<.deps>/abseil` と `-std=c++17`・`-DWEBRTC_POSIX`・`-DWEBRTC_MAC`・`-DWEBRTC_APM_DEBUG_DUMP=0`、`linkerSettings` に 23 個の `.a` の絶対パス。

release の成果物（`helper/.build/release/`）のうち、実行に要るのは `live-mindmap-helper`（20 MB、arm64）・`live-mindmap-apple`・`FluidAudio_FluidAudio.bundle`（1 MB）。`otool -L` で見ると、リンクしている動的ライブラリは OS のもの（`/System/Library/Frameworks/…`・`/usr/lib/swift/…`・`libc++`）だけで、配ったファイルのほかに要るものは無い。3 つを zip にすると 11 MB。

## AEC3 を binaryTarget にする

### SwiftPM の決まり

- binary target は Apple のプラットフォームだけで使え、形式は XCFramework（[SE-0272](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0272-swiftpm-binary-dependencies.md)）。PackageDescription のドキュメントコメントも「Binary targets are only available on Apple platforms.」（[`Target.swift`](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Runtimes/PackageDescription/Target.swift)）。
- URL で指すときは `binaryTarget(name:url:checksum:)`。URL は「an archive file that contains a binary artifact in its root directory」を指す。SE-0272 は「SwiftPM expects url-based artifacts to be packaged inside a `.zip` file」。checksum については「Always run `swift package compute-checksum path/to/MyFramework.zip` at the command line to make sure you create a correct SHA256 checksum.」（`Target.swift`）。SE-0272 は、成果物のハッシュを `Package.resolved` にも残して黙って差し替わるのを防ぐ、と書く。
- ローカルのパスで指すときは `binaryTarget(name:path:)`。パスは成果物そのものか、それを含む zip でもよい（`Target.swift`）。
- artifact bundle（[SE-0305](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0305-swiftpm-binary-target-improvements.md)、Swift 5.6）は実行ファイル用で、使い道はパッケージのプラグインから呼ぶこと。静的ライブラリを artifact bundle に入れる [SE-0482](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0482-swiftpm-static-library-binary-target-non-apple-platforms.md)（Swift 6.2）は Apple 以外のプラットフォーム向けで、対象は C の標準ライブラリにだけ依存する C のライブラリ。C++ の AEC3 には当てはまらないので、macOS では xcframework を使う。
- `unsafeFlags` について、PackageDescription のコメントは「the use of unsafe flags makes the products containing this target ineligible for use by other packages」（[`BuildSettings.swift`](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Runtimes/PackageDescription/BuildSettings.swift)）。helper はルートのパッケージで、他のパッケージから依存されないので、今の `unsafeFlags` が困ることは無い。binaryTarget にすると `unsafeFlags` そのものが要らなくなる（下の試し）。

### 前例: FluidAudio の NemoTextProcessing

helper が依存する FluidAudio（固定コミット `ea63ac3…`）の `Package.swift` は、Rust のライブラリを次のように取っている。

```swift
.binaryTarget(
    name: "NemoTextProcessing",
    url:
        "https://github.com/FluidInference/text-processing-rs/releases/download/v0.3.1/NemoTextProcessing.xcframework.zip",
    checksum: "5fa8c10d4ec26c1bb2413125f351a7222a4c68a23b74476680fbada7e26fc6aa"
),
```

展開された `helper/.build/artifacts/fluidaudio/NemoTextProcessing/NemoTextProcessing.xcframework` の中身は、`macos-arm64_x86_64/libtext_processing_rs.a` と `Headers/CNemoTextProcessing/{nemo_text_processing.h, module.modulemap}`、それを列挙する `Info.plist`（`LibraryPath`・`HeadersPath`・`SupportedPlatform`・`SupportedArchitectures`）。静的ライブラリ＋ヘッダーの xcframework を GitHub Releases から取る形は、今の helper のビルドですでに動いている。module map があるのは Swift から import するため。

ついでに分かったこと: この zip は 87 MB あり、helper の初回の依存の解決で毎回落としている（curl で取った値の SHA-256 が上の checksum と一致した）。Swift 6.2 以降が読む `Package@swift-6.2.swift` では、これは既定で有効な trait `NemoTextProcessing` で、依存する側が `.package(url: …, traits: [])` と書けば外せる（TTS と ITN 用で、helper の話者分離には使っていない）。ダウンロードの速さは map の範囲外なので、書き残すだけにする。

### 試し（scratch のディレクトリ）

1. 23 個の `.a` を 1 つにまとめた: `libtool -static -o libwebrtcapm.a helper/.deps/webrtc-apm/lib/*.a`（0.08 秒、6.7 MB、arm64 だけ）。`libwebrtc-audio-processing-2.a` は abseil のオブジェクトの一部をすでに含んでいて、`has no symbols` の警告が出るが、リンクは通った。1 つにまとめなくても、xcframework は 1 つの `LibraryPath` しか持てないので、1 つの xcframework に入れるなら libtool でまとめる必要がある（`.a` ごとに 23 個の xcframework を作る手もあるが、利点は無い）。
2. ヘッダーを 1 つのディレクトリに重ねた: 今の `-I` と同じ並びになるよう、`src/webrtc` の下（`api/…`・`modules/…`・`rtc_base/…` など）と `abseil` の下の `absl/…` を `Headers` に写した。最初は `.h` だけ写して、`absl/numeric/int128.h` が `#include` する `int128_have_intrinsic.inc` が無くて止まった。`.inc` も入れると通った（686 個・6.1 MB）。abseil のヘッダーは、ビルドしたときの設定（`absl/base/options.h` など）とライブラリが一致している必要があるので、同じビルドのものを同梱する。
3. xcframework を組んだ: `xcodebuild -create-xcframework` は「requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance」で動かなかったので、NemoTextProcessing と同じ形の `Info.plist`（`macos-arm64`、`libwebrtcapm.a`、`Headers`）を手で書いた。`ditto -c -k --keepParent` で zip にすると 4.2 MB。`swift package compute-checksum` の値は `shasum -a 256` と同じだった。
4. helper のソースを写し、`Package.swift` を次のようにした（`stt-bench` とテストのターゲットは外した）。

```swift
.target(name: "HelperCore", dependencies: ["CWebRTCAPM", .product(name: "FluidAudio", package: "FluidAudio")]),
.binaryTarget(name: "CWebRTCAPMBinary", path: "CWebRTCAPMBinary.xcframework"),
// 配るときは:
// .binaryTarget(name: "CWebRTCAPMBinary", url: "https://github.com/<owner>/<repo>/releases/download/<tag>/CWebRTCAPMBinary.xcframework.zip", checksum: "<compute-checksum の値>"),
.target(
    name: "CWebRTCAPM",
    dependencies: ["CWebRTCAPMBinary"],
    cxxSettings: [.define("WEBRTC_POSIX"), .define("WEBRTC_MAC"), .define("WEBRTC_APM_DEBUG_DUMP", to: "0")]
),
// …
cxxLanguageStandard: .cxx17
```

5. `swift build -c release --cache-path <scratch>`（依存の取得もやり直す）で `Build complete!`。ヘッダーは `.build/out/Products/Release/include/{absl,api,modules,…}` に写され（FluidAudio の `CNemoTextProcessing` と同じ場所に並ぶ）、できた `live-mindmap-helper` には `EchoCanceller3` のシンボルが 74 個入っていて、`--help` も動いた。テストは走らせていない。

気をつける点:

- **アーキテクチャ**: 今の `.a` は arm64 だけ。helper はビルドした Mac のアーキテクチャで作られるので、Intel の Mac で使うなら x86_64 も作って `lipo` でまとめる必要がある（xcframework の `SupportedArchitectures` に足す）。
- **ヘッダーの名前空間**: binary target のヘッダーは全部 `Products/<構成>/include` に平らに並ぶ。`api/`・`modules/` のような一般的な名前が、将来の別の依存とぶつかる余地はある。
- **版の上げ方**: AEC3 の固定コミットを上げるたびに、xcframework を作り直して Release に置き、`Package.swift` の URL と checksum を書き換える。作るのは Xcode のある環境（CI の macos ランナー）か、上の手書きの Info.plist。
- **worktree の setup**: `orca.yaml` の setup が本体の `helper/.deps/webrtc-apm` を写す処理は、binaryTarget なら SwiftPM のキャッシュ（`~/Library/Caches/org.swift.swiftpm/artifacts`）で済むので不要になる見込み（確かめていない）。

### binaryTarget にしない形: `.deps` を tarball で配る

`build-webrtc-apm.sh` が、ビルドする代わりに固定版の tarball（`lib/*.a` とヘッダー）を Release から取り、SHA-256 を照合して `helper/.deps/webrtc-apm` に展開する。`Package.swift`（`unsafeFlags` の `-I` とリンクのパス）は今のまま使える。ただし今の `-I` は `src`・`src/webrtc`・`build`・`abseil`（シンボリックリンク）の 4 か所を指すので、tarball の中の並びをそれに合わせるか、`-I` を 1 か所に寄せる。checksum の照合を SwiftPM ではなくスクリプトが受け持つ点と、`build-webrtc-apm.sh` を README の手順に残す点が binaryTarget との違い。

## helper の実行ファイルを配る

### 署名: Apple Silicon では ad-hoc 署名が要り、それで足りる

[macOS Big Sur 11.0.1 Universal Apps Release Notes](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes) の Code Signing:

> New in macOS 11 on Macs with Apple silicon, and starting in macOS Big Sur 11 beta 6, the operating system enforces that any executable must be signed before it's allowed to run. There isn't a specific identity requirement for this signature: a simple ad-hoc signature is sufficient.

> starting with Xcode 12 beta 4, the toolchain will now automatically sign your executables whenever you build from Xcode, or use command-line utilities such as `clang(1)` or `ld(1)`. … These new signatures are not bound to the specific machine that was used to build the executable, they can be verified on any other system … However, given that these signatures do not bear any valid identity, binaries signed this way cannot pass through Gatekeeper.

手元で確かめたこと:

- `codesign -dv helper/.build/release/live-mindmap-helper` は `flags=0x20002(adhoc,linker-signed)`・`Signature=adhoc`・`TeamIdentifier=not set`・`Info.plist=not bound`。`codesign -d -r-` の DR は `cdhash H"380487e2…"`。binaryTarget の試しで作った版は `cdhash H"91a9e3eb…"` で、ビルドごとに変わる。
- `live-mindmap-apple` を写して `codesign --remove-signature` すると、実行は exit 137（SIGKILL）で止まった。署名のあるコピーは動いた。
- `strip` や `install_name_tool` で後から書き換えると署名が壊れるので、配る前に加工するなら `codesign -s -` で付け直す（上のリリースノート）。

### Gatekeeper と quarantine: curl・Node の fetch では付かない

- Apple DTS（Quinn）の回答: 「Most Unix-y tools don't quarantine their downloads, including curl and scp.」「Gatekeeper usually only kicks in the app is quarantined」（[Apple Developer Forums 666452](https://developer.apple.com/forums/thread/666452)）。
- quarantine を付けるのは、Info.plist の `LSFileQuarantineEnabled` を持つアプリ（ブラウザなど）が作ったファイル（[LSFileQuarantineEnabled](https://developer.apple.com/documentation/bundleresources/information-property-list/lsfilequarantineenabled)）。
- 手元の確認（macOS 27.0.1、Orca のターミナル）: 同じ GitHub Releases の zip を `curl -L` と Node 24 の `fetch` → `fs.writeFileSync` で落とし、`xattr -l` で見た。どちらも `com.apple.provenance` だけで、`com.apple.quarantine` は無かった。
- 今の ad-hoc 署名のバイナリは `spctl -a -t exec` で `rejected`、`syspolicy_check distribution` で「Adhoc Signed App」「Notary Ticket Missing」になる。つまり、ブラウザで落として quarantine が付いた場合は Gatekeeper に止められる。Apple Platform Security の [Gatekeeper and runtime protection in macOS](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web) は、App Store の外から落としたソフトを初めて開くとき、識別された開発者のものか・公証済みかを確かめると書く。
- macOS Sequoia（15）から、正しく署名・公証されていないソフトは Control-クリックで開けず、「System Settings > Privacy & Security」で許可する（[Apple Developer News](https://developer.apple.com/news/?id=saqachfa)）。
- npm の tarball で配る場合も、取得は npm（Node）が行うので quarantine は付かない（下の前例はこの経路）。

### Developer ID と公証

- 公証は Developer ID で署名したソフトを Apple が自動で検査し、ticket を発行する仕組み。「Beginning in macOS 10.15, all software built after June 1, 2019, and distributed with Developer ID must be notarized.」要件は、Developer ID の証明書・Hardened Runtime・secure timestamp・`get-task-allow` を付けないこと（[Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)）。
- 提出できるのは zip・UDIF のディスクイメージ・flat installer package。「Although tickets are created for standalone binaries, it's not currently possible to staple tickets to them.」（[Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)）。単体の CLI は zip で公証し、Gatekeeper は初回の起動でオンラインの ticket を引く。`notarytool` と `stapler` は Xcode に入っている。
- Developer ID の証明書を作れるのは Apple Developer Program の Account Holder（[Developer ID](https://developer.apple.com/developer-id/)）。費用は「The Apple Developer Program is 99 USD per membership year. Prices may vary by region」（[Enrollment](https://developer.apple.com/programs/enroll/)）。
- Hardened Runtime を有効にすると、helper が使う機能（JIT など）に entitlement が要るかの確認が増える（Core ML・ScreenCaptureKit・Core Audio taps で要るかは確かめていない）。

まとめると、配り方で要るものが変わる。

| 取り方 | quarantine | 要る署名 | Developer Program |
|---|---|---|---|
| `pnpm dev` や setup のスクリプトが curl / Node の `fetch` で落とす | 付かない | ad-hoc（リンカーの署名のまま） | 要らない |
| npm のパッケージに同梱する | 付かない | ad-hoc | 要らない |
| 利用者がブラウザで Release のページから落とす | 付く | Developer ID＋公証（無ければシステム設定で許可） | 要る（年 99 USD） |

### 配った版を置く場所と、改ざんの確かめ

- GitHub Releases は「Each file included in a release must be under 2 GiB. There is no limit on the total size of a release, nor bandwidth usage.」（[About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)）。
- immutable releases を有効にすると「Release assets cannot be modified or deleted」、タグもコミットに固定され、release attestation が自動で作られる（[Immutable releases](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases)）。ad-hoc 署名には発行者の識別が無いので、落とした側の確かめは、リポジトリに固定した SHA-256 と照合する形になる（binaryTarget の checksum と同じ考え）。
- サーバーは `helper/.build/release/…` を既定の場所として起動する。配った版を使うなら、置き場所（`helper/.build` ではない別の場所にするか）と、`server` の `dev` が毎回走らせる `swift build -c release` をどうするか（`LIVE_MINDMAP_HELPER` を使う・既定の場所を変える）を決める必要がある。`fetch-speaker-models.sh` の `swift run` も、配った版の `install-speaker-models` を呼ぶ形にできる。
- ソースを変えた開発者は手元でビルドするので、配った版とソースの版がずれないようにする仕組み（版の固定と照合）が要る。

## TCC の許可と署名

- 許可は、アクセスしたプロセスではなく、その responsible process に付く。ターミナルから起動したプロセスはターミナルが responsible になり、子プロセスはそれを引き継ぐ。これは Apple の公開ドキュメントには明記が無く、二次情報（[Qt の解説](https://www.qt.io/blog/the-curious-case-of-the-responsible-process)。`launchctl procinfo` で responsible の PID が見えると書く）による。手元で `launchctl procinfo` を試したが root が要り、確かめられなかった。
- この repo では、ADR 0002（「マイクとシステム音声の権限は、ヘルパーを起動したアプリ（ターミナルなど）に付く」）と helper の README（「権限は起動元に付き」）が同じ観察を記録している。helper の実行ファイルには Info.plist が無く、それでも Core Audio taps（[Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps) は `NSAudioCaptureUsageDescription` を Info.plist に要るとする）とマイクが動いているのは、ターミナルのアプリの Info.plist と許可が使われているため、と読める。
- 前例の audiotee の README も、Node から起動したときの許可は使っているターミナル（iTerm・VS Code など）に付けるよう案内している（[audioteejs の README](https://github.com/makeusabrew/audioteejs#permissions)）。
- 識別について、[TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) は「Ad hoc signed code … has a DR but it's tied to that specific version of the code. … If you tweak the code and run it again, macOS repeats that prompt. Without a DR, macOS can't track this authorization across versions of your app.」と書く。helper の DR は `cdhash` なので、もし helper 自身が responsible だったら、ビルドし直すたび・配った版を更新するたびに許可を聞き直されることになる。Developer ID で署名すると、DR は識別子・Developer ID の証明書・チーム ID（`certificate leaf[subject.OU] = <Team ID>`）で表され、版をまたいで同じになるので、許可が続く（同 TN3127 の「Xcode designated requirement for Developer ID code」）。
- したがって、今の起動のしかた（ターミナル → `pnpm dev` の Node → helper の子プロセス）のままなら、**手元でビルドした版から配った版に替えても、配った版を更新しても、許可はやり直さない**。許可をやり直すのは、利用者がターミナルのアプリを変えたとき（今と同じ）。
- 子プロセスが自分で responsible になる手（`responsibility_spawnattrs_setdisclaim`）は非公開 API なので使えない（ADR 0002 の方針）。
- helper の README は「モデルの予約は実行ファイルの識別子ごと」とも書く（`AssetInventory`）。リンカーの署名の Identifier は出力のファイル名（`live-mindmap-helper`）で、手元のビルドと配った版で同じになる。予約が cdhash まで見るかは確かめていない。

## FluidAudio などの依存をビルド済みで取る

- FluidAudio の GitHub Releases（最新 v0.17.7）に成果物は無く、配布は SwiftPM のソースと CocoaPods の podspec（ソース）だけ。
- SwiftPM の `--enable-experimental-prebuilts` は「Determines whether macros use prebuilt swift-syntax libraries.」（`swift build --help`、Swift 6.4）で、swift-syntax 以外には効かない。
- Swift のライブラリを自前で xcframework にするには、library evolution（`.swiftinterface`）を有効にしたビルドと `xcodebuild -create-xcframework` が要る。依存の版を上げるたびに作り直す手間がかかり、helper の実行ファイルごと配る案に比べた利点は小さい。
- 参考: FluidAudio だけの release ビルドは、helper 全体の release ビルドの CPU 時間の 7 割ほどだった（下の「初回の時間の見込み」）。ビルドの重さの大半は FluidAudio にあるが、それを省く手は helper の実行ファイルごと配るのが一番手軽。

## 前例

| | 何か | 配り方 | 署名 |
|---|---|---|---|
| [makeusabrew/audioteejs](https://github.com/makeusabrew/audioteejs) | Core Audio taps でシステム音声を取る Swift の CLI（[audiotee](https://github.com/makeusabrew/audiotee)）を Node から子プロセスで起動し、stdout を流す | ビルド済みの universal バイナリを npm のパッケージの `bin/` に同梱 | ad-hoc。README は「Development: The ad-hoc signed binary works fine」、Electron に入れるなら親のアプリの署名に含める、単体のツールとして配るなら Developer ID を検討、と書く |
| [wulkano/aperture-node](https://github.com/wulkano/aperture-node)（Kap） | 画面収録の Swift の CLI を Node から呼ぶ | `prepublish` で `swift build --configuration=release --arch arm64 --arch x86_64` したバイナリを npm に同梱（`files` に `aperture`） | 同梱するだけ（npm 経由なので quarantine は付かない） |
| [sindresorhus/get-windows](https://github.com/sindresorhus/get-windows) | 前面のウィンドウを取る（画面収録・アクセシビリティの許可を使う） | macOS 向けに Swift でビルドした `main` を npm に同梱 | 同上 |

いずれも「Swift の CLI をビルド済みで npm に入れ、Node から子プロセスで起動し、許可は起動元のアプリに付く」形で、live-mindmap の helper と同じ。npm ではなく GitHub Releases から取る点だけが違う。universal バイナリ（`--arch arm64 --arch x86_64`）は SwiftPM の Xcode のビルドシステムを使うので、作るのは Xcode のある環境になる。

## ライセンス

配るものに静的にリンクされるもの（`libwebrtcapm.a` の中身と FluidAudio）と、その条件。手元のソース（`helper/.deps/webrtc-apm/src` と `helper/.build/checkouts/FluidAudio`）で確かめた。

| もの | ライセンス | バイナリで配るときの条件 |
|---|---|---|
| webrtc-audio-processing（`COPYING`、`webrtc/LICENSE`） | BSD-3-Clause（© Google / The WebRTC project authors） | 「Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials」 |
| WebRTC の `webrtc/PATENTS` | Google の特許の許諾（Additional IP Rights Grant） | 条件ではないが、WebRTC の配布物に含まれる文書なので一緒に置くのが通例 |
| `common_audio/third_party/ooura`（FFT） | 「You may use, copy, modify and distribute this code for any purpose … without fee」 | 改変時に出典を示す |
| `third_party/pffft` | FFTPACK のライセンス（BSD 系） | 著作権表示と条件を添える |
| `third_party/rnnoise`（`COPYING`） | BSD-3-Clause（Mozilla・Jean-Marc Valin・Xiph.Org） | 同上 |
| `modules/third_party/fft` | Mark Olesen の許諾（「provided that this entire notice is included in all copies」） | 通知文を全部含める |
| `common_audio/third_party/spl_sqrt_floor` | Wilco Dijkstra のメールによる許諾 | 同ファイルの文言を添える |
| abseil-cpp 20240722.0（`LICENSE`） | Apache-2.0 | ライセンスの写しを渡す。NOTICE ファイルは無い |
| FluidAudio（`LICENSE`） | Apache-2.0 | 同上。NOTICE ファイルは無い |
| FluidAudio の同梱物（`ThirdPartyLicenses/`: NemoTextProcessing（Apache-2.0、NVIDIA NeMo 由来の文法を含む）・fastcluster ほか） | それぞれ | NemoTextProcessing を trait で外せば、その分は配るものから消える |

- `meson` のラップ（`abseil-cpp/LICENSE.build`、MIT）はビルドの記述で、配るバイナリには入らない。
- live-mindmap 本体は MIT（ADR 0004）。上のどれも MIT での公開とは衝突しない。配る zip / xcframework に `THIRD_PARTY_LICENSES` のような 1 ファイルを添えれば条件を満たせる。map.html が同梱ライブラリのライセンスの全文を HTML に残しているのと同じ扱い。

## 初回の時間の見込み

この Mac は M4（10 コア）・16 GB・macOS 27.0.1・Swift 6.4（Command Line Tools）。計測中、他の作業で load average が 25〜80 あったので、壁時計の時間は大きめに出ている。

| 段 | 今 | AEC3 を配る | helper まで配る |
|---|---|---|---|
| AEC3 の meson ビルド | 約 2 分半（`orca.yaml` のコメント） | 4.2 MB のダウンロード | 要らない（開発者だけ） |
| `fetch-speaker-models.sh` の `swift run`（debug） | helper を debug で丸ごとビルド | 同じ | 配った版で `install-speaker-models` を呼べば要らない |
| `pnpm dev` の `swift build -c release` | 下の計測 | 同じ | 11 MB のダウンロード |
| `pnpm typecheck`（開発者だけ） | debug＋テスト | 同じ | 同じ（開発者は手元でビルドする） |

- release のクリーンビルド（binaryTarget の試し。依存の取得、87 MB の NemoTextProcessing のダウンロードを含む）: `Build complete!（744.91秒）`、`real 747`・`user 460`・`sys 41`。
- 同じ条件で FluidAudio だけを release でビルドした時間（`--target FluidAudio`、別の scratch-path。依存の取得は上で済んでいてキャッシュから。SDK のモジュールの事前コンパイルを含む）: `Build complete!（570.70秒）`、`real 579`・`user 320`・`sys 25`。CPU 時間で見ると、helper の release ビルドの 7 割ほどが FluidAudio（と SDK のモジュール）にかかっている。
- CI（macos-26 ランナー）では、debug の `swift build --build-tests` のクリーンビルドが 50〜80 秒だった（[2026-10-06 の調査](https://github.com/daiki-beppu/live-mindmap/blob/research/ci-swift-cache/docs/investigations/2026-10-06-ci-swift-build-cache.md)）。手元の初回の正確な時間は、map の測る ticket の値を使う。
- AEC3 だけを配っても、helper の Swift のビルドは debug と release の 2 回残る。初回の待ち時間の大半は、AEC3 より helper の Swift のビルドの側にある見込み。

## 案ごとに要るものと、戻しにくい点

| 案 | 要るもの | 戻しにくい点（外へ出す・署名・名前・費用） | 初回から消える時間 |
|---|---|---|---|
| A. AEC3 を `binaryTarget`（xcframework）にする | xcframework を作る CI のジョブ（Xcode）か手書きの Info.plist、Release、`Package.swift` の URL と checksum、ライセンス文の同梱 | Release の成果物と URL（tag 名・asset 名）を外へ出す。`Package.swift` に URL が入るので、消すと古いコミットがビルドできなくなる。署名・費用は無し | meson の約 2 分半と `uv` の前提 |
| A'. `.deps/webrtc-apm` を tarball で配る | Release、スクリプトでの SHA-256 照合、ライセンス文 | A と同じく Release の成果物を出す。URL はスクリプトの中 | A と同じ |
| B. helper の実行ファイルを配り、curl / Node で落とす（ad-hoc 署名） | Release に置く CI のジョブ、落とす処理（`pnpm dev` か setup）、置き場所とサーバーの既定の場所、SHA-256 の照合、ソースの版との照合、ライセンス文 | 実行ファイルを外へ出す（第三者のコードを含むバイナリの再配布）。Release の名前。署名・費用は無し | A に加えて、helper の debug と release のビルド |
| B'. B を Developer ID で署名・公証する | B に加えて Apple Developer Program（年 99 USD）、Developer ID の証明書と秘密鍵（CI の secret）、Hardened Runtime と entitlement の確認、`notarytool` | 年会費、証明書の名前（個人名かチーム名が署名に出る）、鍵の管理 | B と同じ（ブラウザで落とす人にも開けるようになる） |
| C. FluidAudio だけをビルド済みにする | library evolution のビルドと Xcode、依存を上げるたびの作り直し | B と同じく第三者のバイナリを出す | FluidAudio の分だけ |

## 確かめられなかったこと

- responsible process の決まりを書いた Apple の公式文書は見つからなかった（二次情報と repo 内の観察だけ）。`launchctl procinfo` は root が要るので試していない。TCC のデータベースは読んでいない。
- 配った helper（別の Mac でビルドしたもの）を実際に動かして、会議の取り込み・AEC3・話者分離が動くか。binaryTarget の試しも `--help` とシンボルを見ただけで、テストは走らせていない。
- ブラウザで落として quarantine が付いた ad-hoc 署名のバイナリを実際に起動したときの表示（ダイアログを出すので試していない）。
- Hardened Runtime を有効にしたとき、helper の Core ML・ScreenCaptureKit・Core Audio taps に entitlement が要るか。
- `AssetInventory` のモデルの予約が実行ファイルの何で結び付くか。
- Intel の Mac 向け（x86_64）の AEC3 と helper のビルド。
