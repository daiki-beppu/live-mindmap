# helper の swift build が毎回やり直される原因（Issue #502）

map #459（テストを層に分ける）の調査。helper の `pnpm test` を続けて流すと、ソースを変えていなくてもビルドに 20〜100 秒かかることがある（#460 の一覧では 73〜102 秒）。何がやり直されているのかを手元で測り、SwiftPM と Swift Build のソースで裏を取った。

## 結論

- **原因は、Swift Build（Swift 6.4 の既定のビルドエンジン）が Command Line Tools のツールチェーンを実行ごとにランダムに 2 通りの名前で引くこと。** Command Line Tools だけの環境では、同じ `/Library/Developer/CommandLineTools` が `org.swift.CommandLineTools` と `com.apple.dt.toolchain.XcodeDefault` の 2 つのツールチェーンとして登録される。SwiftPM はパスからツールチェーンを引いてビルド設定 `TOOLCHAINS` に入れるが、その引き方が `Set` の走査順に依存し、`Set` のハッシュはオブジェクトのアドレスなので、プロセスごとにどちらが返るか変わる（[ソース](#ソースで見た仕組み)）。
- **`TOOLCHAINS` が前回と違うと、helper の Swift と C++ のファイルが全部コンパイルし直される。** その名前で初めてビルドするときは、さらに SDK のモジュール 131 個（Clang 77・Swift 52 前後）もコンパイルし直す。#460 の 73 秒（1 回目）→ 102 秒（2 回目）は、2 回目で名前が変わり SDK のモジュールから作り直した形と一致する（手元で 79 秒 → 107 秒を再現）。
- **名前が前回と同じなら、ビルドは 0.3〜0.8 秒で終わる。** 52 回のビルドのうち、前回と名前が変わったのは 21 回（約 4 割）。作り直しが起きたのは、名前が変わったときか、コマンドの種類（`swift build` ↔ `swift test`）を変えたときだけだった。
- **`-Xswiftc -plugin-path` の違い、AEC3 の静的ライブラリのリンク、`unsafeFlags` は、毎回の作り直しの原因ではない。** 引数の違いは `swift build`（`pnpm typecheck`）と `swift test`（`pnpm test`）を別のビルド設定にするので、交互に流すと切り替えのたびに 5〜10 秒の作り直しが足されるが、同じコマンドを続けて流す限り何も作り直さない。
- **手元で効く手立て**（[比較](#手立ての比較)）:
  1. `pnpm typecheck` と `pnpm test` を、CI と同じ `swift build --build-tests <同じ引数>` → `swift test --skip-build` の形にそろえる。コマンドの切り替えの分は消える。ツールチェーンの名前が変わったときの 17〜19 秒は残る。
  2. `--build-system native` は、引数をそろえれば 2 回目以降が 0.2 秒になる。ただし非推奨（実行のたびに警告）で、Command Line Tools だけでは `Testing` のフレームワークの場所を自分で渡す必要があり、しかもそのビルドでは `HelperCoreTests` が `DuplicateRelayTests` の最初のテストで落ちる（signal 6、`freed pointer was not the last allocation`）。今は採れない。
  3. 根本は Swift Build 側の不具合。`ToolchainRegistry.lookup(path:)` が決まった順で返すようにする修正を upstream（swiftlang/swift-build）に報告するのが筋。`SWIFT_DETERMINISTIC_HASHING=1` では直らなかった（ハッシュがアドレス由来のため）。

## 測り方

- 環境: macOS 27.0.1、Command Line Tools の Swift 6.4（swiftlang-6.4.0.34.1）、Xcode なし、10 コア。`helper/.deps/webrtc-apm` はビルド済み。
- `helper/` で各コマンドを `-v` 付きで流し（`-v` はビルド設定を変えないことを `build-request.json` の比較で確かめた）、次を記録した。
  - 実時間と、SwiftPM が出す `Build complete! (N秒)`。
  - そのビルドが使ったビルド記述（build description）の ID: `.build/out/Intermediates.noindex/XCBuildData/prior-build-descriptions.txt` の最後の行。
  - その記述の `build-request.json` に入っている `TOOLCHAINS` の値。
  - コンパイルしたもの: ログの `Compile …\.swift` / `Compiling …\.swift` / `Compile apm.cpp`（helper のソース）と `Compiling Clang module` / `Compiling Swift module`（SDK のモジュール）の行数。
- `swift test` はテストの時間を除くため `--filter ExitCodeTests`（4 件・1 ミリ秒）を付けた。`--filter` はビルド記述を変えない（同じ記述 ID に戻ることで確認）。
- コマンドの略号:

| 略号 | コマンド |
|---|---|
| T | `swift test -Xswiftc -plugin-path -Xswiftc …/host/plugins/testing --filter ExitCodeTests`（`pnpm test` と同じ引数） |
| B | `swift build`（`pnpm typecheck` と同じ） |
| BT | `swift build --build-tests -Xswiftc -plugin-path -Xswiftc …/host/plugins/testing` |
| TS | `swift test --skip-build -Xswiftc -plugin-path …`（ビルドしない） |

## 結果

### 同じ `swift test` を続けて流す（`.build` を消してから）

| 回 | 実時間 | ツールチェーン | helper のソース | SDK のモジュール |
|---:|---:|---|---:|---:|
| 1 | 82.9 秒 | CommandLineTools | 107 | 131 |
| 2 | 108.8 秒 | XcodeDefault | 107 | 131 |
| 3 | 35.8 秒 | CommandLineTools | 107 | 0 |
| 4〜8 | 1.4〜1.7 秒 | CommandLineTools | 0 | 0 |
| 9 | 32.1 秒 | XcodeDefault | 107 | 0 |
| 10 | 41.9 秒 | CommandLineTools | 107 | 0 |
| 11 | 31.6 秒 | XcodeDefault | 107 | 0 |
| 12〜17 | 1.6〜2.3 秒 | XcodeDefault | 0 | 0 |
| 18 | 20.2 秒 | CommandLineTools | 107 | 0 |

- 作り直しが起きた回は、すべて前の回とツールチェーンの名前が違う。名前が同じ回は何もコンパイルしていない。
- SDK のモジュールは名前ごとに 1 回だけ作る（`.build/out/SDKExplicitPrecompiledModules` に両方の名前の分が並ぶ。#460 の 102 秒はこの 2 回目にあたる）。以後の切り替えは helper のソースだけで 20〜42 秒。
- `swift build` だけを続けたときも同じで、名前が変わると helper のソース 51 個を 4〜10 秒かけてコンパイルし直し、同じなら 0.3〜0.7 秒（10 回中 5 回が切り替え）。

### ビルド記述の中身の違い

ID の違うビルド記述の `build-request.json` を比べると、違いは次だけだった。

| 比べたもの | 違い |
|---|---|
| `swift build` どうし（名前が変わった 2 回） | `"TOOLCHAINS": "org.swift.CommandLineTools $(inherited)"` ↔ `"com.apple.dt.toolchain.XcodeDefault $(inherited)"` |
| `swift build` ↔ `swift build --build-tests -Xswiftc -plugin-path …` | 対象（`ALL-EXCLUDING-TESTS` ↔ `ALL-INCLUDING-TESTS`）と、`OTHER_SWIFT_FLAGS`・`OTHER_LDFLAGS_SWIFTC_LINKER_DRIVER_swiftc` の `-plugin-path …` |
| `swift build --build-tests …` ↔ `swift test …` | `swift test` だけ `"ENABLE_TESTABILITY": "YES"` |

`-plugin-path` などの引数の違いは、`swift build` と `swift test` を別のビルド設定にする（同じコマンドの中では毎回同じ）。ビルド記述は 4 つまでディスクに残り（Swift Build の `BuildDescriptionManager` の `maxCacheSize = (inMemory: 4, onDisk: 4)`）、2 つのコマンド × 2 つの名前でちょうど 4 つになる。

### コマンドを切り替えたとき

名前が同じでも、`swift build` の後の `swift test`（またはその逆）は、設定が違う分だけ helper のソース約 52 個をコンパイルし直す（5〜10 秒）。名前の切り替えと重なると、その回は `swift test` のソース全部（108 個、20 秒前後）になる。

## ソースで見た仕組み

参照したのは swiftlang/swift-package-manager の [`b0433f8`](https://github.com/swiftlang/swift-package-manager/tree/b0433f85a943069579a85cf7b980970e47a9ac52)（2026-10-06）と swiftlang/swift-build の [`080a733`](https://github.com/swiftlang/swift-build/tree/080a73325cbc9063df3985d20d06181d9d4c5ab7)（2026-10-07）。手元の 6.4 でも `build-request.json` に同じ `TOOLCHAINS` の上書きが入っていることで、同じ処理が動いていると判断した。

1. **SwiftPM は毎回、ツールチェーンのパスから ID を引いて `TOOLCHAINS` に入れる。** [`SwiftBuildSystem.swift` の `makeBuildParameters`](https://github.com/swiftlang/swift-package-manager/blob/b0433f85a943069579a85cf7b980970e47a9ac52/Sources/SwiftBuildSupport/SwiftBuildSystem.swift#L909-L943):
   ```swift
   let toolchainID = try await session.lookupToolchain(at: buildParameters.toolchain.toolchainDir.pathString)
   let overrideToolchains = [buildParameters.toolchain.metalToolchainId, toolchainID?.rawValue].compactMap { $0 }
   if !overrideToolchains.isEmpty {
       settings["TOOLCHAINS"] = (overrideToolchains + ["$(inherited)"]).joined(separator: " ")
   }
   ```
   これを外すオプションは無い（`setToolchainSetting` は内部の引数）。
2. **Command Line Tools だけの環境では、同じパスに 2 つのツールチェーンが登録される。**
   - 開発者ディレクトリが Command Line Tools のとき、[`Core.swift`](https://github.com/swiftlang/swift-build/blob/080a73325cbc9063df3985d20d06181d9d4c5ab7/Sources/SWBCore/Core.swift#L276-L291) はそのパスを `.toolchainPath` として探す。ToolchainInfo.plist が無いので、[`ToolchainRegistry.swift`](https://github.com/swiftlang/swift-build/blob/080a73325cbc9063df3985d20d06181d9d4c5ab7/Sources/SWBCore/ToolchainRegistry.swift#L145-L149) が `"org.swift.\(path.basename)"` = `org.swift.CommandLineTools` という ID を合成する。
   - 別に、[`PluginDCLT.swift`](https://github.com/swiftlang/swift-build/blob/080a73325cbc9063df3985d20d06181d9d4c5ab7/Sources/SWBApplePlatform/PluginDCLT.swift#L109-L132) の拡張が、同じ Command Line Tools のパスで ID `com.apple.dt.toolchain.XcodeDefault` のツールチェーンを足す。
3. **パスからの検索は `Set` の走査順で最初に当たったものを返し、その順は実行ごとに変わる。** [`ToolchainRegistry.swift`](https://github.com/swiftlang/swift-build/blob/080a73325cbc9063df3985d20d06181d9d4c5ab7/Sources/SWBCore/ToolchainRegistry.swift#L590-L612):
   ```swift
   public func lookup(path: Path) throws -> Toolchain? {
       let path = try self.fs.realpath(path)
       for toolchain in toolchains {          // toolchains: Set<Toolchain>
           if try self.fs.realpath(toolchain.path) == path { return toolchain }
       }
       return nil
   }
   ```
   `Toolchain` のハッシュは [`hasher.combine(ObjectIdentifier(self))`](https://github.com/swiftlang/swift-build/blob/080a73325cbc9063df3985d20d06181d9d4c5ab7/Sources/SWBCore/ToolchainRegistry.swift#L323-L329)（ヒープ上のアドレス）なので、`Set` の順はプロセスごとに変わる。Swift のハッシュの種を固定する `SWIFT_DETERMINISTIC_HASHING=1` を付けても、18 回中 5 回で名前が変わった（アドレスが毎回変わるため）。
4. **名前が変わると、SDK のモジュールは別の変種として作られる。** Swift Build の [`pruneExplicitPrecompiledModules`](https://github.com/swiftlang/swift-build/blob/080a73325cbc9063df3985d20d06181d9d4c5ab7/Sources/SWBBuildSystem/BuildOperation.swift#L1720-L1730) のコメントに「When the compilation context changes new pcm variants with different context hashes are created but old variants are never removed」とあり、古い変種はアクセスから 7 日（`CLANG_MODULES_PRUNE_AFTER` の既定 604800 秒）で消える。手元でも 2 つの名前の分が並んで残り、2 回目以降の切り替えでは作り直さなかった。helper のソースのコンパイルはビルド設定が変わるたびに走り直す。

CI（macos-26 のランナー）は Xcode を使うので、開発者ディレクトリが Xcode になり（`Core.swift` の `.xcode` の分岐）、Command Line Tools の重複登録は起きないと見られる（未検証）。

## 手立ての比較

いずれも、ソースを変えずに同じ組み合わせを何回か流した値。

| 手立て | 2 回目以降のビルド | 欠点 |
|---|---|---|
| 今のまま（`pnpm typecheck` = `swift build`、`pnpm test` = `swift test -Xswiftc -plugin-path …`） | 名前が同じなら 0.3〜0.8 秒。名前が変わると `swift test` で 20〜42 秒、`swift build` で 4〜10 秒（約 4 割の回）。名前の初回は SDK のモジュールも作って 80〜110 秒。typecheck と test を交互に流すと切り替えのたびに 5〜10 秒が足される | — |
| 引数をそろえる（両方 `swift build --build-tests -Xswiftc -plugin-path …`、テストは続けて `swift test --skip-build -Xswiftc -plugin-path …`。CI と同じ形） | 名前が同じなら 0.7 秒。名前が変わると 17〜19 秒（6 回中 3 回）。typecheck と test の切り替えの分は消える | 名前の切り替えは残る。`--skip-build` 側にも `-plugin-path` を渡さないと別の設定とみなされるかは未確認（今回は渡した） |
| `--build-system native`、引数をそろえる（両方に `-Xswiftc -plugin-path …` と `Testing.framework` の場所 `-Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks -Xlinker -F -Xlinker 同 -Xlinker -rpath -Xlinker 同`） | 0.15〜0.3 秒。引数をそろえないと切り替えのたびに 33 ファイル・4〜9 秒 | 非推奨（毎回警告）。`-F` などを渡さないと `no such module 'Testing'` で止まる。初回のビルドは 101 秒。**`HelperCoreTests` が `DuplicateRelayTests` の最初のテストで signal 6（`freed pointer was not the last allocation`）で落ちる**（3 回とも、`--no-parallel` でも同じ。`SttBenchTests` の 30 件は通る）。原因は追っていない |
| `SWIFT_DETERMINISTIC_HASHING=1` | 変わらない（18 回中 5 回で名前が変わり、20〜36 秒） | 効かない |
| Xcode を入れて `xcode-select` で選ぶ | 未検証。重複登録が起きなくなると見込む | Xcode なしで回す前提に反する |

## 未解決

- `--build-system native` で `DuplicateRelayTests` が落ちる理由。Swift の並行処理のタスクのメモリ管理が壊れたときのメッセージで、native のビルドでだけ起きる。native を採らないなら追わなくてよい。
- upstream への報告（swiftlang/swift-build）。同じ現象の issue は `lookupToolchain`・`CommandLineTools` などで探したが見つからなかった。
- 引数をそろえる案の `@testable import` は、`ENABLE_TESTABILITY` の上書きなしでも通る。手元で `swift build --build-tests -Xswiftc -plugin-path …` → `swift test --skip-build -Xswiftc -plugin-path …` を流し、全テスト（30 件と 319 件）が通った（CI も同じ形）。
