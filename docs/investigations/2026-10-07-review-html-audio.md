# 見返し用のマップに録音を付ける方法の調査（Issue #299）

地図 #297 の「音声つきの見返し」を、後から足せるかを確かめた。重さ・置き方・時刻の起点・2 トラックの同期・音声なしの版の 5 点を、コード（`origin/main` 5b4a7da）・合成音での実測・一次情報で調べた。結論は次のとおり。実会議の録音は使っていない（このマシンにはセッションの録音が無い）。

- **重さ: 161 分で 1 トラック 5〜81 MB、2 トラックで約 107 MB（話している割合が半分の合成音で実測）。** 上限は話し続けた場合の 2 × 81 MB = 163 MB。HTML に base64 で埋めると 1.33 倍で 143〜217 MB。今の録音（AAC 64 kbps）のまま埋め込むのは重すぎる。
- **1 トラックにまとめてビットレートを下げると 20〜41 MB（base64 で 27〜55 MB）。** 161 分を 1 トラックに混ぜて、32 kbps で 41.4 MB、16 kbps（AAC-LC・16 kHz）で 20.3 MB。音質は聞いて確かめていない。
- **置き方は「base64 を `<script type="application/octet-stream">` に入れ、読み込み時に Blob URL にして `<audio>` で鳴らす」がよい。** Chrome 154 と WebKit 26.6 の両方で、file:// から 80 MB（base64 で 108 MB）を読み、末尾・中央へシークできた。`<audio src="data:…">` に直接入れる方法は、WebKit で 64 MiB 文字を超えると読めず、ヘルパーが書く m4a（moov が末尾）は 55 MB でも読めなかった。隣のファイルを `<audio src>` で読む方法は両方で動くが、1 ファイルではなくなる。
- **時刻の起点は一致している。** 録音の 0 秒と発言の `start` / `end` の 0 秒は、どちらもヘルパーの `origin`（音声取得を始める直前の host time）。ヘルパーを起動し直したときも、サーバーが最初の `origin` を `--origin` で渡すので続きの時刻になる。ずれは AAC の先頭の遅延（2112 サンプル = 44 ms）と、取得が途中で途切れたときだけ（下の「残るずれ」）。
- **同期は、書き出し時に 1 トラックに混ぜて、`<audio>` 1 つで鳴らすのがよい。** 2 つの `<audio>` を揃える標準の仕組みは無い。file:// の隣のファイルは Web Audio に通すと無音になる（Chrome で確認）。Web Audio で全体を復号すると、161 分で 1 トラック約 1.85 GB の PCM になる。混ぜる場所は、ffmpeg を足さずに済む Swift（AVFoundation）がよい。
- **音声なしの版は、別のファイルにして名前で区別できる。** 案は 4 つ（下の「音声なしの版」）。決めるのは地図の側。

## 測り方

- 録音の形式は `helper/Sources/HelperCore/Recording.swift` の `TrackRecorder` と同じにした。`AVAudioFile(forWriting:settings:)` に AAC・48 kHz・モノラル・64 kbps を渡し、`AVAudioConverter`（`downmix = true`）で変換して書く Swift の小さなプログラムを、スクラッチの場所で作った。低いビットレートは同じプログラムと `afconvert`、Opus は `ffmpeg`（libopus）で作った。
- 音声は合成した。`say -v Kyoko` で作った 15 秒の日本語の文を、(1) 続けて繰り返す（話し続け）、(2) 15 秒の無音と交互に繰り返す（話す割合が半分）、(3) 無音、(4) ピンクノイズ、の 4 つ。600 秒で比べ、161 分（9660 秒）の値は 600 秒の値の 16.1 倍で見積もった。(2) は 161 分のファイルも実際に作った。`相手` は 0 秒から、`自分` は 15 秒遅らせて、交互に話すようにした。
- ブラウザは、インストール済みの Google Chrome 154.0.8037.98（Playwright 1.63 から headless で起動、`--autoplay-policy=no-user-gesture-required`）と、Playwright の WebKit 26.6 で、試験用の HTML を file:// から開いた。**Safari そのものでは試していない。** safaridriver は「リモートオートメーションを許可」が切れていて使えなかった。WebKit の結果は Safari の目安で、Safari 固有の設定（「ローカルファイルの制限を無効にする」など）の影響は含まない。
- 音声・試験ページ・スクリプトはリポジトリの外（スクラッチの場所）に置いた。各条件 1 回の計測。

## 1. 重さ

### 今の録音（AAC-LC・48 kHz・モノラル・64 kbps）

| 中身 | 600 秒の実測 | 161 分の見積もり |
|---|---|---|
| 無音 | 291,951 B | 4.7 MB |
| 話す割合が半分（15 秒ずつ） | 3,357,404 B | 54.1 MB |
| ピンクノイズ | 4,910,696 B | 79.1 MB |
| 話し続け | 5,057,679 B | 81.4 MB |

- 161 分の (2) を実際に作ると、`相手.m4a` が 53,510,815 B、`自分.m4a` が 53,451,864 B で、2 トラックで 107 MB。base64 なら 143 MB。
- 64 kbps を時間で割った値は 64,000 / 8 × 9,660 秒 = 77.3 MB。Apple の AAC エンコーダーは無音を小さく書く（無音は 1.5 kbps）。話し続けた音声は 65.0 kbps になった（`afinfo` の bit rate 65036）。1 トラックの重さは、そのトラックで音が鳴っていた時間でほぼ決まる。
- 実会議では、`相手`（会議アプリの音）は相手が話している間、`自分`（マイク）は自分が話している間に音が入る。周りの雑音や AEC の残りがあれば、無音の値より大きくなる。実際のセッションのフォルダで測るのは、録音のあるマシンでの残りの作業。

### 1 トラックにまとめる・ビットレートを下げる

161 分の (2) の 2 トラックを足して 1 トラックにし（交互に話すので、混ぜると話し続けに近くなる）、エンコードし直した。

| 形式 | 161 分の実測 | base64 |
|---|---|---|
| AAC-LC 48 kHz 64 kbps（今と同じ設定） | 80.7 MB | 107.7 MB |
| AAC-LC 48 kHz 32 kbps | 41.4 MB | 55.1 MB |
| AAC-LC 24 kHz 24 kbps（600 秒の話し続けから見積もり） | 30.5 MB | 40.6 MB |
| Opus 24 kbps（WebM） | 31.9 MB | 42.6 MB |
| Opus 16 kbps（WebM） | 22.7 MB | 30.2 MB |
| AAC-LC 16 kHz 16 kbps（`afconvert -d aac@16000 -b 16000`） | 20.3 MB | 27.0 MB |
| HE-AAC 24 kHz 16 kbps（`afconvert -d aach@24000 -b 16000`） | 20.3 MB | 27.0 MB |

- 2 トラックを 1 つに混ぜると、同じビットレートで約 3/4（107 → 81 MB）。混ぜた後の重さは「誰かが話していた時間」で決まる。
- `AVAudioFile` で 48 kHz のまま 24 kbps 以下にすると、`AudioConverterSetProperty(kAudioConverterEncodeBitRate)` が失敗した。24 kbps 以下はサンプルレートを下げる（`afconvert` は 24 kHz・16 kHz で書けた）。
- 同じ 16 kbps なら、AAC-LC 16 kHz と HE-AAC と Opus で大きさはほぼ同じ。どれが聞き取りやすいかは聞いていない。
- 元の録音は残す。`Recording.swift` 8 行目のコメントのとおり、64 kbps・16 kHz 以上は後の話者分離のための下限。見返し用は、そこから作る別の写し。

## 2. 置き方（file:// で開いたとき）

Chrome 154 と WebKit 26.6 で、file:// の HTML から試した結果。

| 方法 | Chrome 154 | WebKit 26.6 |
|---|---|---|
| 隣のファイルを `<audio src="相手.m4a">`（53 MB） | 読める。`duration` 9660.05、9000 秒へのシーク 390 ms | 読める。`duration` 9660、シーク 28 ms |
| 隣のファイルを `fetch` | 失敗（`origin 'null'` からの CORS） | 失敗（`Cross origin requests are only supported for HTTP.`） |
| 隣のファイルの `<audio>` を `createMediaElementSource` に通す | 無音（`MediaElementAudioSource outputs zeroes due to CORS access restrictions`、ピーク 0） | 未確認（`AudioContext.resume()` が操作なしでは進まなかった） |
| `<audio src="data:…">` AAC 16 kbps（base64 27 MB、moov が先頭） | 読める・シークできる・鳴る | 読める・シークできる |
| 同 Opus 24 kbps（base64 42.6 MB） | — | 読める・シークできる |
| 同 AAC 32 kbps（base64 55 MB、ヘルパーと同じ書き方で moov が末尾） | 読める | **読めない**（`Not allowed to load local resource`、MediaError 4） |
| 同 AAC 32 kbps を `-movflags +faststart` で moov を先頭へ（base64 55 MB） | — | 読める |
| 同 AAC 64 kbps を moov を先頭へ（base64 108 MB） | —（moov が末尾の元のファイルの 108 MB は、読める・シークできる・鳴る） | **読めない**（64 MiB 文字の上限） |
| base64 を `<script type="application/octet-stream">` に入れ、`fetch("data:…")` で Blob にして Blob URL | 108 MB まで読める | 55 MB は読める、108 MB は `fetch` が `Load failed` |
| 同じく、4 MiB ずつ `atob` して Blob にして Blob URL | 108 MB を 0.2 秒で戻し、読める・シークできる | 108 MB を 0.24 秒で戻し、読める・シークできる |

- **隣のファイルは `<audio src>` なら両方で読める。** WebKit は、file:// のページから同じボリュームのファイルを表示してよい（`SecurityOrigin::canDisplay`、[WebKit の SecurityOrigin.cpp 378〜381 行](https://github.com/WebKit/WebKit/blob/eee373837616774d98f9d0129674084edb444e7a/Source/WebCore/page/SecurityOrigin.cpp#L378-L381)）。ただし `fetch` は両方で失敗する。file: の URL のオリジンは仕様上「迷ったら新しい不透明なオリジン」で（[URL Standard の origin](https://url.spec.whatwg.org/#concept-url-origin)）、Chrome は file:// のページのオリジンを `null` にした（実測）。
- **Web Audio に通すと無音になる。** Web Audio API は、CORS-cross-origin と判定されたメディアから作った `MediaElementAudioSourceNode` に無音を出させる（[Web Audio API §1.22.4](https://webaudio.github.io/web-audio-api/#MediaElementAudioSourceOptions-security)）。Chrome では隣のファイルがこれに当たった。Blob URL はページと同じオリジンなので当たらない（試していない）。
- **`<audio src="data:…">` は WebKit で 2 つの理由で落ちる。** (1) WebKit は 0x04000000（64 MiB）文字を超える URL を表示しない（[SecurityOrigin.cpp 53 行・369〜370 行](https://github.com/WebKit/WebKit/blob/eee373837616774d98f9d0129674084edb444e7a/Source/WebCore/page/SecurityOrigin.cpp#L369-L370)、上限を 32 KB から 64 MB に上げた [r254301](https://trac.webkit.org/r254301)）。(2) 上限より小さい 55 MB でも、moov が末尾の m4a は読めなかった（moov を先頭へ移すと読めた。原因の箇所は調べていない）。`AVAudioFile` が書く長い m4a は moov が末尾になる（161 分 32 kbps のファイルの並びは `ftyp`・`free`（61 KB）・`mdat`・`moov`（1.9 MB）。20 秒のファイルは moov が先頭の `free` に収まって先頭になった）。MDN は data URL の上限を Chromium・Firefox 512 MB、Safari 2048 MB としているが（[MDN data: URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/data)）、`<audio>` の読み込みは上の (1) で先に止まる。
- **Blob URL にする方法は両方で動く。** `fetch("data:…")` で戻す書き方は WebKit で 108 MB が失敗したので、`atob` を区切って使う。Blob は moov が末尾でも読めた。Chrome で JS のヒープが 286 MB になった（base64 の文字列と Blob の両方を持つため。`performance.memory` の値）。

## 3. 時刻の起点

録音の 0 秒と発言の時刻（会議の中の秒）は同じ時点を指す。根拠のコード（`origin/main` 5b4a7da）:

1. ヘルパーは、音声取得を始める直前に host time を 1 回だけ取り、2 トラックの時刻の基準 `origin` にする（`helper/Sources/live-mindmap-helper/main.swift` 65 行 `let origin = explicitOrigin ?? AudioGetCurrentHostTime()`、取得の開始は 75〜76 行）。
2. 録音は同じ `origin` を受け取り（同 71〜72 行）、最初のバッファの取得時刻と `origin` の差の分だけ、先頭に無音を書く（`helper/Sources/HelperCore/Recording.swift` 21 行 `leadingSilenceFrames`、54 行）。だから録音の 0 秒は `origin`。
3. 文字起こしの時刻は、トラックごとに最初のバッファの取得時刻と `origin` の差を 1 回だけ求め、すべての結果に足す（`helper/Sources/HelperCore/Timeline.swift` 37 行、`SpeechAnalyzerTranscriber.swift` 60・71・109 行）。発言の `start` / `end` は「`origin` を 0 とする 2 トラック共通の秒数」（`Events.swift` 10 行のコメント、`helper/README.md`「`--audio-dir`」の段落）。
4. サーバーは、その `start` / `end` をずらさずに発言にする（`server/src/core/live.ts` 36 行、途中結果からの発言も `server/src/core/settle.ts` 20 行で値をそのまま使う）。反映の履歴の `at` も、発言の `end` の最大値（`server/src/core/session.ts` 54 行のコメント）。
5. ヘルパーを起動し直したとき（Issue #161）は、サーバーが最初のヘルパーの `origin` を覚え（`server/src/server.ts` 277 行）、次のヘルパーに `--origin` で渡す（同 221〜229 行、326 行）。録音は `相手-2.m4a` のように番号つきの別ファイルになり（`Recording.swift` の `recordingFileName`、`server.ts` の `audioFileNames`）、その先頭には最初の `origin` から起動し直すまでの無音が入る。だから番号つきのファイルも 0 秒が同じ時点で、全部を足し合わせれば 1 本の時間軸になる。

ずれの量をどこかから取ってくる必要はない。サーバーのログには host time も壁時計の開始時刻も無い（セッションのフォルダ名の時刻は `createSessionDir` がヘルパーの起動前に付けたもので、`origin` とは別）。

### 残るずれ

- **AAC の先頭の遅延: 2112 サンプル（44 ms）。** `afinfo` で `2112 priming + 448 remainder` と記録されている。10.000 秒ちょうどに 1 サンプルのクリックを置いた m4a を `decodeAudioData` で復号すると、Chrome・WebKit とも 480000 サンプル目（10.000 秒）に出た（遅延は取り除かれる）。`<audio>` の `duration` は Chrome が 9660.0533（遅延と末尾の分 2560 サンプルを含む）、WebKit が 9660。Chrome の `<audio>` で再生位置が 44 ms ずれるかは測っていない。発言は 10〜15 秒の区切りなので、見返しでは問題にならない大きさ。
- **取得が途中で途切れたとき。** 録音は途中の空白を無音で埋めず、発言の時刻も空白を数えない（`Recording.swift` 25〜26 行のコメント）。そのトラックの中では録音と発言が一致したままだが、空白より後は、もう一方のトラックと、壁時計に対して空白の分だけ早まる。2 トラックを混ぜると、空白より後でトラックどうしが空白の分ずれる。空白がどれだけ起きるかは調べていない（タップは集約デバイスの IOProc、マイクは AVAudioEngine で、どちらも動いている間は途切れずにバッファが来る作り）。ログには空白の記録が無いので、後から量を知る手段は今は無い。混ぜる前提にするなら、`TrackRecorder` で `hostTime` の飛びを無音で埋める（発言の時刻も同じ規則にそろえる）ことが候補。

## 4. 2 トラックを同じ位置で鳴らす

| 方法 | 位置・速度 | 制約 |
|---|---|---|
| A. 書き出し時に 1 トラックに混ぜ、`<audio>` 1 つ | ずれようがない。`playbackRate` を変えても、`preservesPitch` の既定が true なので声の高さは保たれる（[HTML Standard の preservesPitch](https://html.spec.whatwg.org/multipage/media.html#dom-media-preservespitch)） | `相手` と `自分` を分けて消す・音量を変えることはできない |
| B. `<audio>` を 2 つ、`currentTime`・`playbackRate`・`play()` を同時に操作 | 実測では、headless の Chrome で `currentTime` の差が 1 倍で 0 ms、シーク後も 0 ms、1.5 倍で最大 5 ms、2 倍で −10〜+8 ms（200 ms 毎に 25〜50 回）。`currentTime` の値の差で、実際に鳴った音のずれではない | 2 つの要素を同じ時計で進める標準の仕組みは無い（[HTML Standard の media elements](https://html.spec.whatwg.org/multipage/media.html) に、かつての `MediaController` / `mediaGroup` は無い）。長い再生・一時停止・シークのたびに、JS で差を見て直す必要がある |
| C. Web Audio（`decodeAudioData` → `AudioBufferSourceNode.start(when, offset)` を 2 つ） | 同じ `AudioContext` の時刻で始められるので、サンプル単位で揃う | 全体を PCM に復号し、文脈のサンプルレートへ変換する（[Web Audio API の decodeAudioData](https://webaudio.github.io/web-audio-api/#dom-baseaudiocontext-decodeaudiodata)）。161 分・48 kHz・float32 で 1 トラック 9660 × 48000 × 4 B = 1.85 GB（16 kHz の文脈でも 618 MB）。`playbackRate` は再生の速さで、声の高さも変わる。file:// の隣のファイルは `fetch` できないので、埋め込み（Blob）が前提 |
| D. `<audio>` 2 つを `createMediaElementSource` で 1 つの `AudioContext` に入れる | B と同じく、要素ごとの位置は別々 | file:// の隣のファイルは無音になる（2 章）。Blob URL なら使える見込み（試していない） |

A がよい。混ぜる場所は次のどれか。

- **ヘルパーに、録音を混ぜて見返し用に書き出すサブコマンドを足す（Swift・AVFoundation）。** `AVAudioFile` で `相手*.m4a`・`自分*.m4a` を読み、サンプルごとに足して（48 kHz・モノラルで 0 秒がそろっているので、位置合わせは要らない）、低いビットレートで書く。ffmpeg を新しい依存にしなくて済み、録音を書くのと同じ道具で済む。`AVAudioFile` の出力は moov が末尾になるが、Blob URL にするなら問題にならない（2 章）。
- ffmpeg（`amix`）。この調査ではこれで混ぜたが、リポジトリは今 ffmpeg に依存していない。
- 録音しながら 3 本目のトラックとして混ぜる。2 トラックは別の流れで届くので、時刻を合わせて足す手間が増える。セッションの終了時に混ぜる方が簡単。

`相手` を左・`自分` を右のステレオにして、Blob URL の `<audio>` を Web Audio に通せば、片方だけ消すこともできそうだが、試していない。

## 5. 音声なしの版

相手の声を含む録音を人に渡すことについて、ファイルの側で区別する案。どれにするかは地図 #297 で決める。

1. **音声つきと音声なしを別のファイルに書き出す。** たとえば `map.html`（音声なし）と `map-audio.html`（音声つき）。名前で区別でき、渡すときに選ぶ。音声つきは 1 トラック 16〜32 kbps で 27〜55 MB。
2. **音声なしを既定にし、音声つきは明示したときだけ作る。** 過去のセッションから作り直すコマンドのオプションにする（`--with-audio` など）。うっかり渡す心配が一番小さい。
3. **音声は隣のファイル（`map-audio.m4a`）にし、HTML は 1 つ。** HTML だけ渡せば音声なし、2 つ渡せば音声つき。HTML は音声が見つからなければプレーヤーを出さない（`<audio>` の `error` で分かる）。ただし「1 ファイルで開ける」の決定から外れる。
4. **`自分` だけの音声つきの版。** 相手の声を含めずに、自分の発言だけ聞ける。混ぜずに `自分*.m4a` だけを写す。スピーカーで聞いていた場合、`自分` には AEC で消しきれなかった相手の声が少し残りうる（`helper/README.md`「`--audio-dir` の録音は、AEC の後の音」）。

## 再現の手順

スクラッチの場所で、次の順に作った（スクリプトはリポジトリに入れていない）。

```sh
# 合成音（15 秒の文 + 15 秒の無音を 161 分）
say -v Kyoko -o speech.aiff "…"
ffmpeg -i speech.aiff -af "apad=pad_dur=15" -ar 48000 -ac 2 chunk.wav
ffmpeg -stream_loop -1 -i chunk.wav -t 9660 -ac 1 gapped9660.wav
ffmpeg -i gapped9660.wav -af "adelay=15000,atrim=0:9660" self.wav
# TrackRecorder と同じ設定で書く（AVAudioFile、AAC・48 kHz・モノラル・64 kbps）
./enc gapped9660.wav 相手.m4a 64000 && ./enc self.wav 自分.m4a 64000
# 1 トラックに混ぜて書き直す
ffmpeg -i 相手.m4a -i 自分.m4a -filter_complex "amix=inputs=2:normalize=0" -ac 1 -ar 48000 mixed.wav
afconvert -f m4af -d aac@16000 -b 16000 -c 1 mixed.wav mixed_aac16k_16kHz.m4a
```

試験ページは、隣のファイル・data URI・Blob URL（`fetch("data:…")` と `atob` の 2 通り）の版を作り、Playwright で `file://` から開いて、`loadedmetadata`・`duration`・シークにかかった時間・`fetch` の成否・`AnalyserNode` のピークを `window.__results` に集めた。
