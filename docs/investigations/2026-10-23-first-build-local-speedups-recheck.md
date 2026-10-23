# 手元のビルドのまま、初回の時間を縮める手と効き具合: 負荷の低い時間帯での測り直し（Issue #1418）

同じ ticket の先の調査 [`2026-10-23-first-build-local-speedups.md`](2026-10-23-first-build-local-speedups.md) とは別のセッションで、独立に測った記録。先の調査は全体が「並行ビルドあり・参考値」なので、こちらは他のコンパイラが動いていない時間帯を待って測り直した。先の調査と食い違う点・足した点は次のとおり。

- **`-Osize` の効きが食い違う。** 先の調査は FluidAudio 142 → 99〜105 秒・全体 177 → 136 秒（並行ビルドあり）。こちらは全体と交互に流した組で 107.8・112.3・125.4 秒 対 117.6・123.4・125.6 秒、FluidAudio だけで 143.6 対 149.8 秒で、揺れ（±10 秒）を超える差は出なかった。採るかを決める前に、同じ条件で測り直すのがよい。
- **負荷の低いときの値**: AEC3 の compile 36〜37.5 秒（先の調査は 63 秒）、helper の debug 65 秒、release 118〜126 秒。今の流れの Swift は 183 秒、debug を外すと 118〜126 秒（約 1 分短い）。
- **release で名前が揺れたときの作り直しの重さ**: 何もしない 2 回目が、名前が同じなら 1.1〜1.3 秒、変わると 79〜133 秒（その名前で初めてなら 205〜455 秒）。先の調査の「`swift build` は 1 回だけ」という制約を、release の値で裏付けた。
- **足した手**: `swift package resolve`（ビルドしないので名前の揺れに当たらない）を AEC3 と並べる、`-debug-info-format none`、FluidAudio の trait を切る（`traits: []`）。後の 2 つは効かなかった。
- abseil の `.a` の扱いは、先の調査の §6（要る `.a` は `libwebrtc-audio-processing-2.a` 1 つ）がより強い主張で、こちらは「4 つ外してもリンクが通る」までしか確かめていない。

以下はこのセッションの記録そのもの。

map #1415「初回インストール時のビルドを速くする」の research。成果物は配らず、README の「初回の準備」（`pnpm install` → `build-webrtc-apm.sh` → `fetch-speaker-models.sh` → `pnpm dev`）のまま、ビルドの段を縮める手を一次情報と手元の試しで調べた。2 回目以降の作り直しそのもの（#502）は扱わないが、手の効き具合を左右するので、その分だけ測った。

## 結論

| 手 | 効き具合（この Mac、負荷の低いとき） | 採るか |
|---|---|---|
| **helper の debug ビルドを初回から外す**（`fetch-speaker-models.sh` を、`pnpm dev` が作った release の実行ファイルで回す） | **debug の 1 回分 65 秒が丸ごと消える**（負荷のあるときは 109〜137 秒、重いときは 475 秒）。今の流れの Swift ビルド 183 秒（debug 65 + release 118）が 118〜126 秒になる | **採る。ただし `swift` の呼び出しを増やさない形に限る**（下の注意） |
| AEC3 を要るターゲットだけビルドし、`Package.swift` から使わない abseil 4 つを外す | 36〜37.5 秒 → 33 秒（約 4 秒、1 割強） | 小さい。ついでなら |
| AEC3 の最適化を `-O3` → `-O2` | 36 秒 → 35 秒（差は揺れの中） | 採らない |
| AEC3 の並列度（`-j`） | ninja の既定がすでに「コア数 + 2」（12） | 手は無い |
| `stt-bench` を release から外す（`--product live-mindmap-helper`） | 縮まない（同じ負荷の並びで 168 秒 → 179 秒） | 採らない |
| release の `-Osize` / `-debug-info-format none` / FluidAudio の trait を切る（`traits: []`） | 118〜126 秒に対して 108〜127 秒。揺れ（±10 秒）を超える差は無い | 採らない |
| release の whole-module を切る（`-Xswiftc -no-whole-module-optimization`） | ビルドが落ちる | 使えない |
| `vp install` と AEC3 を並べる | 短い方の段の分だけ縮む（`vp install` の時間は #1416 の表で決まる） | 採れる（依存が無い） |
| `swift package resolve`（FluidAudio の取得）と AEC3 を並べる | 空のキャッシュで resolve は 75 秒（回線しだい）。AEC3 の 36 秒ぶんまで重ねられる | 採れる（resolve はビルドしないので下の名前の揺れに当たらない） |
| AEC3 のビルドと FluidAudio のコンパイルを並べる（`swift build --target FluidAudio` を先に走らせる） | 名前が揃えば約 20 秒縮む（157 → 136 秒の見込み）。揺れると 205 秒の作り直しで大きく遅くなる | **採らない**（Command Line Tools の環境では半々で負ける） |

- **release のビルド時間の 8 割前後は FluidAudio の 1 モジュール**（Swift 82,480 行）。release は whole-module なので、型検査と SIL の最適化が 1 本で走る（`-num-threads 10` が効くのは LLVM のコード生成だけ）。`swift build -c release --target FluidAudio` だけで 93〜95 秒（全体は 118〜126 秒）。FluidAudio を手元のオプションで速くする手は見つからなかった。
- **注意: `swift build` の呼び出しを 1 回増やすたびに、約半分の確率で release を作り直す。** #502 のとおり、Command Line Tools だけの環境ではツールチェーンの名前（`TOOLCHAINS`）が呼び出しごとにランダムに変わる。release では、名前が同じなら何もしないビルドが 1.1〜1.3 秒、変わると 79〜133 秒（その名前で初めてなら 205〜455 秒）かかった（6 回中 4 回で変わった）。たとえば「`fetch-speaker-models.sh` で `swift build -c release` → `pnpm dev` でもう一度 `swift build -c release`」にすると、debug を消して浮いた分を、半分の確率で取り返されてしまう。debug を外すなら、モデルの取得は `pnpm dev` が作った実行ファイルを直接起動し、`swift` を呼び直さない形にする（または順番を「`pnpm dev` → `fetch-speaker-models.sh`」に入れ替え、スクリプトは実行ファイルがあればそれを使う）。
- `orca.yaml` のコメントにある「AEC3 は 2 分半」は、負荷の低いこの Mac では compile 36〜37.5 秒・setup 1.4〜10 秒だった。他の作業でビルドが重なっていると 65〜108 秒になった。2 分半は、取得（`git fetch`）や負荷を含んだ値だと思われる。

## 測った環境

- Mac16,12（MacBook Air、Apple M4、10 コア = 性能 4 + 高効率 6、メモリ 16 GB）、macOS 27.0.1（26A434）
- Command Line Tools のみ（`xcode-select -p` = `/Library/Developer/CommandLineTools`）、Apple Swift 6.4（swiftlang-6.4.0.34.1、swift-driver 1.168.6）、ビルドエンジンは既定の Swift Build
- AEC3: meson 1.12.1、ninja 1.13.2（`uvx --from meson --with ninja`）、uv 0.12.17
- 対象: `origin/main` の `4665ce6` を scratch に clone し直したもの。SwiftPM のキャッシュは `--cache-path` で空の場所に、ビルドは `--scratch-path` で別の場所に向けた。利用者のグローバルなキャッシュ・モデル・本体の `helper/.build` には触っていない
- **計測の揺れが大きい。** この Mac では他のエージェントの takt や同じ map の #1416・#1417 の計測が同時に動いており、1 分の load average は 4〜120 で動いた。各回の前に「他の clang / swift-frontend が 0 本、load average が 25 未満」を待ってから始め、表には前後の load average を残した。それでも同じ release のビルドが 118〜364 秒に散ったので、**比べるのは同じ時間帯に交互に流した組だけ**にし、差が 10 秒未満のものは「差なし」と扱った。CPU 時間（user + sys）も併記した

## AEC3（meson + ninja）

### 一次情報

- 固定コミット `d0569cf` の [`meson_options.txt`](https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing/-/blob/d0569cfa50c1858ee279d77b3fc8870be6902441/meson_options.txt) のオプションは `gnustl`（Android だけ）・`neon`・`inline-sse` の 3 つだけ。テストや例を外すオプションは無い。
- [`meson.build`](https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing/-/blob/d0569cfa50c1858ee279d77b3fc8870be6902441/meson.build) にはテスト（`test()`）が無い。例は `subdir('examples')` の `run-offline` 1 本だけ（CPU 3.4 秒）。外す価値は無い。
- abseil は `dependency('absl_base', …)` で探し、pkg-config で見つからなければ wrap の subproject（`abseil-cpp-20240722.0`）をビルドする。subproject 側に `meson_options.txt` は無く、ライブラリを選ぶオプションも無い。subproject は abseil の 15 個の静的ライブラリをすべてビルドする。
- [`meson compile`](https://mesonbuild.com/Commands.html#compile) はターゲット名を並べると、そのターゲット（と依存）だけをビルドする。
- ninja の既定の並列度は「コア数 + 2」（[`GuessParallelism`](https://github.com/ninja-build/ninja/blob/master/src/ninja.cc)）。この Mac では 12 で、`-j` を足しても増やせない。

### 何に時間がかかっているか

ninja のログ（`.ninja_log`）を集計した（負荷の高い回なので、割合だけを見る）。

| 部分 | オブジェクト | CPU 秒 | 割合 |
|---|---|---|---|
| webrtc 本体 | 245 | 690 | 61% |
| abseil | 171 | 438 | 39% |
| うち helper が使わない abseil（`log` 62・`random` 40・`status` 31・`types` 3） | 39 | 136 | 12% |
| 例・アーカイブ | 10 | 4 | 0% |

helper が使う abseil は、webrtc の静的ライブラリの未定義シンボルから推移的にたどると、15 個のうち 11 個（`base`・`container`・`crc`・`debugging`・`flags`・`hash`・`numeric`・`profiling`・`strings`・`synchronization`・`time`）だった。`Package.swift` の `webrtcAPMLibraries` から `libabsl_log`・`libabsl_random`・`libabsl_status`・`libabsl_types` を外しても、`live-mindmap-helper`・`live-mindmap-apple`・`stt-bench` の release のリンクは通った（テストのターゲットのリンクと実行は確かめていない）。

### 試し（負荷の低い時間帯、新しいビルドディレクトリ、ソースと abseil の tarball は取得済み）

| 条件 | setup | compile | user + sys |
|---|---|---|---|
| 今のスクリプトと同じ | 1.7〜2.4 秒 | 36.1〜37.5 秒 | 250〜272 秒 |
| 要るターゲットだけ（`meson compile` に 19 個のターゲットを並べる。オブジェクト 402 → 369） | 1.8 秒 | 33.0 秒 | 247 秒 |
| `-Doptimization=2`（今は `buildtype=release` で `-O3`） | 1.4 秒 | 35.0 秒 | 266 秒 |

- 初回の setup は abseil の tarball と wrap のパッチの取得を含み 10.3 秒だった（回線しだい）。
- ターゲットを絞る手は約 4 秒（1 割強）。`-O2` は揺れの中。AEC3 は会議中に音声を処理するので、効かない最適化の変更はしない方がよい。
- 負荷のあるときの今のスクリプトと同じ条件: 65.6・75.3・81.6・96.9・107.4 秒。

## helper の Swift

### 一次情報

- SwiftPM が Swift Build に渡す構成（[`PackagePIFBuilder.swift`](https://github.com/swiftlang/swift-package-manager/blob/4caf32bf260fadbbe9b7f2155f1a58a444d20bf2/Sources/SwiftBuildSupport/PackagePIFBuilder.swift#L708-L731)）: debug は `SWIFT_OPTIMIZATION_LEVEL = -Onone`・`GCC_OPTIMIZATION_LEVEL = 0`・`DEBUG_INFORMATION_FORMAT = dwarf`。release は `-Owholemodule`・`GCC_OPTIMIZATION_LEVEL = s`・`dwarf-with-dsym`（dSYM を作る）。ビルド中の FluidAudio の `swift-frontend` は、release では 1 本（318 ファイルを丸ごと）に `-O` と `-num-threads 10`、debug ではファイルごとに `-primary-file` だった。
- debug と release は別の構成なので、成果物は使い回されない（同じ scratch で debug の後に release を流しても 117.6 秒かかり、debug 無しの 118〜126 秒と変わらない）。
- `swift run <product>` はその製品と依存だけをビルドする（`swift run live-mindmap-helper` 相当の `swift build --product live-mindmap-helper` は 382 手順、全体の release は 385 手順）。`stt-bench` やテストのターゲットは、もともと `fetch-speaker-models.sh` の debug ビルドには入っていない。テストのターゲットは `--build-tests`（`pnpm typecheck`）のときだけビルドされ、README の初回の準備には `pnpm typecheck` は無い。
- FluidAudio の `Package@swift-6.2.swift`（[`ea63ac3`](https://github.com/FluidInference/FluidAudio/blob/ea63ac36fcadb8a6611d0f58a8e4a0e7dd4381e2/Package%40swift-6.2.swift)）は、Rust 製の NeMo のテキスト正規化（xcframework、約 87 MB の zip）を既定の trait `NemoTextProcessing` にしている。使う側が `.package(url:…, traits: [])` で切れる（[SE-0450](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0450-swiftpm-package-traits.md)、Swift 6.1 から。helper の `swift-tools-version` を 6.1 以上にする必要がある）。切っても `swift package resolve` は zip を取りに行った。
- FluidAudio は 1 モジュールに ASR（26,379 行）・TTS（27,995 行）・話者分離（16,853 行）などを抱える。helper が使うのは話者分離と話者の埋め込みだけだが、モジュールの中を選んでコンパイルする手は SwiftPM に無い。

### 試し（release は `swift build --configuration release`、`swift package clean` の後）

| 条件 | 経過 | user + sys | 備考 |
|---|---|---|---|
| debug・`--product live-mindmap-helper`（`swift run` 相当） | 64.6 秒 | 207 秒 | 負荷あり: 108.7・137.0 秒、重い: 474.6 秒 |
| release・全体（`pnpm dev` 相当） | 117.6・123.4・125.6 秒 | 265〜285 秒 | 負荷あり: 168・215・225・287・364 秒 |
| release・`--product live-mindmap-helper`（`stt-bench` 抜き） | 178.9 秒 | 301 秒 | 隣の全体の回は 168.1 秒（325 秒）。縮まない |
| release・`-Xswiftc -Osize` | 107.8・112.3・125.4 秒 | 252〜280 秒 | 全体と交互に流した組で差なし |
| release・`-debug-info-format none` | 113.0 秒 | 253 秒 | 差なし |
| release・FluidAudio の `traits: []` | 121.5・126.6 秒 | 280〜282 秒 | 差なし |
| release・`-Xswiftc -no-whole-module-optimization` | 失敗 | — | Swift Build が whole-module の出力（`FluidAudio-primary.d`）を待って落ちる |
| release・`--target FluidAudio` だけ | 92.6〜95.3 秒 | 169〜174 秒 | 負荷あり: 149.8 秒（全体 168 秒の回の隣） |
| `swift package resolve`（空のキャッシュ） | 74.7 秒 | 18 秒 | FluidAudio の clone と xcframework 87 MB の取得。回線しだい |

### 2 回目の `swift build` が作り直す確率（名前の揺れ）

release を全部ビルドした後、何も変えずに `swift build --configuration release` を続けて流した。各回のビルド記述の `build-request.json` にある `TOOLCHAINS` を記録した（#502 と同じ見方）。

| 回 | 前回と名前 | 経過 | 手順 |
|---|---|---|---|
| 1 | 変わった（この名前で初めて） | 455.9 秒（負荷あり） | 318 |
| 2 | 変わった | 133.3 秒 | 49 |
| 3 | 変わった | 127.6 秒 | 49 |
| 4 | 同じ | 1.3 秒 | 1 |
| 5 | 変わった | 79.0 秒 | 49 |
| 6 | 同じ | 1.1 秒 | 1 |

`--target FluidAudio` の後に全体を流した組では、名前が同じ 2 回が 42.1・44.1 秒（FluidAudio は使い回された）、変わった 1 回が 205.4 秒（FluidAudio から作り直した）だった。release は whole-module なので、名前が変わると FluidAudio の 1 本をまるごとやり直し、debug の作り直し（#502 では 17〜30 秒）より重い。

## 初回の段どうしを並べる

| 組 | 依存 | 見込み |
|---|---|---|
| `vp install` ∥ AEC3 | 無い（AEC3 は uv と git だけ使う） | 短い方の段の分だけ縮む |
| `swift package resolve` ∥ AEC3 | 無い。resolve はビルドしないので、名前の揺れの影響を受けない | AEC3 の 36 秒ぶんまで（resolve は回線しだいで、この Mac では 75 秒） |
| AEC3 ∥ helper のビルド（`fetch-speaker-models.sh`） | ある。`CWebRTCAPM` が AEC3 のヘッダーとライブラリを使う | 並べると落ちる（`docs/knowledge/takt-runs.md` の #1316 の run。上の依存で説明がつく） |
| AEC3 ∥ `swift build --target FluidAudio` → 全体 | FluidAudio は AEC3 を使わない | 名前が同じなら max(37, 94) + 43 ≈ 136 秒（並べない 37 + 120 ≈ 157 秒より約 20 秒短い）。変わると 94 + 205 ≈ 300 秒。Command Line Tools の環境では半々なので、平均では損 |
| `cli install chromium` / `claude` ∥ helper のビルド | サーバーが要り、サーバーは helper の実行ファイルが無いと起動せずに終わる | 今の作りでは並べられない（並べるにはサーバーの起動の条件を変える。ダウンロードは map の範囲外） |

並べて流した試し（AEC3 と `--target FluidAudio` を同時に流し、その後に全体）は 424.8・508.4 秒（508 秒の回は後の全体で FluidAudio を作り直した）、並べなかった試し（AEC3 → 全体）は 425.5・528.7 秒で、どれも負荷の高い時間帯だった。揺れが大きく、この組からは結論を出していない。上の見込みは、負荷の低い時間帯の単独の値から足し合わせたもの。

## 手の組み合わせの見込み（負荷の低いこの Mac、ダウンロードを除く）

| 流れ | AEC3 | Swift | 計 |
|---|---|---|---|
| 今（AEC3 → `swift run`（debug） → `pnpm dev`（release）） | 37 秒 | 65 + 118〜126 秒 | 220〜228 秒 |
| debug を外す（`pnpm dev` の release の実行ファイルでモデルを取る。`swift` は 1 回） | 37 秒 | 118〜126 秒 | 155〜163 秒 |
| 上に、AEC3 のターゲットを絞る | 33 秒 | 118〜126 秒 | 151〜159 秒 |
| debug を外すが `fetch-speaker-models.sh` で `swift build -c release` を呼び、`pnpm dev` でもう一度呼ぶ | 37 秒 | 118〜126 秒 + 半分の確率で 79〜205 秒 | 平均では今とほぼ変わらない |

`resolve` と `vp install` を AEC3 と並べる分は、回線と #1416 の表しだいなので、この表には入れていない。

## 確かめていないこと

- Xcode を入れた環境（名前の揺れが起きない見込み）での値。そこでは「AEC3 ∥ FluidAudio」の約 20 秒が素直に効くはず。
- テストのターゲット（`pnpm typecheck`）のリンクが、abseil 4 つを外しても通るか。
- 試しの回数は条件ごとに 1〜3 回。負荷の揺れより小さい差（10 秒未満）は判定していない。
