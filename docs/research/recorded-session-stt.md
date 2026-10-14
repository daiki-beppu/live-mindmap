# 録画のファイルをヘルパーの SpeechAnalyzer で文字にする道

調査チケット [#1012](https://github.com/daiki-beppu/live-mindmap/issues/1012)（地図 [#1011](https://github.com/daiki-beppu/live-mindmap/issues/1011)）。2026-10-14、macOS 27.0.1・Swift 6.4・Apple Silicon の手元の Mac で調べた。

## 結論

- **できる。** SpeechAnalyzer はファイルを入力にする口を公式に持ち（`analyzeSequence(from: AVAudioFile)`、macOS 26 から）、等速を待たずに読める。合成会議で測ると **等速の 28〜56 倍**で、**60 分のファイルは 1〜2 分**で文字になる。
- 今の `stt-bench run` はファイルを読むが、わざと実時間のペースで流す（100 ms ずつ、壁時計を待つ）。速く処理する口ではないので、録画からのセッションには別の口が要る。今の `SpeechAnalyzerTranscriber` に速く流し込むと、入力の上限（2048 個）を超えてエラーで止まる作りになっている。
- 発言の作り方のうち、**途中結果から発言にする規則（1 秒更新されなければ発言）は、サーバーの壁時計で測っているので、速く流すとそのままでは効かない。** 確定結果だけで発言を作るか、規則の時計を音声の時刻に替える必要がある。語彙の補正と読みはファイルでもそのまま効く。話者分離はライブにもまだ無い。
- 動画のコンテナ（mp4・mov）の音声は **AVFoundation だけで取り出せる。** ffmpeg は要らない。

## 1. 等速より速く処理できるか

### 公式の資料

- `SpeechAnalyzer.analyzeSequence(from:)`: 「Analyzes an input sequence created from an audio file, returning when the file has been read.」 返った時点ではまだ解析中のことがあり、`finalize(through:)` などで待つ（macOS 26.0 から）。[Apple Developer](https://developer.apple.com/documentation/speech/speechanalyzer/analyzesequence(from:))
- ほかに `start(inputAudioFile:finishAfterFile:)`、`init(inputAudioFile:modules:options:analysisContext:finishAfterFile:volatileRangeChangedHandler:)` がある（SDK の `Speech.swiftinterface` で確認）。[SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer)
- WWDC25「Bring advanced speech-to-text to your app with SpeechAnalyzer」は、ファイルを 1 関数で文字にする例（`analyzeSequence(from: file)` → `finalizeAndFinish(through:)`）を示し、SpeechTranscriber のモデルを「good for long-form and distant audio, such as lectures, meetings, and conversations」と説明する。[WWDC25 #277](https://developer.apple.com/videos/play/wwdc2025/277/)
- **処理の速さ（等速の何倍か）は、公式の資料に数字が無い。** 「faster than … SFSpeechRecognizer」とあるだけ。第三者の測定では、34 分の動画を 45 秒で文字にした例がある（[MacStories 経由の記事](https://gigazine.net/gsc_news/en/20250619-apple-speech-analyzer)。一次資料ではない）。

### 実測

`stt-bench run` は実時間で流すので、速さは測れない。リポジトリの外に置いた使い捨ての Swift（本番と同じ `SpeechTranscriber(locale: ja-JP, reportingOptions: …, attributeOptions: [.audioTimeRange])`）で、`analyzeSequence(from: AVAudioFile)` と `AssetInputSequenceProvider` の両方を測った。素材は合成会議だけ（`~/live-mindmap-samples/synth/`）。数えたのは時間と件数だけで、本文は見ていない。

| 素材 | 長さ | 入口 | 結果の種類 | かかった時間 | 速さ | 確定結果 |
| --- | --- | --- | --- | --- | --- | --- |
| jargon `meeting.m4a` | 8.3 分 | AVAudioFile | 途中 + 確定 | 17.3 秒 | 28.8 倍 | 32 件 |
| jargon `meeting.m4a` | 8.3 分 | AVAudioFile | 確定のみ | 17.8 秒 | 28.0 倍 | 32 件 |
| jargon `meeting.m4a` | 8.3 分 | AssetInputSequenceProvider | 途中 + 確定 | 11.5 秒 | 43.6 倍 | 32 件 |
| screen `meeting.m4a` | 22.9 分 | AVAudioFile | 確定のみ | 24.6 秒 | 55.7 倍 | 78 件 |
| screen `meeting.mp4`（動画） | 22.9 分 | AVAudioFile | 確定のみ | 24.5 秒 | 56.0 倍 | 78 件 |
| screen `.mov`（上の mp4 を `avconvert` で包み直し） | 22.9 分 | AssetInputSequenceProvider | 確定のみ | 38.6 秒 | 35.5 倍 | 78 件 |
| 同上 | 22.9 分 | AssetInputSequenceProvider | 途中 + 確定 | 30.7 秒 | 44.6 倍 | 78 件 |

- 一部は、比べるための `stt-bench run`（実時間）と並行して走らせたので、負荷が乗っている。速さは 28〜56 倍の幅で読む。
- **60 分のファイルは 1〜2 分**（28 倍で約 2.1 分、56 倍で約 1.1 分）。161 分の parnassus でも 3〜6 分の見込み（外挿）。
- 途中結果を出しても速さはほぼ変わらない。確定結果の件数・字数は、途中結果の有無・入口で変わらなかった（jargon 32 件・約 2,718 字、screen 78 件・約 7,560 字）。
- 比べに、同じ jargon を `stt-bench run --variant baseline`（実時間）で流した: 500 秒かかり（最後の結果は流し始めから 499.9 秒）、確定結果 32 件・2,718 字、途中結果 2,585 件で、速く流したときと件数・字数が同じだった。速く流しても、確定結果の区切りと本文の量は変わらないと見てよい（確定結果の到着の遅れは中央値 0.76 秒）。

## 2. `stt-bench run` とライブの `run` の差

| | `stt-bench run` | ライブの `run` |
| --- | --- | --- |
| 音声 | `AVAudioFile` を 100 ms ずつ読み、壁時計が音声の時刻に追いつくまで待つ（[Run.swift](../../helper/Sources/stt-bench/Run.swift)） | プロセスタップとマイクの 2 本 |
| 認識 | `SpeechAnalyzerTranscriber` そのもの（`baseline`） | 同じものを `SilenceFilteringTranscriber` で包む（無音の区間の結果を捨てる。[SilenceFiltering.swift](../../helper/Sources/HelperCore/SilenceFiltering.swift)） |
| 出力 | 結果ごとの JSONL（track は常に `相手`、`words` なし） | WebSocket の `partial` / `remark`（`words` つき、重複の印つき。[Relay.swift](../../helper/Sources/HelperCore/Relay.swift)） |
| エコーキャンセル・重複の印 | なし | スピーカーのとき `自分` にかける |

ライブでの発言の作り方と、ファイルを速く流したときに効くか:

- **途中結果から発言にする規則**（1 秒更新されない途中結果を発言にする、確定結果が覆う途中結果は捨てる）はサーバーの [core/settle.ts](../../server/src/core/settle.ts)。時刻は [remarkSettling.ts](../../server/src/remarkSettling.ts) が `Clock.currentTimeMillis`（壁時計）で渡す。**速く流すと 1 秒の間に音声が 30〜50 秒進むので、途中結果はほとんど「1 秒更新されない」にならず、ほぼ確定結果だけで発言ができる。** 規則の意味（音声で 1 秒）を保つには、時計を結果の到着時刻ではなく音声の時刻（`end`）にするか、ファイルでは途中結果を送らず確定結果だけから作る。確定結果は 1 件が平均 85 字前後と長い（jargon 32 件で約 2,718 字）ので、ライブより発言が長く区切られる点は回帰評価で確かめる要がある。GLOSSARY の「文の終わりが付いて落ち着いた途中結果」で締める規則（[#987](https://github.com/daiki-beppu/live-mindmap/issues/987)）はコードにまだ無いが、入れるときも同じく「落ち着いた」の時計を決める必要がある。
- **入力の上限**: `SpeechAnalyzerTranscriber` は未消費の入力が 2048 個を超えるとエラーで終わる（ライブで analyzer が止まったことを知るため）。ファイルを速く読むと、この上限にすぐ当たる。ファイル用には `analyzeSequence(from:)` か `AssetInputSequenceProvider` に任せ、読む速さを analyzer に合わせさせる。
- **無音の結果を捨てる**（`SilenceFilteringTranscriber`）: 音量の記録は直近 30 秒分しか持たない。速く流すと、結果が届いた時には区間が記録の外に出ていて「測れない区間」（捨てない）になり、効かなくなる。ファイルなら区間の音量をファイルから読み直せるので、作り直せば効かせられる。
- **語彙の補正と読み**（ADR 0015）: サーバーが発言を締めるときに、ヘルパーが送る `words`（CFStringTokenizer の読み）で直す。音声の時刻に依らないので、ファイルでもそのまま効く。ファイル用の口でも `words` を載せればよい。
- **語彙のヒント**: ライブの `run` は STT に語彙を渡していない（`contextualStrings` を使うのは `stt-bench` の `vocab` 系の候補だけ）。ファイルでも渡さないなら差は無い。渡すなら `SpeechAnalyzer` の init の `analysisContext` で最初から渡せる（ファイルは中身を先に知れないので、共有画面の文字や過去のセッションの語彙が出どころになる）。
- **話者分離**: ライブにもまだ無い（ADR 0013 で方式を決め、仕様 [#610](https://github.com/daiki-beppu/live-mindmap/issues/610)）。1 本の録音にかけたときの効き方は [#1013](https://github.com/daiki-beppu/live-mindmap/issues/1013) で調べる。ADR 0013 の「確定ラベルが揃うまで発言を待つ（最大 3 秒）」も壁時計の待ちなので、ファイルでは音声の時刻で読み替えることになる。
- **重複の印・エコーキャンセル**: 1 本の録音（`相手` だけ）では使わない。自分用と相手用の 2 本を渡されたときは、2 本が同じ時刻で揃うので、今の重複の印（前後 8 秒の文字 3-gram）を音声の時刻で当てはめられる。ただし `relayMine` の保留の上限（1 秒）も壁時計である。
- **時刻**: 結果の `start` / `end` は、analyzer に入れた最初の音声が 0 の秒（`TrackTimeline` の補正は、ライブで取得の時刻をそろえるためのもの）。ファイルの先頭を 0 とすれば、そのまま発言の時刻になる。

## 3. 動画のコンテナから音声を取り出すのに AVFoundation だけで足りるか

足りる。ffmpeg は要らない。

- `AVAudioFile(forReading:)` は、mp4（映像 + AAC 音声）をそのまま開けて、`analyzeSequence(from:)` で最後まで文字にできた（上の表）。`AVAudioFile` は形式によらず PCM のバッファで読み、ファイルの形式から変換する（[AVAudioFile](https://developer.apple.com/documentation/avfaudio/avaudiofile)）。
- ただし `avconvert` で包み直した mov は、`AVAudioFile` では最後に `eofErr`（-39）で落ちた。同じ mov も `AssetInputSequenceProvider` なら最後まで読めた。
- **`AssetInputSequenceProvider`**（macOS 27 から）は「Reads from an audio file or asset, providing its audio in a format suitable for analysis by a speech analyzer.」で、`AVAsset` の最初の（または指定した）音声トラックを読み、analyzer の形式に変換する（[Apple Developer](https://developer.apple.com/documentation/speech/assetinputsequenceprovider)）。動画のコンテナはこちらが確実。ただしヘルパーの `Package.swift` は `macOS("26.0")` なので、使うなら最低の OS を 27 に上げるか、`#available` で分ける。macOS 26 では `AVAssetReader` で音声トラックを PCM に読み、今と同じく `AnalyzerInput` にする道がある（`mix` サブコマンドがすでに AVFoundation だけで m4a を読み書きしている）。
- 形式: m4a・wav・mp4・mov は手元で開けた。mp3 は手元に作る手段（エンコーダ）が無く確かめていないが、Core Audio のファイル形式に MPEG Layer 3（.mp3）が入っている（`afconvert -hf`）。
- 動画に音声トラックが複数ある（自分と相手を別に録った）ときは、`AVAsset.loadTracks(withMediaType: .audio)` で列挙し、`provider(from:track:compatibleWith:)` で選べる。

## 測り方の控え

- 使い捨ての計測は scratchpad に置き、リポジトリには入れていない。`SpeechTranscriber(locale: ja-JP, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults] または [.fastResults], attributeOptions: [.audioTimeRange])`、`analyzer.analyzeSequence(from:)` → `finalizeAndFinish(through:)`。モデルの準備は時間に含めない。
- 実時間の比べは `cd helper && swift build -c release --product stt-bench` の後、`.build/release/stt-bench run --variant baseline ~/live-mindmap-samples/synth/jargon/meeting.m4a`。
