# Kanary で準リアルタイムの文字起こしを取れるか

- チケット: [#3](https://github.com/daiki-beppu/live-mindmap/issues/3)（map: [#2](https://github.com/daiki-beppu/live-mindmap/issues/2)）
- 調査日: 2026-09-30
- 対象: Kanary.app 3.5.5 (79) / kanary CLI 3.5.5 (79)、macOS 27.0

## 結論: 条件付きで使える（STT エンジンとしてのみ）

- **Kanary を「録音しながらライブの文字起こしを外に流す」経路としては使えない。** アプリ内には Live Captions（途中結果つきのライブ字幕）があるが、CLI・IPC・ファイルのどれからも外部に公開されていない。
- **使えるのは「自分で取った短い音声ファイルを `kanary transcribe <path>` に渡す」STT エンジンとしての使い方。** 1 ファイル 75 分未満なら Pro なしで動く（今回の環境で実測）。遅延は「チャンク長 + 約 1〜3 秒」。
- ただしこの使い方では、**音声の取得（mic と相手の音声の分離を含む）は live-mindmap 側で自作する必要がある。** Kanary は録音中の音声も外に出さないため。
- `recordings start/stop` を繰り返す案は勧めない。停止から次の開始までの音声が抜けるうえ、毎回ライブラリに録音が増える（詳しくは後述。状態を変えるコマンドなので実行していない）。

## 1. ライブ文字起こしを外部に公開する手段はあるか → ない

### CLI のコマンド

`kanary help`（v3.5.5）のコマンドは `status`、`recordings start|stop|list|show|delete|update|import|transcribe|export`、`transcribe <path>` だけ。ライブの字幕を購読・ストリームするコマンドはない。

### IPC（JSON-RPC over `cli.sock`）のメソッド

CLI は Kanary.app のローカルソケット `cli.sock` に JSON-RPC で話しかける。アプリ同梱の `KanaryCLIWire.framework` に埋め込まれたメソッド名はこれですべて（バイナリ内の文字列から抽出。アプリのデータ領域は見ていない）。

```
voice.status
recordings.list / recordings.get / recordings.start / recordings.stop
recordings.delete / recordings.update / recordings.import / recordings.export
recordings.transcribe
recordings.transcribe.progress / recordings.transcribe.diagnostic   ← 通知
transcribe.ephemeral
```

通知は後処理の文字起こしの**進捗**（`phase` / `percent` / `track`）と**診断**だけで、字幕のテキストは流れてこない（`makeTranscribeProgressNotification(requestId, phase, percent, track)` というシグネチャ）。

### アプリ内部にはライブ字幕がある

`KanaryUIVoice.framework` / `KanaryRecordingTranscribe.framework` に `LiveCaptionsController`、`LiveCaptionSegmentStore`、`VolatileCaptionPresenceNSView`、`VolatileStabilityFinalizeScheduler`、`SpeechAnalyzerLocaleUsageTracker` などがある。Apple の `SpeechAnalyzer` の途中結果（volatile）と確定結果を使って、アプリ内のウィンドウに字幕を出していると読める。ただし、これを外に出す経路（CLI メソッド、通知、公開ファイル）は見つからなかった。公式サイトも Live Captions を**アプリ内の機能**として説明しており、料金表の CLI の行には「full-length transcripts and summaries」しか書かれていない（[kanary.to/pricing](https://kanary.to/pricing)）。

録音中は `.cafchunks/manifest.json` という形で音声を分割して書き出している（`KanaryRecordingModel` の文字列）。これはアプリのデータ領域の中身なので、今回の調査では読んでいないし、読まない前提で設計すべき（非公開の内部形式で、iCloud 同期の対象でもある）。

## 2. 短いファイルを `transcribe <path>` に渡して代用した場合

`say -v Kyoko` で作った日本語の音声を `kanary transcribe` に渡して計測した（ephemeral なのでライブラリは変わらない）。

| 入力 | 音声長 | 処理時間 (wall) | segment 数 | 備考 |
|---|---|---|---|---|
| ja10.aiff | 13.3 秒 | 2.16 秒 | 1 | ほぼ原文どおり |
| ja10.m4a (AAC) | 13.3 秒 | 2.48 秒 | 1 | 同上 |
| stereo.wav (16 kHz) | 9.9 秒 | 1.10 秒 | 1 | 後述 |
| ja30.m4a | 40.0 秒 | 3.55 秒 | 2 | 0–26.7 秒 / 26.7–40.0 秒 |
| long.m4a | 276.5 秒 | 15.71 秒 | 7 | segment は 18〜61 秒と長い |

stderr の進捗は `Detecting language (speaker)... → Checking speech assets... → Transcribing speaker... → Transcription finished.` の順に出る。

### 遅延

- 処理時間は「約 1 秒の固定費 + 音声長の 5% 前後」。10 秒のチャンクなら約 2 秒で返る。
- 準リアルタイムで流したときの遅延は、発話からおおよそ **チャンク長 + 2 秒**。10 秒チャンクで 10〜12 秒、5 秒チャンクで 5〜7 秒（5 秒は未計測で、固定費から推定）。
- 1 回の呼び出しで言語判定と speech assets の確認が毎回走る。`--lang ja` を付ければ言語判定を省けるはず（未計測）。

### 取りこぼし・精度

- **チャンクの境界で単語が割れる。** 13.3 秒の音声を 6.66 秒で 2 つに切ると、「担当者から」が前半「…まずバックエンドの担当。」と後半「当社から進捗を…」に割れ、誤認識した。対策は、チャンクを数秒重ねて送って重なった部分を捨てる、または無音の位置で切る（VAD）こと。どちらも live-mindmap 側の実装になる。
- **segment が粗い。** 短いチャンクはまるごと 1 segment。長い音声でも 20〜60 秒単位。文単位の時刻は取れないので、差分更新の単位は「チャンク」になる。
- **時刻はファイルごとに 0 から始まる。** 会議全体の時刻は、呼び出し側でチャンクの開始時刻を足して付け直す。

### mic / speaker のトラック分離

- ephemeral の transcribe は、**入力をすべて `speaker` トラックとして返す**（`tracks` も `speaker` だけ）。
- **ステレオを渡すと 1 ch 目しか文字起こしされない。** L ch に「私は自分のマイクで…」、R ch に時間をずらして「相手の声は…」を入れた 9.9 秒の WAV は、L の文だけが返り、R の文は消えた。R だけをモノラルにして渡すと正しく返った。
- つまり、mic と相手の音声を**別々のモノラルファイルにして 2 回呼び**、`track` は呼び出し側で付け直す必要がある。Kanary の録音（`recordings show`）のような `mic` / `speaker` の分離は、ephemeral 経由では保たれない。

### Pro プランの制約

- 同梱の `KanaryCLIBridge` にあるエラーメッセージ: 「Transcribing audio longer than 75 minutes via the CLI requires Kanary Pro.」「Transcribing recordings longer than 75 minutes via the CLI requires Kanary Pro.」。制限は**1 ファイルあたりの長さ**で、数秒〜数十秒のチャンクは対象外と読める。今回の環境でも 4.6 分までの ephemeral transcribe はすべて成功した（この環境のプランは CLI から確かめる手段がなく、未確認）。
- 料金表（[kanary.to/pricing](https://kanary.to/pricing)）: Free はアプリ内の文字起こしが「Up to 75 minutes」、Pro（$8/月）が「Unlimited in app + CLI」。Personal（$2/月）はアプリ内のみ。料金表の表現からは、Free と Personal で CLI をどこまで使えるかは読み取れない。
- 呼び出し回数やレートの制限は、ドキュメントにもバイナリの文字列にも見当たらない。60 分の会議を 10 秒チャンクで 2 トラック送ると約 720 回の呼び出しになる。

## 3. `recordings start/stop` を繰り返す案（未実行）

状態を変えるコマンドなので実行していない。バイナリの文字列と CLI の仕様から分かることは次のとおり。

- 停止しないと文字起こしが始まらない（後処理の `recordings.transcribe` と進捗通知の仕組み）。停止 → 後処理 → 次の開始、の間の音声は録られない。
- 「Kanary is not ready to start a new recording yet」「A recording is already active」「Already transcribing」というエラーがあり、短い間隔でつなぐと失敗しうる。
- 開始・停止ごとにライブラリに録音が 1 件増え、iCloud 同期の対象にもなる。
- `recordings show` は録音の `mic` / `speaker` の分離と segment を保つが、得られるのは停止後。

実行すれば確かめられること（ユーザーの確認が必要）:

1. `recordings stop` の直後、`recordings show <id>` に transcript が付くまでの秒数
2. `stop` から次の `start` が成功するまでの最短間隔と、その間に抜ける音声の長さ
3. 録音中に `recordings show <id>` を呼んだとき、途中の transcript が返るか（内部構造からは返らないと見込まれる）

## 4. fog への影響

map の「Kanary がリアルタイムに対応できない場合の代わりの経路」は、この結果で次のように具体化できる。

- **どの経路でも、音声の取得は自作になる。** Kanary は録音中の音声も字幕も外に出さないため。mic はマイク入力、相手はシステム音声（macOS の Core Audio のプロセスタップ / ScreenCaptureKit）またはブラウザのタブ音声。
- STT の候補は 3 つに絞れる。
  1. **Kanary の `transcribe` にチャンクを渡す**（遅延はチャンク長 + 約 2 秒、境界の処理は自作、Pro なしでも可）
  2. **Apple の `SpeechAnalyzer` / `SpeechTranscriber` を直接使う**（macOS 26 以降。`volatileResults` で途中結果も取れる。Kanary の Live Captions と同じ土台: [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber)、[volatileResults](https://developer.apple.com/documentation/speech/speechtranscriber/reportingoption/volatileresults)。Swift の小さなヘルパーが必要）
  3. **クラウドのストリーミング STT**（ブラウザのタブ音声と組み合わせる）
- 音声入力のアダプタは「音声チャンク（トラック・開始時刻つき）→ 文字起こし」の形にしておけば、1〜3 を差し替えられる。

## 出典

- `kanary help`、`kanary status`（v3.5.5 (79)）の出力
- `~/.claude/skills/kanary/references/contract.md`、`troubleshooting.md`（CLI の出力形式と終了コード）
- `/Applications/Kanary.app/Contents/Frameworks/*.framework` のバイナリに含まれる文字列（KanaryCLIWire、KanaryCLIBridge、KanaryUIVoice、KanaryRecordingTranscribe、KanaryRecordingCapture、KanaryRecordingModel）
- 実測: `say` で作った音声に対する `kanary transcribe <path>`（ephemeral）
- [Kanary 料金表](https://kanary.to/pricing)、[Kanary 公式サイト](https://kanary.to/)、[appcast](https://cdn.kanary.download/appcast.xml)
- Apple Developer: [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber)（macOS 26.0〜）、[SpeechTranscriber.ReportingOption.volatileResults](https://developer.apple.com/documentation/speech/speechtranscriber/reportingoption/volatileresults)、[SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer)
