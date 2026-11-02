# メニューバーに常駐する .app を GitHub だけで配る仕組み（#1867）

map #1865 の research ticket #1867 の調べた結果。問いは 4 つ（ビルドの経路、Sparkle 2、CLI の同梱、常駐の作り）。2026-11-03 に一次情報（Apple の開発者向け文書、Sparkle の文書とソース、GitHub の文書、Node のリポジトリ）と、手元の `/Applications/Kanary.app`（4.1.4、読むだけ）を見た。

記号: 【出典】は一次情報の記述、【Kanary】は手元の .app で確かめた事実、【推論】は出典からの組み立てで、試作で確かめる必要があるもの。

## 0. 手本の Kanary.app の中身（2026-11-03 に確認）

- `Info.plist`【Kanary】
  - `LSUIElement = true`、`LSMinimumSystemVersion = 14.0`。
  - `SUFeedURL = https://distro.kanary.to/appcast.xml`、`SUPublicEDKey`（base64）、`SUEnableAutomaticChecks = true`、`SUAutomaticallyUpdate = true`、`SUScheduledImpatientCheckInterval = 172800`（2 日）。
- 中の配置【Kanary】
  - `Contents/Helpers/kanary`（72KB の Mach-O、arm64）と `Contents/Helpers/kanary-diarization-helper`。
  - `Contents/Frameworks/Sparkle.framework`（2.9.4。`Updater.app`・`Autoupdate`・`XPCServices/Downloader.xpc`・`Installer.xpc` を含む）と自前の framework 群。
  - `Contents/embedded.provisionprofile` がある（`keychain-access-groups` を使うため）。
  - `Contents/Library/LoginItems` は無い。
- 署名【Kanary】
  - `spctl -a -vv` の結果は `accepted`、`source=Notarized Developer ID`、`origin=Developer ID Application: <個人名> (<Team ID>)`。
  - 本体も `Helpers/kanary` も `flags=0x10000(runtime)` で、Hardened Runtime が付いている。
  - 本体の entitlements は `com.apple.security.device.audio-input`、`com.apple.security.personal-information.calendars`、`keychain-access-groups`、application-identifier・team-identifier。
  - CLI は別の識別子（`<Team>.download.kanary.cli`）で署名している。
- CLI の入れ方【Kanary】
  - `~/.local/bin/kanary -> /Applications/Kanary.app/Contents/Helpers/kanary` の symlink がある。
  - バイナリ内の文字列には、`Install CLI & Agent Skill`（利用者が押すボタン）、`createSymbolicLinkAtPath:withDestinationPath:error:`、`Cannot install because `%@` already exists and is not a Kanary symlink.`、`KANARY_INSTALL_EXPECTED_PATH` がある。
  - CLI は本体の「CLI listener」（ローカルのソケット）に繋ぐ薄いクライアントで、`could not connect to CLI listener` などの文言がある。
- ログイン時の起動【Kanary】
  - `KanaryPlatform` の中に `LiveLaunchAtLoginService`、`enableLaunchAtLogin`、`mainAppService` の文字列がある。`SMAppService.mainApp` を使っていると読める。

## 1. ビルドの経路（GitHub Actions の macOS ランナー → 署名 → 公証 → staple → DMG）

### ランナー

- arm64 の macOS ランナーは `macos-14`・`macos-15`・`macos-26`・`macos-latest` などで、Intel は `macos-15-intel`・`macos-26-intel`。【出典】[GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- 標準の GitHub-hosted ランナーは、公開リポジトリなら無料で無制限。このリポジトリは PUBLIC。【出典】同上
- このリポジトリはすでに helper のテストを `macos-26` で回している（`.github/workflows/tests.yml`）。helper は macOS 26 以上が要るので、配布のビルドも `macos-26` が合う。【推論】

### 証明書を CI に持たせる

GitHub の公式手順は次のとおり。【出典】[Installing an Apple certificate on macOS runners](https://docs.github.com/en/actions/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development)

- secrets は 4 つ置く。
  - `BUILD_CERTIFICATE_BASE64`: p12 を base64 にしたもの。
  - `P12_PASSWORD`: p12 のパスワード。
  - `BUILD_PROVISION_PROFILE_BASE64`: provisioning profile を base64 にしたもの。
  - `KEYCHAIN_PASSWORD`: 一時キーチェーン用の乱数。
- 手順
  1. `echo -n "$BUILD_CERTIFICATE_BASE64" | base64 --decode -o $CERTIFICATE_PATH` で p12 を戻す。
  2. `security create-keychain` で `$RUNNER_TEMP/app-signing.keychain-db` を作り、`set-keychain-settings -lut 21600` と `unlock-keychain` を実行する。
  3. `security import` と `set-key-partition-list` で証明書を入れ、`security list-keychain` で検索対象に足す。
- GitHub-hosted ランナーは job ごとに捨てられるので、後片付けは要らない（self-hosted なら `if: always()` で keychain を消す）。

この repo の場合の補足は次の 2 つ。

- 使う証明書は `Developer ID Application`。Mac Distribution・Apple Development・ad hoc は公証に使えない。【出典】[Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- provisioning profile が要るのは、Kanary のように `keychain-access-groups` などの制限付きの entitlement を使う場合だけ。【推論】Kanary は profile を同梱している。この repo で Claude の鍵を Keychain に置くなら要るかもしれない。

### 署名（Hardened Runtime・entitlements）

`codesign` の規則【出典】[Creating distribution-signed code for the Mac](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)

- 内側から外へ署名する（依存される側が先）。
- `--deep` で署名しない。全部に同じ entitlements が付くうえ、決まった場所にないコードは署名されない。
- Developer ID の配布では `--timestamp` を付ける。main executable には `-o runtime`（Hardened Runtime）を付ける。
- バンドルの外のコードには `-i <BundleID>` を付ける。署名し直すときは `-f` を付ける。
- entitlements は main executable にだけ付け、ライブラリには付けない。plist は XML・LF・コメント無し・BOM 無しにする。

公証に要る条件【出典】[Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

- すべての実行ファイルに有効な署名がある。
- Developer ID の証明書で署名している。
- app と CLI のターゲットに Hardened Runtime を付けている。
- secure timestamp がある。
- `com.apple.security.get-task-allow` を true にしていない。

Hardened Runtime と entitlements【出典】[Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)

- 既定ではすべて false。要るものだけ true で付ける。

この repo に効く entitlements は次のとおり。

- マイク: `com.apple.security.device.audio-input`。Hardened Runtime では、これが無いとマイクを使えない。【出典】[audio-input](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)【Kanary】Kanary も付けている。
- 同梱する Node（server と CLI の実行環境）: V8 は JIT を使うので、少なくとも `com.apple.security.cs.allow-jit` が要る。【出典】[allow-jit](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit)
  - Node 本家が macOS 用に使う `tools/osx-entitlements.plist` には、`allow-jit`、`allow-unsigned-executable-memory`、`disable-executable-page-protection`、`allow-dyld-environment-variables`、`disable-library-validation`、`get-task-allow` が並ぶ。【出典】[nodejs/node tools/osx-entitlements.plist](https://github.com/nodejs/node/blob/main/tools/osx-entitlements.plist)
  - ただし `get-task-allow` は公証を通らないので外す。どこまで削れるかは、同梱した node で server を動かして試作で決める。【推論】
  - ネイティブアドオン（`.node`）を読むなら、それも同じ Team で署名する。署名できないなら `disable-library-validation` を付ける。【推論】
- 署名した Node をバンドルの中に置き、`Contents/Helpers/node` のような実行ファイルとして別の entitlements で署名する。こうすると、app 本体には JIT の例外を付けずに済む。【推論】entitlements は実行ファイルごとに付けるという規則からの組み立て。

### 公証（notarytool）と staple

- `altool` は 2023-11-01 で終了した。`xcrun notarytool submit <file> --wait` を使う。【出典】[Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- 受け付ける形式は UDIF の disk image、署名した flat pkg、ZIP。入れ子も処理し、DMG の中の .app にも ticket を作る。【出典】同上
- CI の認証は App Store Connect API キーで行う（`notarytool submit --help`、Xcode CLT で確認）。【出典】
  - `-k/--key <.p8 のパス> -d/--key-id <Key ID> -i/--issuer <Issuer ID>` を渡す。`--issuer` は Team API Key のときだけ必要で、Individual API Key では渡さない。
  - ほかに `--apple-id`・`--password`（app 用パスワード）・`--team-id`、または `--keychain-profile` でも認証できる。
  - CI では API キーの .p8 を base64 にした secret と、Key ID・Issuer ID の secret を置き、`$RUNNER_TEMP` に戻して `--key` に渡すのが素直。【推論】
- 結果のログは `notarytool log <id>` で取る。【出典】同上
- staple は `xcrun stapler staple <app|dmg|pkg>` で行う。ZIP には staple できず、単体のバイナリにもできない。【出典】同上
  - staple するとオフラインでも Gatekeeper が ticket を見つけられる。staple が要る理由はこれ。
  - `stapler` は Xcode 本体が要る。CLT だけの手元では動かなかった。ランナーには Xcode がある。

### DMG と手順のまとめ【推論。上の出典をつないだもの】

1. `xcodebuild archive` → `-exportArchive`（Developer ID）。または SwiftPM と `codesign` で組み立てる。Sparkle の文書も自動化では `xcodebuild archive` と `-exportArchive` を勧める。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)
2. 内側から署名する。node・helper・CLI のランチャー・Sparkle の XPC と `Updater.app`・framework・app 本体の順。
3. `hdiutil` で DMG を作る。中身は .app と `/Applications` への symlink にする（Sparkle の推奨）。APFS で lzfse 圧縮にするのが推奨。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)、[Publishing](https://sparkle-project.org/documentation/publishing/)
4. DMG に `codesign -s "Developer ID Application: …" --timestamp` を付ける。
5. `notarytool submit X.dmg --key … --wait` で公証する。DMG の公証で、中の .app にも ticket が付く。
6. `stapler staple X.dmg` を実行する。中の .app にも staple したい場合は、DMG を作る前に .app を ZIP で公証して staple し、そのあと DMG を作って公証と staple をもう 1 回行う。どちらにするかは試作で決める。
7. `spctl -a -vv -t open --context context:primary-signature X.dmg` と `stapler validate` で確かめる。

## 2. Sparkle 2（appcast・DMG を GitHub に置く、EdDSA の鍵）

### 組み込み

- SwiftPM で `https://github.com/sparkle-project/Sparkle` を足す。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)
- Info.plist に `SUFeedURL` と `SUPublicEDKey` を置く。`CFBundleVersion` は版ごとに増やす（比較に使う）。【出典】同上
- SwiftUI では `SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)` を `App` の `init` で作り、「アップデートを確認…」のボタンを `canCheckForUpdates` に連動させる。【出典】[Programmatic setup](https://sparkle-project.org/documentation/programmatic-setup/)
- サンドボックスにしない app では、Sparkle の XPC サービスは要らず、削ってよい。`SUEnableInstallerLauncherService` も付けない。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)、[Customization](https://sparkle-project.org/documentation/customization/)
- `LSUIElement` の app（背景の app）では、Sparkle 2.2 以降、起動直後を除いて定期の更新の知らせはフォーカスを奪わず、他の窓の後ろに出る。
  - `SPUStandardUserDriverDelegate` の `supportsGentleScheduledUpdateReminders` を実装しないと警告がログに出る。
  - 手本は、一時的に Dock に出して通知を出す例。【出典】[Gentle reminders](https://sparkle-project.org/documentation/gentle-reminders/)
  - メニューバーの常駐には必須の対応。
- 主な設定【出典】[Customization](https://sparkle-project.org/documentation/customization/)
  - `SUEnableAutomaticChecks`: 未設定だと 2 回目の起動で利用者に尋ねる。
  - `SUAutomaticallyUpdate`: 裏で入れる。
  - `SUScheduledCheckInterval`: 既定 1 日、最小 1 時間。
  - `SUScheduledImpatientCheckInterval`: 既定 1 週間。
  - `SUVerifyUpdateBeforeExtraction` / `SURequireSignedFeed`: appcast とリリースノートにも署名する。2.9 から検証される。
- DMG は「公証した Developer ID 署名の DMG」が推奨。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)
- `sparkle:hardwareRequirements` に `arm64` を書くと Apple silicon だけに配れる（2.9 から）。`sparkle:minimumSystemVersion` で OS の下限を書ける。【出典】[Publishing](https://sparkle-project.org/documentation/publishing/)

### EdDSA の鍵

- `generate_keys` は 1 回だけ実行する。秘密鍵は login Keychain に入り、公開鍵が表示される。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)
- `-x <file>` で書き出し、`-f <file>` で取り込み、`-p` で公開鍵を表示する。`--account` で鍵の名前を分けられ、組織ごとに分けるのが推奨。【出典】[generate_keys/main.swift](https://github.com/sparkle-project/Sparkle/blob/2.x/generate_keys/main.swift)
- CI では `generate_appcast --ed-key-file -` で、secret の秘密鍵を標準入力から渡す。例は `echo "$PRIVATE_KEY_SECRET" | generate_appcast --ed-key-file - <dir>`。`-s <key>` は非推奨。【出典】[generate_appcast/main.swift](https://github.com/sparkle-project/Sparkle/blob/2.x/generate_appcast/main.swift)
- 秘密鍵を失っても、Developer ID で署名した app なら鍵を切り替えられる。新旧の更新が同じ Developer ID 証明書で署名されていれば、Sparkle は Apple の署名を根拠に公開鍵の変更を信じる。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)、[EdDSA migration](https://sparkle-project.org/documentation/eddsa-migration/)
- それでも秘密鍵は `-x` で書き出し、GitHub の secret とは別の場所（パスワード管理）にも控えておく。【推論】
- 署名鍵は製品を置くマシンに置かない。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)

### appcast の作り方

- `generate_appcast <archives_dir>` を実行すると、appcast（`SUFeedURL` のファイル名）を書き、署名と delta を作る。同名の `.html` か `.md`（2.9 から）がリリースノートになる。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)
- 関係するオプション【出典】[generate_appcast/main.swift](https://github.com/sparkle-project/Sparkle/blob/2.x/generate_appcast/main.swift)
  - `--download-url-prefix <url>`: ダウンロード URL の前置き。
  - `--release-notes-url-prefix` / `--embed-release-notes` / `--full-release-notes-url`: リリースノートの扱い。
  - `--maximum-versions`: 分岐ごとに残す版の数。0 なら全部残す。
  - `--maximum-deltas`: delta を作る数。
  - `--channel`、`--phased-rollout-interval`、`--critical-update-version`。
  - `--auto-prune-update-files`、`-o <appcast のパス>`。
  - ヘルプには「新しい項目は、置いた archive と今の feed から推し量る」とある。
- 手で 1 本ずつ署名するなら `sign_update <dmg>` を使う。`sparkle:edSignature` と `length` を出す。【出典】[Publishing](https://sparkle-project.org/documentation/publishing/)

### GitHub に置く

Sparkle の文書は「HTTPS で置け」と言うだけで、GitHub での置き方は書いていない。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)

GitHub 側で使える URL は次のとおり。

- 版ごとの asset: `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`。
- 最新の asset: `https://github.com/<owner>/<repo>/releases/latest/download/<file>`。【出典】[Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)

【推論】置き方の案は 2 つ。

| 案 | `SUFeedURL` | 利点 | 弱み |
|---|---|---|---|
| A. appcast も Release の asset | `…/releases/latest/download/appcast.xml` | GitHub Pages を設定しなくてよい。Release を作るだけで済む | 前の appcast を、最新の Release から落として足し直す手間がある。プレリリース・draft は `latest` にならない。URL が github.com に縛られる |
| B. appcast は GitHub Pages | `https://<owner>.github.io/<repo>/appcast.xml`（後で独自ドメインに CNAME できる） | URL を後から独自ドメインへ移せる。appcast の履歴が git に残る | Pages のブランチやデプロイの設定が要る |

- どちらの案でも、DMG は版ごとの Release asset に置き、enclosure の URL は `releases/download/<tag>/…` にする。
  - `generate_appcast` を実行するときは、新しい DMG と今の `appcast.xml` だけを置いたディレクトリに対して、`--download-url-prefix https://github.com/<owner>/<repo>/releases/download/<tag>/` を渡す。
  - このとき古い項目の URL が保たれるかは、ヘルプの文言からの推測で、試作で確かめる。
- delta は古い archive が手元に要るので、最初は `--maximum-deltas 0` 相当（delta を作らない）で始めるのが簡単。【推論】
- 名前の map（#1857）でドメインを持つ可能性があるなら、`SUFeedURL` を後から変えにくいので、B のほうが安全。【推論】

## 3. CLI の同梱（`Contents/Helpers` と `~/.local/bin` の symlink）

### 置き場所

- bundle の中の「コード」は Mach-O のこと。シェルスクリプトや Python スクリプトには署名を置く場所が無いので、リソースとして扱う。置き場所を間違えると、公証で分かりにくい問題が出る。【出典】[Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)
- したがって `Contents/Helpers/` には Mach-O を置く。【推論】
  - 今の CLI（`server/package.json` の `bin` → `./src/cli.ts`、`#!/usr/bin/env node`）は、そのままでは置けない。
  - 案は 2 つ。
    - (i) 署名した `node` を `Contents/Helpers/` に置き、JS を `Contents/Resources/` に置く。CLI の入口は、node を引数付きで起こす小さな Mach-O のランチャーにする。
    - (ii) Kanary のように、常駐サーバーへ繋ぐだけの小さな Swift の CLI にする。
  - (ii) は CLI の実装を作り直すことになり、ADR 0003 の「入口は CLI」の中身に触れる。(i) なら今の CLI をそのまま使える。
- Helpers のツールには、本体とは別の識別子・別の entitlements で、Hardened Runtime を付けて署名する。【Kanary】`kanary` は `…download.kanary.cli`・runtime で署名している。【出典】`-i <BundleID>` と `-o runtime`（§1）。

### symlink の張り方と PATH

- Kanary は、利用者が押す「Install CLI & Agent Skill」で `~/.local/bin/kanary` に symlink を張る。【Kanary】
  - 張る先に Kanary の symlink 以外のものがあれば、上書きせず「already exists and is not a Kanary symlink」と止める。
  - symlink の先は `/Applications/Kanary.app/Contents/Helpers/kanary`。
- macOS の既定の PATH（`/etc/paths`）は `/usr/local/bin`・`/usr/bin`・`/bin`・`/usr/sbin`・`/sbin` などで、`~/.local/bin` は入っていない（手元の `/etc/paths` で確認）。
- 【推論】PATH に無いときの扱いの案は 3 つ。
  1. 張ったあと、ログインシェルの `PATH` に `~/.local/bin` があるかを確かめる（`$SHELL -lc 'echo $PATH'` か `command -v <name>`）。無ければ、`~/.zprofile` に足す 1 行を画面に出し、コピーか「足す」ボタンを用意する。
  2. `/usr/local/bin` に張る。PATH には最初からあるが、書き込みに管理者権限が要ることが多く、認証ダイアログを出すことになる。
  3. エージェントや自動化には、PATH に頼らない絶対パス（`/Applications/<App>.app/Contents/Helpers/<cli>`）を README とエージェント向けの文書に書く。
  - 利用者に前提を課さない方針（map の Notes）からは、1 を既定にして 3 を併記し、2 は使わないのが筋。
- .app を `/Applications` 以外（ダウンロードフォルダなど）から起動したとき、App Translocation でパスが変わると symlink が壊れる。【推論】
  - Sparkle の文書も、translocation を避けるため ZIP には app だけを入れるよう勧めている。【出典】[Sparkle Documentation](https://sparkle-project.org/documentation/)
  - 張る前に `Bundle.main.bundlePath` が `/Applications` 配下かを確かめ、違えば移動を促すのが安全。
  - Sparkle の更新ではパスは同じままなので、symlink は生きる。

## 4. 常駐の作り（MenuBarExtra・設定ウィンドウ・SMAppService）

- `MenuBarExtra` は、メニューバーに常に出る control の Scene。【出典】[MenuBarExtra](https://developer.apple.com/documentation/swiftui/menubarextra)
  - メニューバーだけの app は `MenuBarExtra("…", systemImage: "…") { … }` だけで作れる。
  - 利用者がメニューバーから外すと、その app は終わる。
  - Dock とアプリ切り替えに出さないには、`LSUIElement = true` にする。
  - 状態の表示や操作を多く載せるなら、`.menuBarExtraStyle(.window)` でポップオーバー風の窓にできる。
- 設定ウィンドウは `Settings { … }` の Scene で作る。開くには `SettingsLink`（クリックで開くか前に出す）か、`@Environment(\.openSettings)` を呼ぶ。【出典】[SettingsLink](https://developer.apple.com/documentation/swiftui/settingslink)、[OpenSettingsAction](https://developer.apple.com/documentation/swiftui/opensettingsaction)
  - `LSUIElement` の app では、開いた設定の窓が前に出ないことがある。その場合は `NSApp.activate` などで前に出すことを試作で確かめる。【推論。Apple の文書には記述なし】
- 会議を始める画面（map の (a)）と初回の準備（(b)）は、`Window`/`WindowGroup` の Scene として足し、`openWindow` で開くのが素直。【推論】
- ログイン時の起動は `SMAppService.mainApp` を使う。【出典】[SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)、[mainApp](https://developer.apple.com/documentation/servicemanagement/smappservice/mainapp)、[register()](https://developer.apple.com/documentation/servicemanagement/smappservice/register())【Kanary】
  - macOS 13 から使え、`SMLoginItemSetEnabled` などの代わりになる。
  - `register()` を呼ぶと、main app なら次のログインから起動する。
  - 解除は `unregister()`。登録済みなら `kSMErrorAlreadyRegistered`、利用者が許可していなければ `kSMErrorLaunchDeniedByUser` になる。
  - `status` が `.requiresApproval` なら、登録はできたが利用者がシステム設定で許可する必要がある。利用者が後から許可を取り消したときもこの値になる。【出典】[requiresApproval](https://developer.apple.com/documentation/servicemanagement/smappservice/status-swift.enum/requiresapproval)
  - 設定画面の「ログイン時に開く」の切り替えは、毎回 `status` を読んで表示する（利用者がシステム設定側で変えるため）。`.requiresApproval` のときは `SMAppService.openSystemSettingsLoginItems()` でシステム設定を開く。【推論。API 名は SMAppService の型にある】
  - 既定で登録するかは、利用者に前提を課さない方針と、初回の準備の画面で尋ねるかで決める。Kanary は「ログイン時に起動を無効にしますか」の確認（`__showingDisableLaunchAtLoginConfirmation`）を持つ。【Kanary】
- サーバーとヘルパーを `SMAppService.agent(plistName:)` で LaunchAgent にする道もある（`register()` で即時に bootstrap され、毎回のログインで起動する）。【出典】[register()](https://developer.apple.com/documentation/servicemanagement/smappservice/register())
  - これは map の霧「.app がサーバーとヘルパーをどう起動するか」の論点なので、ここでは触れるだけにする。
  - helper の TCC（画面収録・マイク）の許可が、どの実行ファイルに付くかもその ticket で確かめる必要がある。【推論】

## 後続の ticket（#1871・#1875 など）への含み

- 配布の CI は `macos-26` の 1 job でまとめる。順は build → 内側から codesign → DMG → codesign → `notarytool --key` → `stapler` → `generate_appcast --ed-key-file -` → Release に DMG（と appcast）を上げる。
- secrets は 7 つ。
  - p12 の base64 とパスワード。
  - 一時キーチェーンのパスワード。
  - App Store Connect API キーの .p8 の base64、Key ID、Issuer ID（Team キーの場合）。
  - Sparkle の EdDSA 秘密鍵。
  - profile を使う場合は profile の base64 も足す。
- 同梱する Node の entitlements（`allow-jit` ほか）と、CLI を Mach-O にする方法（ランチャーか Swift の薄いクライアントか）は、試作で決める。
- `LSUIElement` の Sparkle には gentle reminders の実装が要る。
- 名前に触れるもの（bundle id・`SUFeedURL`・CLI 名・symlink 名）は #1857 を待つ。`SUFeedURL` は出荷後に変えにくいので、独自ドメインの有無を名前の map と合わせて決める。

## 出典

- Apple
  - [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
  - [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
  - [Creating distribution-signed code for the Mac](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)
  - [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)
  - [com.apple.security.device.audio-input](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)
  - [com.apple.security.cs.allow-jit](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit)
  - [Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)
  - [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
  - [MenuBarExtra](https://developer.apple.com/documentation/swiftui/menubarextra)
  - [SettingsLink](https://developer.apple.com/documentation/swiftui/settingslink)
  - [OpenSettingsAction](https://developer.apple.com/documentation/swiftui/opensettingsaction)
  - [LSUIElement](https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement)
  - `xcrun notarytool submit --help`（手元の Xcode CLT）
- Sparkle
  - [Documentation](https://sparkle-project.org/documentation/)
  - [Publishing](https://sparkle-project.org/documentation/publishing/)
  - [Customization](https://sparkle-project.org/documentation/customization/)
  - [Programmatic setup](https://sparkle-project.org/documentation/programmatic-setup/)
  - [Gentle reminders](https://sparkle-project.org/documentation/gentle-reminders/)
  - [EdDSA migration](https://sparkle-project.org/documentation/eddsa-migration/)
  - ソース: [generate_appcast/main.swift](https://github.com/sparkle-project/Sparkle/blob/2.x/generate_appcast/main.swift)、[generate_keys/main.swift](https://github.com/sparkle-project/Sparkle/blob/2.x/generate_keys/main.swift)
- GitHub
  - [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
  - [Installing an Apple certificate on macOS runners](https://docs.github.com/en/actions/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development)
  - [Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
- Node: [tools/osx-entitlements.plist](https://github.com/nodejs/node/blob/main/tools/osx-entitlements.plist)
- 手元: `/Applications/Kanary.app` 4.1.4（`plutil -p Info.plist`、`codesign -d --entitlements -`、`codesign -dv`、`spctl -a -vv`、`strings`。2026-11-03）
