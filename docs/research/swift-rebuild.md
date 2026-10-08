# helper の swift build が毎回やり直される原因（Issue #502）

## 結論

- **何がやり直されているか**: ソースを変えなくても、`swift test` は起動するたびに、2 通りのビルドの設定のどちらかを**ランダムに**選ぶ。2 つの違いは、ビルド設定 `TOOLCHAINS` の値だけ（`com.apple.dt.toolchain.XcodeDefault` か `org.swift.CommandLineTools` か）。前回と違うほうを引くと、ビルドの設定全体が変わったとみなされ、Swift のターゲット（`HelperCore`、`stt-bench`、`live-mindmap-helper`、2 つのテストターゲット）と C++ のシム（`CWebRTCAPM` の `apm.o`）を全部コンパイルし直し、リンクし直す。同じほうを引けば 0.5 秒前後で終わる。
- **疑っていた要因はどれも原因ではない**: `-Xswiftc -plugin-path` 引数は毎回同じで、ビルドの設定に入る値も変わらない。AEC3 の静的ライブラリ（`.deps/webrtc-apm/lib/*.a`）は作り直されず、リンクに使われるだけ。`pnpm build-apm` はファイルの有無を `test -f` で見るだけで、ほぼ 0 秒。
- **原因の場所**: swiftbuild エンジン（SwiftPM 6.x の既定のビルドシステム）の、Command Line Tools だけの環境での振る舞い。同じディレクトリ `/Library/Developer/CommandLineTools` がツールチェーンとして 2 回、別の識別子で登録される。SwiftPM がパスから識別子を引くとき、swift-build は `Set` を回して最初に合ったものを返す。`Set` の順序はオブジェクトのアドレスで決まるので、プロセスごとに変わる。
- **手元で縮める手立て**: 設定で直せる手は見つからなかった。`SWIFT_DETERMINISTIC_HASHING=1` は効かない（ハッシュがアドレス由来のため）。`--build-system native` にすると 2 回目以降のビルドは 0.15 秒になるが、テストの実行中にプロセスが abort するので、今のテストには使えない（2 回試して 2 回とも再現）。Xcode を入れれば、ツールチェーンの登録が 1 つになり起きないはず（ソースを読んだうえでの推測で、Xcode が無いので試していない）。現実的なのは、上流（swift-build / SwiftPM）への報告と修正待ち。
- **やり直したときのコスト**: 両方の設定を一度ずつビルドした後は、やり直しは 1 回 17〜30 秒。73〜116 秒かかるのは、片方の設定で初めてビルドするとき（SDK のモジュールの事前コンパイルが走る）。

## 環境

- macOS 27.0（arm64）、Xcode なし、`xcode-select -p` = `/Library/Developer/CommandLineTools`
- `swift --version`: Apple Swift version 6.4 (swiftlang-6.4.0.34.1)、swift-driver 1.168.6
- `swift build --help` によると、既定のビルドシステムは `swiftbuild`、`native` は deprecated
- helper の `pnpm test` = `pnpm build-apm && swift test -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing`（`helper/package.json`）

## 実測

### 1. `pnpm test` を続けて 2 回（ソースは無変更）

| 回 | `.build` の状態 | `Build complete!` | 全体（real） |
|---|---|---|---|
| 1 | 空 | 72.7 秒 | 202 秒 |
| 2 | 1 回目の直後 | 116.5 秒 | 200 秒 |

2 回目の後に `.build` の中で更新されたファイル（2 回目の直前に置いた目印より新しいもの）は 4594 個中 527 個。主なもの:

- `.build/out/SDKExplicitPrecompiledModules/` の 128 個（SDK のモジュール `.pcm` / `.swiftmodule`）。ファイル名のハッシュが 1 回目と違う（例: `_AvailabilityInternal-EGCX….pcm` が 1 回目、`_AvailabilityInternal-5A46….pcm` が 2 回目）。設定が変わり、別のモジュールとして作り直された。
- `HelperCore-t.build`、`HelperCoreTests-p.build`、`stt-bench-p.build`、`SttBenchTests-p.build`、`live-mindmap-helper-p.build` の `Objects-normal/arm64` の `.o` など。全 Swift ターゲットのコンパイルのやり直し。
- `CWebRTCAPM-t.build/Objects-normal/arm64/apm.o`（C++ のシムの再コンパイル）。
- `Products/Debug/*.xctest`（リンクと署名のやり直し）。
- `.build/out/Intermediates.noindex/XCBuildData/` に、新しいビルド記述のディレクトリ（`<ハッシュ>.xcbuilddata`）ができた。

### 2. 2 つのビルド記述の違い

`XCBuildData/` には、1 回目の `e38894b4….xcbuilddata` と 2 回目の `6ec044c7….xcbuilddata` の 2 つがあった。それぞれの `build-request.json`（SwiftPM が swift-build に渡したビルドの要求）を比べると、違いは `TOOLCHAINS` の 1 行だけ（2 か所に出る）。

```diff
-  "TOOLCHAINS": "com.apple.dt.toolchain.XcodeDefault $(inherited)"
+  "TOOLCHAINS": "org.swift.CommandLineTools $(inherited)"
```

`OTHER_SWIFT_FLAGS` の `-plugin-path …` を含め、ほかの設定は同じ。

### 3. `swift test` を何度も回したときの記述の選ばれ方

テストを実行しない形（`--filter` に存在しない名前）でビルドだけを繰り返した。`prior-build-descriptions.txt` の最後の行が、その回に使われたビルド記述。

| 回 | 使われた記述 | `Build complete!` |
|---|---|---|
| 5 | 6ec0（CLT） | 19.1 秒 |
| 6 | e388（XcodeDefault） | 22.4 秒 |
| 7 | 6ec0 | 27.8 秒 |
| 8（`-v` 付き） | 6ec0 | 0.57 秒（全ターゲット up to date） |
| 9 | e388 | 25.7 秒 |
| 10 | 6ec0 | 17.7 秒 |

規則的に交互になるのではなく、毎回どちらかがランダムに選ばれる。前回と同じ記述を引いた回（8）だけ、何もやり直さない。`swift build --build-tests`（`typecheck` に近い形）も、別のビルド記述（`ENABLE_TESTABILITY` が無い）を使う。続けて 2 回回すと、1 回目 21.0 秒、2 回目 0.55 秒だった。ただ、下の原因は `swift build` でも同じコードを通るので、こちらも毎回のやり直しを避けられるとは限らない。

### 4. 対策の試し

| 試したこと | 結果 |
|---|---|
| `SWIFT_DETERMINISTIC_HASHING=1 swift test …` を 6 回 | 記述は e388, e388, 6ec0, 6ec0, 6ec0, e388 と変わり、変わった回は 21〜30 秒。効かない |
| `swift test --build-system native …` | `no such module 'Testing'` でビルドが失敗する |
| 上に `-Xswiftc -F -Xswiftc <CLT>/Library/Developer/Frameworks`、`-Xlinker -F`、`-Xlinker -rpath` を足す | ビルドは通り、1 回目 17.7 秒、2・3 回目 0.15 秒。ただし全テストを回すと、途中で `freed pointer was not the last allocation` と出て `swiftpm-testing-helper` が signal 6 で落ちる（2 回とも再現）。今のテストには使えない |

## 原因（一次資料）

1. **SwiftPM は Command Line Tools を「単独のツールチェーン」としてセッションに渡す。** `toolchainDeveloperPathInfo` は、ツールチェーンのディレクトリから 3 つ上に Xcode の `version.plist` があるかで「Xcode に入っているか」を決める。Command Line Tools ではこれが偽になり、`createSession(name:swiftToolchainPath:…)` で、ツールチェーンのパスを渡してセッションを作る（[SwiftBuildSystem.swift `toolchainDeveloperPathInfo` / `createSession`](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/SwiftBuildSupport/SwiftBuildSystem.swift)）。
2. **そのパスは `org.swift.<ディレクトリ名>` として登録される。** swift-build の `Toolchain` の初期化は、`Info.plist` などのメタデータが無く `synthesizeMetadataIfNeeded` が真のとき、識別子 `org.swift.\(path.basename)` を合成する。ここでは `org.swift.CommandLineTools`（[ToolchainRegistry.swift](https://github.com/swiftlang/swift-build/blob/main/Sources/SWBCore/ToolchainRegistry.swift)）。
3. **同じパスが、もう一度 `com.apple.dt.toolchain.XcodeDefault` として登録される。** swift-build の Command Line Tools 向けの拡張 `DeveloperCommandLineToolsToolchainRegistryExtension` は、developer path が Command Line Tools のとき、`identifier: ToolchainRegistry.defaultToolchainIdentifier`（= `com.apple.dt.toolchain.XcodeDefault`）、`path: commandLineToolsPath` のツールチェーンを追加する（[PluginDCLT.swift](https://github.com/swiftlang/swift-build/blob/main/Sources/SWBApplePlatform/PluginDCLT.swift)。2026-02-04 のコミット「Teach Swift Build how to work with Command Line Tools installations」で入った）。
4. **パスから識別子を引く処理が、順序の決まらない `Set` を回す。** SwiftPM の `makeBuildParameters` は、`session.lookupToolchain(at: toolchainDir)` で得た識別子を `settings["TOOLCHAINS"]` に入れる（[SwiftBuildSystem.swift `makeBuildParameters`](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/SwiftBuildSupport/SwiftBuildSystem.swift)）。swift-build 側の `ToolchainRegistry.lookup(path:)` は `for toolchain in toolchains`（`Set(self.toolchainsByIdentifier.values)`）を回し、realpath が一致した最初のものを返す。ここでは 2 つが一致する（[ToolchainRegistry.swift `lookup(path:)`](https://github.com/swiftlang/swift-build/blob/main/Sources/SWBCore/ToolchainRegistry.swift)、メッセージの受け口は [Messages.swift `LookupToolchainMsg`](https://github.com/swiftlang/swift-build/blob/main/Sources/SWBBuildService/Messages.swift)）。
5. **`Set` の順序はプロセスごとに変わる。** `Toolchain` は class で、`hash(into:)` は `hasher.combine(ObjectIdentifier(self))`、つまりオブジェクトのアドレスでハッシュする（同じ `ToolchainRegistry.swift`）。アドレスは起動ごとに変わる（ASLR など）。そのため `SWIFT_DETERMINISTIC_HASHING` で Swift のハッシュの種を固定しても、順序は固定されない（実測 4 と合う）。
6. **`TOOLCHAINS` が変わると、全部をやり直す。** `TOOLCHAINS` はビルドの要求の上書き設定に入るので、ビルド記述のハッシュが変わり、別の記述（`<ハッシュ>.xcbuilddata`）が作られる。2 つの記述は同じ出力先（`.build/out/Products`、`Intermediates.noindex`）を使う。そのため、記述が切り替わるたびに、前の記述で作った成果物が古いとみなされ、作り直される（実測 1・3）。

上流の issue は、swift-build と SwiftPM の両方で検索したが、この件に当たるものは見つからなかった（2026-10-08 時点）。近い話題に、変更が無くても計画に時間がかかる [swift-build#1111](https://github.com/swiftlang/swift-build/issues/1111) があるが、別の原因。

## 手元で縮める手立て

- **今すぐ使える設定の手は無い。** `TOOLCHAINS` は SwiftPM が内部で上書きするので、環境変数や `-Xswiftc` では動かせない。`swift build --help` にも、ビルド記述やコンパイルキャッシュを指定するオプションは無い。
- **やり直しは避けられないが、1 回の費用は 73〜116 秒より小さい。** 2 通りの記述の SDK モジュールは、どちらも `.build/out/SDKExplicitPrecompiledModules/` に残る。両方を一度ずつ作った後は、記述が変わった回のやり直しは 17〜30 秒（実測 3・4）、変わらない回は 0.5〜1.1 秒。`.build` を消すと、また 73 秒以上の回が 2 度ある。
- **`--build-system native` は今は使えない。** ビルドは速い（2 回目以降 0.15 秒）が、テストの実行が abort する。原因は調べていない。また native は deprecated で、将来なくなる予定（`swift test` の警告）。
- **Xcode を入れると起きないはず（未検証）。** Xcode の中のツールチェーンなら、SwiftPM は developer path を渡さずにセッションを作り（上の 1）、Command Line Tools 向けの拡張も働かない（上の 3、`commandLineToolsPath` が無い）。そのため、同じパスへの登録は 1 つになる。ただし Xcode を入れる前提は、Command Line Tools だけで回るテストという方針（AGENTS.md）と合わない。
- **根本の修正は上流。** `lookup(path:)` が、一致したものの中から決まった順で選ぶ（例: 識別子で並べる、既定の識別子を優先する）ように直れば、毎回同じ記述になる。swift-build へ、上の再現手順（Command Line Tools だけの環境で `swift test` を繰り返し、`XCBuildData/prior-build-descriptions.txt` と `build-request.json` の `TOOLCHAINS` を比べる）を添えて報告するとよい。

## 測り方の注意

- 各条件の回数は少ない（`pnpm test` 全体は 2 回、ビルドだけの回は条件ごとに 3〜6 回）。秒数は同じマシンで並行する作業の影響を受けるので、目安として読む。
- 「どちらの記述が使われたか」は `prior-build-descriptions.txt` の最後の行と、`<ハッシュ>.xcbuilddata/build-request.json` の `TOOLCHAINS` で判定した。
