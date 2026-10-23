# 手元のビルドのまま、初回の時間を縮める手と効き具合（Issue #1418）

map #1415「初回インストール時のビルドを速くする」の調査。成果物を配らず、clone したばかりの Mac で README（`README.ja.md` の「初回の準備」と `README.md` の `Getting started`）の手順から `pnpm dev` が起動するまでのビルドの時間を、どの手でどれだけ縮められるかを、一次情報と手元の計測で調べた。2 回目以降の作り直し（#502）、依存のダウンロードの速さ、CI は扱わない。

結論は次のとおり。

- **いちばん効くのは、初回の手順での helper の Swift のビルドを release の 1 回にまとめること。** 今は `fetch-speaker-models.sh` の `swift run`（debug）と `pnpm dev` の `swift build -c release` で、FluidAudio を含めて 2 回ビルドしている。同じ時間帯の計測で、debug → release の 2 回が **494 秒（CPU 751 秒）**、release の 1 回が **261 秒（CPU 406 秒）**。約 4 分（CPU で約 46%）縮む。
- **まとめる形は「2 回目の `swift build` を呼ばない」形にする。** release を 2 回呼ぶ形（`fetch` を `swift run -c release` にするだけ）では、#502 のツールチェーンの名前の揺れで、2 回目が約 4 割の確率で全部を作り直す。手元でも、同じ `swift build -c release` を続けて 2 回流した 2 回目が 484 秒かかった。おすすめは、`pnpm dev` の 1 回のビルドの後に、モデルの取得をビルド済みの `helper/.build/release/live-mindmap-helper install-speaker-models` で回す順にすること。
- **AEC3 のビルドは、Swift のビルドと並べて流せば時間の合計からほぼ消える。** AEC3 は約 1 分（compile 59〜98 秒）で 10 コアをほぼ使い切るが、Swift の release は FluidAudio の whole-module の 1 ジョブ（約 140 秒）が律速でコアが空く。同時に流すと合計 229 秒で、Swift だけの 261 秒より長くならなかった（並行ビルドあり・参考値）。ただし helper の `CWebRTCAPM` は AEC3 のヘッダーとライブラリを要るので、順序の作り方に工夫が要る（後述）。
- **`-Osize` は FluidAudio のコンパイルを約 3 割（142 秒 → 99〜105 秒）縮める。** helper の実行時の性能への影響は測っていない。会議中の CPU を担う部分なので、採るなら性能の計測が先。
- AEC3 の meson で要らないターゲットを外す手（`meson compile <ターゲット>`）は CPU で約 7% しか縮まない。meson のオプションでテストや例を外す手は、この版には無い。abseil を Homebrew 等のビルド済みで済ませれば AEC3 の compile の約 55% が消える見込みだが、前提の道具が増える。
- whole-module を外す（`-no-whole-module-optimization`）と CPU が 2 倍以上になり、壁時計もほとんど縮まないので採らない。

## 測り方

- マシン: Apple M4（10 コア = 性能 4 + 効率 6）、メモリ 16 GB、macOS 27.0.1（26A434）。Xcode は無く Command Line Tools 27.0.0（`swift-driver 1.168.6`、Apple Swift 6.4 `swiftlang-6.4.0.34.1`、Apple clang 21.0.0）。meson 1.12.1・ninja 1.13.2（`uvx` 経由）。SwiftPM の既定のビルドエンジンは Swift Build（`--build-system swiftbuild`）。
- まっさらなビルドは、毎回新しい `--scratch-path`（scratchpad の下）で取った。依存の取得（`swift package resolve`）は計測の前に済ませ、計測には含めない。利用者のグローバルなキャッシュ（`~/Library/Caches/org.swift.swiftpm` 等）は消していない。AEC3 は worktree の `helper/.deps` でスクリプトをそのまま流した 1 回と、取得済みのソースから別のビルドディレクトリへ `meson setup` → `meson compile` を流した回を測った。
- 壁時計と、`/usr/bin/time -p` の user + sys（子孫を含む CPU 時間）を取った。Swift のフロントエンドごとの内訳は `-Xswiftc -stats-output-dir` で取った。
- **計測の間、同じ Mac で別のセッションのビルド（Swift のまっさらな release ビルドなど）が並行していた。** ロードアベレージは 10〜140 で動いた。下の表では、計測の前後に `ps` で他の `swift-build`・`meson`・`ninja` を確かめ、重なったものを「並行ビルドあり・参考値」とした。完全に重ならなかった計測は無い。手どうしの比較は、同じ時間帯に続けて取った組で並べた。壁時計は数十 % 揺れるので、CPU 時間も並べる。

## 1. 今の初回の手順で、どこで何がビルドされるか

README の順（`README.md` の `Getting started`。`README.ja.md` の「初回の準備」は `pnpm dev` の後の `cli install` と話者分離のモデルの取得を書く）:

| 段 | 呼ばれるもの | ビルドされるもの |
|---|---|---|
| `pnpm install` | — | （ビルドなし） |
| `bash helper/scripts/build-webrtc-apm.sh` | `meson setup` + `meson compile`（`--buildtype=release`、`--default-library=static`） | webrtc-audio-processing と abseil の subproject。既定のターゲット全部（426 手順） |
| `bash helper/scripts/fetch-speaker-models.sh` | `swift run --quiet live-mindmap-helper install-speaker-models` | debug の `live-mindmap-helper` と、その依存（FluidAudio・HelperCore・CWebRTCAPM） |
| `pnpm dev` | `server` の `dev` = `swift build -c release --package-path ../helper && node src/server.ts` | release の全プロダクト（`live-mindmap-helper`・`live-mindmap-apple`・`stt-bench`） |

- `swift build` はプロダクトを指定しないと、ルートのパッケージの全ターゲット（テストは除く）をビルドする。開発者向けの `stt-bench` もここに入る。
- server が使う実行ファイルは `helper/.build/release/live-mindmap-helper`（`server/src/helperPath.ts`）と `helper/.build/release/live-mindmap-apple`（`server/src/appleIntelligence.ts`。ローカルモード）。`stt-bench` は使わない。
- `pnpm typecheck`（`helper` の `typecheck` = `pnpm build-apm && … && swift build --build-tests …`）は README の初回の手順に無い。開発者が PR の前に回すもので、この調査の対象外。

## 2. 手ごとの表

| 手 | 効き具合 | 副作用・リスク | 根拠 |
|---|---|---|---|
| **A. Swift のビルドを release の 1 回にし、モデルの取得はビルド済みの実行ファイルで回す** | 実測: debug → release の 494 秒（CPU 751 秒）→ release 1 回 261 秒（CPU 406 秒）。約 4 分縮む（並行ビルドあり・参考値。同じ時間帯の組） | README の順が「`pnpm dev` → 別のターミナルでモデルの取得」に変わる（`cli install` と同じ置き方）。`fetch-speaker-models.sh` が release の実行ファイルを前提にするので、無いときの案内が要る | §3 |
| A'. `fetch-speaker-models.sh` を `swift run -c release` にするだけ | 1 回目は A と同じ。ただし `pnpm dev` の 2 回目の `swift build` が #502 で約 4 割の確率で全部を作り直す（手元で 484 秒）。期待値で A より約 1.5〜3 分悪い | 作り直しが起きるかは運しだいで、初回の時間がばらつく | §3、#502 の調査 |
| B. 初回のビルドから `stt-bench` を外す（`--product live-mindmap-helper` と `--product live-mindmap-apple`） | 見込み: release の 1 回から 15〜30 秒。`stt-bench` のフロントエンドは 12〜33 秒、ほかにリンクと dSYM | `--product` は 1 回に 1 つなので `swift build` が 2 回になり、2 回目に #502 の作り直しの危険が付く（ただし `live-mindmap-apple` は FluidAudio に依存しないので、作り直しても小さい）。手元では helper の後に全プロダクトを流すと FluidAudio が作り直された（115 秒） | §3 |
| C. AEC3 のビルドを Swift のビルドと並べる | 実測: 並べて合計 229 秒。AEC3 だけ 63 秒、Swift だけ 261 秒（並行ビルドあり・参考値）。AEC3 の約 1 分がほぼ消える | `CWebRTCAPM` が `.deps` のヘッダー（`src`・`build`・`abseil`）とライブラリを要る。ヘッダーは `meson setup` の直後に揃い、ライブラリはリンクのとき要るので、Swift を先に走らせ始める形は競争になる。確実なのは `swift build --target FluidAudio` を AEC3 と並べ、その後に本体を 1 回ビルドする形だが、`swift build` が 2 回になり #502 の危険が付く | §4 |
| D. `vp install`（`pnpm install`）と AEC3 を並べる | 見込み: `vp install` の時間（主にダウンロード。この調査では測っていない）がほぼ消える | AEC3 のスクリプトは git と uv だけを要り、node_modules を使わない。Swift のビルドも node_modules を使わない | `helper/scripts/build-webrtc-apm.sh` |
| E. release を `-Osize` にする | 実測: FluidAudio のフロントエンド 142 秒 → 99〜105 秒、release の全体 177 秒 → 136 秒（CPU 251 → 207 秒）（2 回ずつ、並行ビルドあり・参考値） | 会議中の CPU を担う helper（AEC3 の前後処理、Sortformer の前後処理、OCR の判定など）の速さに効く可能性。採るなら `stt-bench` 等で性能を測ってから | §5 |
| F. AEC3 で使うターゲットだけをビルドする（`meson compile -C build webrtc-audio-processing-2`） | 実測: CPU 295〜309 秒 → 274〜289 秒（約 7%）。手順 426 → 369 | 小さい。`helper/.deps/webrtc-apm/lib` の `libabsl_log.a`・`libabsl_random.a`・`libabsl_status.a` ができなくなるので、`Package.swift` のリンクの列から外す必要がある（そもそも全部の abseil の `.a` は要らない。§6） | §6 |
| G. abseil を subproject で毎回ビルドせず、ビルド済み（Homebrew の `abseil` 等）を pkg-config で使う | 見込み: AEC3 の compile の約 55%（ninja の手順の合計 1037 秒のうち abseil 590 秒）が消え、約 1 分 → 約 30 秒 | 前提の道具（Homebrew と pkg-config）が増える。abseil の版（`>= 20240722`）と C++ 標準をそろえる必要があり、上流は subproject を「いちばん確実」としている。`Package.swift` のリンク先も変わる | §6 |
| H. Swift の whole-module を外す（`-Xswiftc -no-whole-module-optimization`） | 実測: 壁時計 177 秒 → 146 秒だが、CPU 251 秒 → 561 秒（並行ビルドあり・参考値） | CPU が 2 倍以上。負荷の高い Mac では遅くなりうる。ファイルをまたぐ最適化が無くなり実行時の性能が落ちうる。採らない | §5 |
| I. debug を残すなら index store を切る（`--disable-index-store`） | 測っていない。A を採れば debug のビルドが無くなるので不要 | — | SwiftPM の `PackagePIFBuilder`（debug は `INDEX_ENABLE_DATA_STORE = YES`） |
| J. release の dSYM を作らない（`-debug-info-format none`） | 測っていない。見込みは数秒（実行ファイル 3 本の `dsymutil`） | クラッシュ時のシンボル情報が減る | SwiftPM の `SwiftBuildSystem`（release は `dwarf-with-dsym`） |

組み合わせの見込み: A + C + D で、ビルドの時間は「AEC3 約 1〜1.5 分 + debug 約 3 分 + release 約 5 分」から「release 約 4〜4.5 分（AEC3 は並べて隠れる）」になる。E を足すとさらに 30〜40 秒。

## 3. helper の Swift のビルドをまとめる（A・A'・B）

### 計測

| 組（同じ時間帯に続けて取った） | debug（`--product live-mindmap-helper`） | release（全プロダクト） | 合計 | 他のビルド |
|---|---|---|---|---|
| 1 回目（21:59〜） | 373 秒 / CPU 371 秒 | 608 秒 / CPU 499 秒 | 981 秒 / CPU 870 秒 | あり（ロード 30〜140）・参考値 |
| 2 回目（22:40〜） | 201 秒 / CPU 332 秒 | 316 秒 / CPU 469 秒 | 517 秒 / CPU 801 秒 | あり（ロード 20〜50）・参考値 |
| 3 回目（23:12〜） | 169 秒 / CPU 306 秒 | 325 秒 / CPU 445 秒 | 494 秒 / CPU 751 秒 | 前 4・後 0 件・参考値 |

| release だけ（まっさら） | 壁時計 / CPU | 他のビルド |
|---|---|---|
| 全プロダクト（22:32〜） | 356 秒 / CPU 414 秒 | あり（ロード 20〜30）・参考値 |
| 全プロダクト（3 回目の直後） | 261 秒 / CPU 406 秒 | 前 0・後 6 件・参考値 |
| `--product live-mindmap-helper` | 215 秒 / CPU 332 秒 | ロード 10〜15（重なりは未記録）・参考値 |
| 続けて `--product live-mindmap-apple` | 32 秒 / CPU 41 秒 | 同上 |
| 続けて全プロダクト | 115 秒 / CPU 123 秒（FluidAudio を作り直した） | 同上 |
| 全プロダクトの直後に同じコマンドをもう 1 回 | 484 秒 / CPU 481 秒（FluidAudio から全部作り直した） | あり（ロード 40〜50）・参考値 |

- debug と release を両方ビルドすると、CPU で release 1 回の約 1.9 倍（751〜870 秒 対 406〜414 秒）。FluidAudio（約 11 万行、380 ファイル）を構成ごとにコンパイルするのが大半で、debug では FluidAudio のフロントエンド 15 ジョブの合計が約 430 秒、HelperCore が約 48 秒だった（`-stats-output-dir`、並行ビルドあり）。
- Swift Build は SDK のモジュール（Foundation・CoreML など）を、ビルドの設定と配備先（helper は macOS 26.0、FluidAudio は macOS 14）ごとに、scratch の下（`out/SDKExplicitPrecompiledModules`）へ明示的にビルドする。release だけで 431 個、debug と release で 500 個になった。構成を 1 つにすればこの分も減る。
- **同じ `swift build -c release` の 2 回目が全部を作り直した（484 秒）。** #502 の調査（`research/helper-swift-rebuild` ブランチの `docs/investigations/2026-10-08-helper-swift-rebuild.md`）の原因と同じで、Command Line Tools だけの環境では Swift Build がツールチェーンを実行ごとに 2 通りの名前で引き、名前が変わると全部をコンパイルし直す（52 回中 21 回）。このため A' のように release を 2 回呼ぶと、2 回目が約 4 割の確率で 1 回目と同じくらいかかる。期待値で「release 1 回 + 0.4 × release 1 回」になり、今（debug + release）より良いが、A より 1.5〜3 分悪く、ばらつく。
- `--product live-mindmap-helper` の後に全プロダクトを流したときの FluidAudio の作り直し（115 秒）が、プロダクトの組の違いによるものか #502 によるものかは切り分けていない。

### A の形

1. `pnpm dev`（`swift build -c release`）を、初回の Swift のビルドのただ 1 回にする。
2. 話者分離のモデルの取得は、`pnpm dev` の起動の後に、別のターミナルでビルド済みの実行ファイルで回す。`fetch-speaker-models.sh` の `swift run --quiet live-mindmap-helper install-speaker-models` を、`.build/release/live-mindmap-helper install-speaker-models` に替える（無ければ `pnpm dev` を先に、と案内して止まる）。`cli install` と同じく「サーバーを起動してから別のターミナルで」の並びになる。モデルが要るのは会議の開始時なので、取得が `pnpm dev` の後になっても困らない。
3. `server/src/helperPath.ts` の案内（`swift build -c release --package-path helper`）は今のままでよい。

`swift run` は `-c` を付けなければ debug でビルドする（手元でも `out/Products/Debug` にできた）。`fetch-speaker-models.sh` を `swift run -c release` にする形は、`pnpm dev` の前にあれば A'、後にあっても `swift run` が `swift build` を呼ぶので 2 回目のビルドに当たる。

## 4. 初回の段どうしを並べる（C・D）

- 依存: AEC3 のスクリプトは `git` と `uv` だけを使い、node_modules を使わない。helper の Swift のビルドは `CWebRTCAPM` のために `.deps/webrtc-apm` の `src`・`build`・`abseil`（`-I`、`Package.swift`）と、`lib/*.a`（リンク）を要る。`.deps` が無いと `apm.cpp` が `#error` で止まる。FluidAudio と SDK のモジュールは `.deps` を要らない。
- 計測（すべて並行ビルドあり・参考値）: AEC3 だけ compile 59〜98 秒（CPU 約 300 秒で、10 コアをほぼ使い切る）。Swift の release のまっさらなビルドと AEC3（別のビルドディレクトリ）を同時に始めると、合計 229 秒で終わり、AEC3 の compile は 61 秒（CPU 289 秒）だった。Swift だけのまっさらな release は 261〜356 秒。
- 理由: release の律速は FluidAudio の whole-module のフロントエンド 1 本（約 140 秒。うち SIL の最適化が約 88 秒で 1 スレッド）で、その間は他のコアが空く。AEC3 の ninja の 12 並列がそこに入る。
- 並べ方の候補:
  - C1: `swift build -c release --target FluidAudio` を AEC3 と並べ、両方の後に `swift build -c release` を 1 回。確実だが `swift build` が 2 回になり、2 回目に #502 の作り直しの危険が付く（作り直すと FluidAudio の 2 分強が戻る）。
  - C2: AEC3 のソースの取得と `meson setup` だけを先に済ませ（ヘッダーが揃う。数秒）、`meson compile` と `swift build -c release` を同時に始める。`swift build` は 1 回で済むが、リンクまでに AEC3 のライブラリができている前提の競争になる。リンクは手元で 200 秒前後、AEC3 は約 1 分なので通常は間に合うが、遅い Mac での保証は無い。
  - 落ち着いた形は、#502 が直るまでは C を見送り、A と D だけを採ることかもしれない。C の約 1 分は、A の約 4 分に比べて小さい。
- D: `vp install` と AEC3 は互いに要らないので、並べられる。`vp install` の時間は主にダウンロードで、この調査では測っていない。

## 5. release の最適化の設定と FluidAudio（E・H）

- SwiftPM（Swift Build）の release の設定は `SWIFT_OPTIMIZATION_LEVEL = -Owholemodule`、`GCC_OPTIMIZATION_LEVEL = s`、`DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`。debug は `-Onone`、`ENABLE_TESTABILITY`、`INDEX_ENABLE_DATA_STORE = YES`（[`PackagePIFBuilder.swift`](https://github.com/swiftlang/swift-package-manager/blob/8bfed8d256576a7a54bae4e540570f9643e95e2f/Sources/SwiftBuildSupport/PackagePIFBuilder.swift#L708-L731)。`main` の版で、手元の 6.4 も `-stats-output-dir` のファイル名がモジュールごとに `-O` の 1 ジョブ（`…-all-…-O`）で、同じ形だった）。
- whole-module では FluidAudio の 1 モジュールを 1 つのフロントエンドで最適化する。`-stats-output-dir` の内訳（release の全プロダクト、2 回ずつ。並行ビルドあり・参考値）:

| 設定 | FluidAudio（うち SIL 最適化） | HelperCore | stt-bench | ビルド全体（壁時計 / CPU） |
|---|---|---|---|---|
| 既定（`-O` WMO） | 142.5 秒（88.1）、141.7 秒（89.4） | 13.9 秒 | 12.4 秒 | 177 秒 / 251 秒 |
| `-Xswiftc -Osize` | 105.4 秒（66.5）、99.2 秒（56.6） | 12.3 秒 | 8.0 秒 | 136 秒 / 207 秒 |
| `-Xswiftc -no-whole-module-optimization` | 321 ジョブの合計 1066.8 秒 | 57 ジョブの合計 112.8 秒 | 23.6 秒 | 146 秒 / 561 秒 |

（この 3 つは SDK のモジュールの一部が前の回から残った scratch で取ったので、まっさらな値より短い。フロントエンドの行どうしの比較に使う。最初の `-O` の回は HelperCore が 85 秒と出たが、ロード 114 の時間帯で外れ値として除いた）

- `-Osize` は、インライン化の大きさの上限を下げるなど、コードを複製する最適化を控える（[Swift.org のブログ「Code Size Optimization Mode in Swift 4.1」](https://www.swift.org/blog/osize/)）。そのぶん SIL の最適化が軽くなり、FluidAudio で約 3 割縮んだ。同じブログは、実行時の性能の低下は多くのアプリで 5% 未満だが、性能に敏感なコードには `-O` のほうが良いことがある、としている。helper は会議中に音声と画面を処理するので、採るなら `stt-bench` と会議 1 本の CPU 使用率を測ってからにする。FluidAudio だけに掛けることは、依存パッケージの設定を外から変えられないのでできない（`-Xswiftc` は全ターゲットに掛かる）。
- FluidAudio には、使わない部分を外すオプションが無い。Swift 6.2 以降の manifest（`Package@swift-6.2.swift`）の trait は `NemoTextProcessing`（ビルド済みの xcframework）だけで、コンパイルの時間には効かない。ソースは TTS 約 2.8 万行、ASR 約 2.6 万行、Diarizer 約 1.7 万行などで、helper が使うのは話者分離（Sortformer・WeSpeaker）の部分。使う部分だけを手元に写して local package にすれば半分ほどに減る見込みだが、上流の追従が手作業になる（[FluidAudio の `Package.swift`、固定コミット `ea63ac36`](https://github.com/FluidInference/FluidAudio/blob/ea63ac36fcadb8a6611d0f58a8e4a0e7dd4381e2/Package.swift)）。

## 6. AEC3（webrtc-audio-processing）の meson（F・G）

- 固定コミット `d0569cfa` の [`meson_options.txt`](https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing/-/blob/d0569cfa50c1858ee279d77b3fc8870be6902441/meson_options.txt) にあるのは `gnustl`・`neon`・`inline-sse` の 3 つだけで、テストや例を外すオプションは無い。[`meson.build`](https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing/-/blob/d0569cfa50c1858ee279d77b3fc8870be6902441/meson.build) は `subdir('examples')` を無条件に読み、例は `run-offline` の 1 本（リンク込み約 1.3 秒）だけ。テストのディレクトリは meson に無い。
- abseil: `dependency('absl_base', …)` などを pkg-config・cmake で探し、見つからないと wrap の subproject（`subprojects/abseil-cpp.wrap`、20240722.0）にフォールバックする。この Mac には pkg-config も cmake も無いので、毎回 subproject をソースからビルドしている（ログの `Did not find pkg-config` → `Looking for a fallback subproject`）。上流のコメントは、C++ 標準を厳密にそろえる必要から subproject を「いちばん確実」としている。
- 時間の内訳（`build/.ninja_log`、手順ごとの壁時計の合計 1037 秒、並行ビルドあり）: `libwebrtc-audio-processing-2.a` 282 秒、abseil 計 約 590 秒（strings 188、flags 71、time 60、crc 56、synchronization 49、base 39、log 26、random 25、…）、`liblibbase.a` 74 秒。ninja は既定で 12 並列（コア数 + 2）で、手順の合計 / 壁時計 ≒ 12 と、並列は既に効いている。並列度を上げても縮まない。
- **要る `.a` は `libwebrtc-audio-processing-2.a` 1 つだった。** meson は、install する静的ライブラリが install しない内部の静的ライブラリに `link_with` すると、`link_whole` に格上げしてその中身を取り込む（[meson 1.12.1 の `mesonbuild/build.py`、`StaticLibrary.link`](https://github.com/mesonbuild/meson/blob/1.12.1/mesonbuild/build.py#L2458-L2467)）。手元の `libwebrtc-audio-processing-2.a` は 369 個のオブジェクトを持ち、`liblibbase`・`liblibapi`・`libcommon_audio`・`libsystem_wrappers` と、abseil の base・container・crc・debugging・flags・hash・numeric・profiling・strings・synchronization・time・types を中に含んでいた（`ar t`）。含まないのは abseil の `log`・`random`・`status` と `run-offline` で、これらは `meson compile` が既定で全ターゲットを作るからビルドされている。`Package.swift` が並べる abseil の `.a` 15 本は、リンクに要らない重複。
- F の計測: `meson compile -C build webrtc-audio-processing-2`（[`meson compile` の TARGET 指定](https://mesonbuild.com/Commands.html#compile)）で手順 426 → 369、CPU 295〜309 秒 → 274〜289 秒（約 7%）。壁時計は 98・72・64 秒 → 70・51・65 秒で、並行ビルドの揺れより小さい差。
- G の見込み: abseil をビルド済みで済ませれば、ninja の手順の合計の約 55% が消える。AEC3 の約 1 分が約 30 秒になる見込み。ただし AEC3 は手 C で Swift と並べれば合計から隠れるので、前提の道具を増やしてまで採る価値は小さい。
- `--buildtype=release`（`-O3`）を `-O2` などに下げる手は測っていない。AEC3 は会議中に常に動くので、最適化を下げる手は性能の確認が先になる。

## 7. 試した条件と、測れなかったもの

- 他のビルドが無い時間帯の計測は取れなかった。すべての数字は「並行ビルドあり・参考値」で、比較は同じ時間帯の組で並べた。A の差（CPU で約 46%）は揺れより十分大きいが、壁時計の絶対値（何分かかるか）は、他に何も動いていない Mac ではこれより短いはず。
- `vp install`（`pnpm install`）の時間、話者分離のモデルの取得の時間は測っていない（ダウンロードが主で対象外）。
- `-Osize` の helper の実行時の性能（CPU 使用率、AEC3 の前後処理、Sortformer の前後処理）は測っていない。
- 手 B の `stt-bench` を外した分、手 I（index store）、手 J（dSYM）は個別に測っていない。B は release の `--product` 2 つ（247 秒）と全プロダクト（261〜356 秒、別の時間帯）からの見込み。
- 手 C2（`meson setup` の後に Swift と同時に始める）は、実際の順序（`.deps` が途中でできる）で流していない。並行の計測は、`.deps` が既にある状態で AEC3 を別ディレクトリへビルドして CPU を取り合わせたもの。
- 手 G（ビルド済みの abseil）は試していない。

計測に使ったスクリプトとログは scratchpad に置き、リポジトリには入れていない。ビルドのスクリプトや `Package.swift` は変えていない（試しで `HelperCore` に `-stats-output-dir` を足した変更は戻した）。
