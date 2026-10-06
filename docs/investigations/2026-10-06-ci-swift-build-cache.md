# helper の Swift ビルドを CI でキャッシュする方法と効き具合（Issue #220）

map #217（CI を並列化して 1 分未満で green にする）の調査。`helper/.build` を actions/cache で持ち越したときに何が再コンパイルされるか、どれだけ縮むかを、一次情報（swift-driver・llbuild のソースと GitHub のドキュメント）と macos-26 ランナーでの実測で確かめた。結論は次のとおり。

- **`helper/.build` を actions/cache で持ち越すだけでは、Swift のファイルは全部コンパイルし直される。** checkout がファイルの mtime を checkout した時刻にするため、swift-driver が「前回と mtime が違う = 変わった」と判断する（[mtime の扱い](#mtime-の扱い)）。それでも SDK のモジュールなどは再利用されるので、キャッシュなしの 50〜80 秒が 30〜52 秒になる。
- **`-Xswiftc -enable-incremental-file-hashing` を付けると、中身の変わっていない Swift のファイルはコンパイルされない。** mtime が違っても、前回記録した中身のハッシュと同じなら飛ばす（swift-driver の公式オプション。既定は無効）。ソース変更なしで 24〜30 秒、1 ファイル変更で 30 秒（実際にコンパイルしたのは変えたファイルと C++ のシム `apm.cpp` だけ）。
- **ファイルの中身から決まる mtime を付け直すと、さらに 8〜10 秒縮む**（ソース変更なしで 16 秒、1 ファイル変更で 20 秒）。ただし正しさが「mtime の等値で比べる」という実装の挙動に依存するので、まずは上のハッシュのオプションを推す。
- **どの方法でも、`swift build` の最初の 1 回には 13〜22 秒の「ビルド前の準備」が残る**（`[0/1] Planning build` が出るまで）。SwiftPM の共有キャッシュ（`~/Library/Caches/org.swift.swiftpm`、64 KB）を持ち越しても縮まなかった。
- **`swift build --build-tests` → `swift test --skip-build` で成果物を共有できる。** 今の `swift build` → `swift test` も同じ `.build` を使うので二重にはビルドしないが、`swift` の起動 1 回分の準備（十数秒）だけ短くなる。
- **helper を触る PR では、ビルドよりテストの実行が長い。** `swift test --skip-build` は 47〜91 秒で、その大半が 1 つの Suite（`エコーキャンセルの開始直後（実際の WebRTC AEC3）`、52〜56 秒）。キャッシュでビルドを 20 秒前後にしても、Swift のジョブは 1.5 分前後が下限になる。

## 測り方

- 道具: `research/ci-swift-cache` ブランチに一時的なワークフロー（`.github/workflows/research-swift-cache.yml`、計測後に削除）を置き、push のたびに macos-26 のランナーで走らせた。ランナーの Xcode は 26.6、Swift 6.3.3。
- 各ジョブは今の `check.yml` と同じく `helper/.deps/webrtc-apm` を actions/cache で復元してから、`helper/` で `/usr/bin/time -p` を付けて `swift build` / `swift test` を測った。コンパイルしたファイルの数は出力の `Compiling` の行数。
- キャッシュの持ち越しは、`actions/cache/restore` を `key: research-swift-<案>-<sha>`・`restore-keys: research-swift-<案>-` で復元し、毎回 `actions/cache/save` で保存した。1 回目で保存したものを 2 回目以降で復元する。
- 実行（いずれも [Actions](https://github.com/daiki-beppu/live-mindmap/actions/workflows/research-swift-cache.yml)）:
  1. [37443367746](https://github.com/daiki-beppu/live-mindmap/actions/runs/37443367746): キャッシュなし。今の形（`split`）、共有（`shared`）、同じジョブの中で mtime を変えたときの影響。`plain` / `hashing` の 1 回目（保存）
  2. [37444061896](https://github.com/daiki-beppu/live-mindmap/actions/runs/37444061896): ソース変更なし。`plain` / `hashing` を復元
  3. [37444763555](https://github.com/daiki-beppu/live-mindmap/actions/runs/37444763555): ソース変更なし。`plain` / `hashing` を復元、`mtime` の 1 回目、`split` / `shared` の 2 回目
  4. [37445410740](https://github.com/daiki-beppu/live-mindmap/actions/runs/37445410740): ソース変更なし。`plain` / `hashing` / `mtime` を復元、`hashing-swiftpm` の 1 回目
  5. [37445928911](https://github.com/daiki-beppu/live-mindmap/actions/runs/37445928911): `helper/Sources/HelperCore/Timeline.swift` にコメント 1 行を足した。4 案とも復元
- 各条件 1〜3 回。ランナーごとのばらつきが大きく（同じキャッシュなしのビルドで 50〜80 秒）、数秒の差は誤差の範囲。

案の中身:

| 案 | 持ち越すもの | ビルドのオプション |
|---|---|---|
| `plain` | `helper/.build` | なし |
| `hashing` | `helper/.build` | `-Xswiftc -enable-incremental-file-hashing` |
| `mtime` | `helper/.build` | なし。ビルド前に、追跡しているファイルの mtime を中身の SHA-1 から決まる値にする |
| `hashing-swiftpm` | `helper/.build` と `~/Library/Caches/org.swift.swiftpm` | `hashing` と同じ |

## 結果

### `swift build --build-tests` の時間（秒。括弧内は `Compiling` の行数）

`real` は `swift build` 全体、`Build complete` は SwiftPM が出すビルド本体の時間。差がビルド前の準備（マニフェストの評価など）。

| 条件 | 回 | plain | hashing | mtime | hashing-swiftpm |
|---|---|---|---|---|---|
| キャッシュなし | 1・3・4 | 80.5 (—) | 68.7 (—) | 55.1 / 本体 41.9 | 74.2 / 本体 58.7 (45) |
| 復元・ソース変更なし | 2 | 44.3 (44) | 29.8 (1) | | |
| 復元・ソース変更なし | 3 | 43.5 / 本体 23.2 | 23.9 / 本体 11.0 | | |
| 復元・ソース変更なし | 4 | 30.5 / 本体 17.6 (44) | 28.5 / 本体 13.1 (1) | 16.5 / 本体 3.6 (0) | |
| 復元・1 ファイル変更 | 5 | 51.8 / 本体 34.1 (44) | 30.5 / 本体 13.3 (2) | 19.9 / 本体 6.9 (1) | 26.1 / 本体 12.6 (2) |

- `plain` の 44 は、helper の Swift のファイルと C++ のシムのほぼ全部（キャッシュなしは 45）。中身が同じでも全部コンパイルし直している。
- `hashing` の 1 は `apm.cpp`（C++ のシム。Swift ではないのでハッシュのオプションが効かない）。1 ファイル変更では、変えた `Timeline.swift` が加わって 2。
- `mtime` は変更なしで 0、1 ファイル変更で `Timeline.swift` の 1 だけ。変えたファイルはちゃんとコンパイルされた。
- `hashing-swiftpm` は `hashing` と同じ結果。共有キャッシュは `manifests` だけの 64 KB で、ビルド前の準備（16 秒）も縮まなかった。

### キャッシュなしの今の形と共有の形（秒）

| | 回 | `swift build` | `swift test` | 計 |
|---|---|---|---|---|
| 今の形（`split`: `swift build` → `swift test`） | 1 | 43.5 | 95.5 | 139.0 |
| | 3 | 35.8 | 87.5 | 123.3 |
| 共有（`shared`: `swift build --build-tests` → `swift test --skip-build`） | 1 | 59.7 | 59.1 | 118.8 |
| | 3 | 49.5 | 62.6 | 112.1 |

今の形の `swift test` は、テストのターゲットのビルド（20 秒前後）と実行（`Test run ... passed after` 70〜71 秒）を合わせた時間。`swift build` で作ったものは使い回しており、二重にビルドしているわけではない。共有の形で縮むのは、`swift` を 1 回少なく起動する分の準備の時間。

### 同じジョブの中で mtime だけ変えたとき（`shared`、秒）

| | 回 1 | 回 3 |
|---|---|---|
| ビルド直後にもう一度（何も変えない） | 2.1 | 2.6 |
| 追跡しているファイルを全部 `touch` してから | 14.9（44） | 19.1 |
| 同上、`-enable-incremental-file-hashing` を付けて | 6.6（1） | 7.0 |

キャッシュの復元と関係なく、mtime が変わるだけで Swift のファイルは全部コンパイルし直され、ハッシュのオプションでそれが防げることが、ジョブ 1 つの中でも確かめられた（`touch` 後のハッシュありの値は、ハッシュありで 1 回ビルドして記録を作ってから測った）。

### キャッシュの大きさと出し入れ

- `helper/.build` は展開後 194〜205 MB、圧縮したキャッシュは 67〜68 MB。
- 復元のステップは 2〜5 秒、保存のステップは 4〜9 秒（回 5 のステップの時刻から）。
- `helper/.deps/webrtc-apm`（今のキャッシュ）は 11 MB で、1 秒未満。

### テストの実行時間

`swift test --skip-build` は 47〜91 秒（同じ中身で、ランナーによってばらつく）。Swift Testing の出力では、Suite `エコーキャンセルの開始直後（実際の WebRTC AEC3）`（`helper/Tests/HelperCoreTests/EchoCancellerTests.swift` の `EchoCancellerStartupTests`、`.timeLimit(.minutes(2))`）が 52.7 秒 / 56.1 秒で、テスト全体（194 件・33 Suite）の終わりと同時に終わっている。この Suite が律速している。テストを速くする改修は map #217 の範囲外なので、ここに書き残すだけにする。

## mtime の扱い

### swift-driver: 前回と mtime が「等しい」ときだけ飛ばす

swift-driver はインクリメンタルビルドで、各ファイルを前回のビルドの記録（build record）と比べてコンパイルを飛ばすか決める。[`FirstWaveComputer.swift`](https://github.com/swiftlang/swift-driver/blob/main/Sources/SwiftDriver/IncrementalCompilation/FirstWaveComputer.swift) の `computeChangedInputs`:

```swift
case .upToDate where metadata.mTime == previousModTime:
  reporter?.report("May skip current input:", input)
  return nil
case .upToDate where useHashes && (metadata.hash == previousHash):
  reporter?.report("May skip current input (identical hash):", input)
  return nil
case .upToDate:
  reporter?.report("Scheduling changed input", input)
```

- mtime が前回と等しければ飛ばす。等しくなければ、ハッシュを使う設定で中身のハッシュが等しいときだけ飛ばす。それ以外はコンパイルする。
- ハッシュを使うかどうかは `-enable-incremental-file-hashing` / `-disable-incremental-file-hashing` で決まり、既定は無効（[`IncrementalDependencyAndInputSetup.swift`](https://github.com/swiftlang/swift-driver/blob/main/Sources/SwiftDriver/IncrementalCompilation/IncrementalDependencyAndInputSetup.swift) の `hasFlag(positive: .enableIncrementalFileHashing, negative: .disableIncrementalFileHashing, default: false)`）。有効なら入力ファイルの SHA-256 を記録する（[`Driver.swift`](https://github.com/swiftlang/swift-driver/blob/main/Sources/SwiftDriver/Driver/Driver.swift) の `recordedInputMetadata`）。`swiftc -help-hidden` の説明は「Enable hashing of input and dependency file data that can prevent unnecessary invalidation」。
- `actions/checkout` は毎回新しくファイルを書くので、mtime は checkout した時刻になり、前回の記録と必ず違う。そのため `plain` では全部コンパイルし直しになる。

### llbuild: inode まで含めて比べる

SwiftPM のビルドを動かす llbuild は、ファイルが変わったかを `FileInfo` の等値で判定し、device・inode・size・mtime・checksum をすべて比べる（[`FileInfo.h`](https://github.com/swiftlang/swift-llbuild/blob/main/include/llbuild/Basic/FileInfo.h) の `operator==`）。キャッシュの復元や checkout で inode は必ず変わるので、llbuild のコマンド（swift-driver の呼び出し）は毎回走り直す。そのうえで swift-driver が上の比較でファイルごとのコンパイルを飛ばす、という 2 段になっている。`hashing` でも十数秒かかるのは、モジュールの書き出しやリンクが走り直すため（ログでは `Emitting module` と `Linking` が毎回出る）。

### 中身から mtime を決める案（`mtime`）

checkout の後、追跡しているファイルの mtime を「中身の SHA-1 の先頭 7 桁から決まる過去の時刻」に付け直すと、中身が前回と同じファイルは前回と同じ mtime になり、swift-driver の 1 つ目の条件で飛ぶ。中身が変わったファイルは別の mtime になるのでコンパイルされる（回 5 で確認）。

```sh
git ls-files -z helper | xargs -0 perl -MDigest::SHA=sha1_hex -e \
  'for (@ARGV) { open my $f, "<", $_ or die; local $/; my $t = 1000000000 + hex(substr(sha1_hex(<$f>), 0, 7)); close $f; utime $t, $t, $_ }'
```

`hashing` より 8〜10 秒速く、`apm.cpp` もコンパイルし直さない。ただし、変えたファイルの mtime が成果物より古い時刻になるので、「入力が出力より新しければ作り直す」という比べ方をする道具が 1 つでも挟まると、変更を見落として古い成果物でテストが通ってしまう。今の swift-driver と llbuild は等値で比べるので問題ないが、それは公開された約束ではなく実装の挙動。ハッシュのオプションは公開されたオプションで、見落とす方向には壊れない。

## キャッシュのキーと保存の条件

GitHub のドキュメント（[Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)）から、設計に効く点:

- 「Workflow runs can restore caches created in either the current branch or the default branch (usually `main`). If a workflow run is triggered for a pull request, it can also restore caches created in the base branch.」PR のジョブは main で保存したキャッシュを使える。逆に、PR で保存したキャッシュは他の PR や main からは使えない。
- `key` が完全一致しなければ `restore-keys` の前方一致で探し、複数あれば「the most recently created cache」を返す。
- 「You cannot change the contents of an existing cache.」完全一致したキャッシュは上書きできない（保存し直すにはキーを変える）。
- リポジトリ全体で既定 10 GB。7 日アクセスの無いものは消え、超えたら古いアクセス順に消える。

ここから:

- **キーは helper の中身のハッシュで切り、`restore-keys` で直近のものに落とす。** helper を触らない main の push は完全一致して保存しない。helper を触る PR は、main の直近のキャッシュを復元して差分だけビルドする。
- **キーに Swift のバージョンを入れる。** ランナーの Xcode が上がると、SwiftPM は `swift-version-<hash>.txt` が変わったことで作り直す（ログの `Write swift-version-...txt`）。古いキャッシュを復元しても得が無いので、キーを分けておく。
- **保存は main の push だけにする。** PR で保存したものは他から使えず、1 つ 67 MB で 10 GB の枠を食うだけ。
- `.build` には絶対パスが入るが、ランナーの作業ディレクトリは毎回 `/Users/runner/work/live-mindmap/live-mindmap` で同じなので、そのまま使えた。

## 試作で使う YAML

helper のジョブを独立させる前提（`pnpm typecheck` の helper の `swift build` は TS 側から外し、`pnpm --filter '!@live-mindmap/helper' typecheck` などにする）。

```yaml
  helper:
    runs-on: macos-26
    steps:
      - uses: actions/checkout@v7
      - uses: astral-sh/setup-uv@v10.2.0
      - uses: actions/cache@v6
        with:
          path: helper/.deps/webrtc-apm
          key: webrtc-apm-${{ runner.os }}-${{ hashFiles('helper/scripts/build-webrtc-apm.sh') }}
      - run: bash helper/scripts/build-webrtc-apm.sh
      - id: swift
        run: echo "version=$(swift --version 2>&1 | shasum | cut -c1-12)" >> "$GITHUB_OUTPUT"
      - id: build-cache
        uses: actions/cache/restore@v6
        with:
          path: helper/.build
          key: helper-build-${{ runner.os }}-${{ steps.swift.outputs.version }}-${{ hashFiles('helper/Package.swift', 'helper/Sources/**', 'helper/Tests/**', 'helper/scripts/build-webrtc-apm.sh') }}
          restore-keys: helper-build-${{ runner.os }}-${{ steps.swift.outputs.version }}-
      # 中身の変わっていない Swift のファイルは、mtime が違ってもコンパイルしない
      - run: swift build --build-tests -Xswiftc -enable-incremental-file-hashing
        working-directory: helper
      - run: swift test --skip-build
        working-directory: helper
      - if: github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.build-cache.outputs.cache-hit != 'true'
        uses: actions/cache/save@v6
        with:
          path: helper/.build
          key: ${{ steps.build-cache.outputs.cache-primary-key }}
```

- 保存はテストが通った後だけ（既定の `success()`）。
- さらに縮めたいときは、`swift build` の前に上の mtime を付け直す 1 ステップを足し、`-Xswiftc -enable-incremental-file-hashing` は外してよい（8〜10 秒の差。見落としの危険は上のとおり）。
- 見込み: checkout からテストの終わりまで、ビルド 20〜30 秒 + テスト 47〜91 秒 + セットアップと出し入れ 15 秒前後。キャッシュなしの今の Swift 部分（約 2 分）から 30〜50 秒縮むが、1 分には届かない。縮めるならテストの Suite の方。
