# helper

会議の音声を文字起こしして発言をサーバーへ流す Swift のヘルパー（ADR 0002）。#33 で作る。この段階ではサーバーとはつながない。

前提: macOS 26 以降。ビルドの前に、WebRTC AEC3 のライブラリを `scripts/build-webrtc-apm.sh` で用意する（下の「エコーキャンセル」）。初回は ja-JP の音声認識モデルを `AssetInventory` で取得する。システム音声の取得とマイクの使用は、起動したターミナルの権限で動く。初回の `run` でマイクの許可を求められる。

## 構成

- `Sources/CWebRTCAPM`: WebRTC AEC3 の C++ を閉じ込めた SwiftPM のシム。公開ヘッダーは C の関数だけ
- `scripts/build-webrtc-apm.sh`: AEC3 の静的ライブラリをビルドして `.deps/webrtc-apm/`（gitignore 済み）に置く
- `Sources/HelperCore`: イベントの形、会議アプリの選択、Core Audio のプロセスタップ、マイク（AVAudioEngine）、SpeechAnalyzer、WebSocket
- `Sources/live-mindmap-helper`: 引数の解釈と配線だけ。STT は `Transcriber` プロトコルの後ろにある
- `Sources/stt-bench`: 音声認識の確定の遅れ（Issue #97）と、AEC3 が開始直後に話者の声を削るか（Issue #118）を測る開発者向けの道具。製品の `live-mindmap-helper` には含まれない
- `Tests/HelperCoreTests`: 純粋なロジックと WebSocket のローカル接続のテスト
- `Tests/SttBenchTests`: `stt-bench` の合成の時刻計算と、エコー計測の純粋な部分（偽の canceller を使い、`say`・音声認識・AEC3 は使わない）

## 使い方

```sh
cd helper
swift run live-mindmap-helper list                         # 音を出している会議アプリを JSON で出す
swift run live-mindmap-helper check                        # モデル・マイク・画面収録の状態を JSON で出す
swift run live-mindmap-helper run --app <bundle id> [--port <n>] [--audio-dir <dir>] [--origin <host time>] [--audio-index <n>] [--no-screen] [--self-manual pause|take] [--self-basis using|idle] [--self-last-known using|idle] [--self-idle-for <秒>]   # 既定のポートは 8765
swift run live-mindmap-helper transcribe-file --file <path> [--port <n>] [--audio-dir <dir>]   # 音声（動画）ファイル 1 本を文字にして、相手の partial・remark として流し、映像があれば共有画面の screen も流す（cli recorded が起動する）。--audio-dir を渡すと、待ち受けの前にファイルの音声を <dir>/相手.m4a に書く
swift run live-mindmap-helper creation-date --file <path>  # ファイルに記録された作成日時を {"creationDate":"<ISO8601>"|null} で出す（記録が無い・読めないときは null。終了コード 0）
swift run live-mindmap-helper mix --session <dir> --out <path> [--track 自分]   # セッションの録音を 0 秒から重ねて 1 本の 32 kbps・24 kHz モノラル m4a にする
swift run live-mindmap-helper readings <語>...             # 語ごとのローマ字の読みを JSON で出す
```

`run` は、選んだアプリ（本体と helper のプロセス）だけをタップする。Zoom は `us.zoom.xos`、ブラウザはブラウザ全体になる（Meet のタブだけには絞れない）。合うプロセスがなければ、Mac 全体のタップには切り替えず、エラーで終わる。音声の処理が取得に追いつかず、未消費のバッファが上限（2048 個）を超えたときも、音声を捨てずにエラーで終わる。
同時にマイクも取り、`自分` のトラックとして、`相手` とは別の SpeechAnalyzer で文字起こしする（2 本が並行して動く）。Apple の音声処理（Voice Processing のエコーキャンセル）は有効にしない（有効にするとプロセスタップが止まる）。スピーカーのときは、下の「エコーキャンセル」で漏れを消す。入力の機器が変わる（`AVAudioEngineConfigurationChange`）と、標準エラーに理由を 1 行出して終了コード 75 で終わる。作り直しはサーバーの起動し直しに任せる。マイクが許可されていないときは、エラーで終わる。Ctrl-C（SIGINT / SIGTERM）で、タップ・マイク・WebSocket を片付けて終わる。

`transcribe-file` は、音声ファイル（音声のトラックがあれば動画も）1 本を `相手` として文字にして流す。映像のトラックがあれば、最初の 1 本を共有画面として流す（下記）。音声の取り込みと話者分離は扱わない。`--audio-dir` があれば、最初にファイルの音声だけ（動画からは映像を除く）を AAC の `相手.m4a` として書く（元のファイルはコピーしない。先頭が 0 秒で、結果の時刻と一致する。出力が既にあれば上書きせず終了コード 1）。手順は次のとおり。待ち受けを始め、全体の長さの `file-duration` と音声トラックの本数の `file-audio-tracks` を保持して流す → 最初のクライアントが接続するのを待つ → `partial`・`remark` を流す → 最後のフレームを送り終えるのを待つ → 終了コード 0 で終わる。
音声は `AVAssetReader` で PCM に読み、SpeechAnalyzer が引いたぶんだけ渡す。間に上限つきの列を置かない（入力の上限 2048 個に当たらない）ので、速さは analyzer に合い、等速より速く進む。
映像は `AVAssetReader` で BGRA に読み、ライブと同じ 4 fps（`screenFramesPerSecond`）に間引いて、ライブと同じ変化の判定（`ScreenChangeDetector`）に動画の時刻（PTS、先頭が 0 秒で音声の時刻と同じ）つきで流す。送る画像（1280×720 に収めた JPEG・品質 0.8）と送ると決めた画面の OCR もライブと同じ。ブラウザのタブのタイトルによる判定はかけず、顔だけの画面も特別扱いしない。映像を止めるフラグは無い。判定と OCR は文字にする処理と並べて進め、画面の `screen` はすべて `partial`・`remark` より先に流す（サーバーが音声の時刻の順に入れる）。映像のトラックが無いファイルでは `screen` も `screen-off` も出ない。映像のトラックがあって読めなければ、標準エラーに 1 行出して `screen-off`（許可なし）を流し、音声だけで続ける（途中で読めなくなったときは、画像を送った後なら `image: null` の後に `screen-off`）。
結果の `start` / `end` は、ファイルの音声の先頭を 0 とする秒数（壁時計ではない）。ほぼ無音の区間の結果は、ライブと同じ基準（−70 dBFS）で捨てる。ライブの音量の記録は直近 30 秒しか持たないので、ここではファイルから区間の音量を読み直して判定する（ファイルと重ならない区間など、測れない区間の結果は捨てない）。SIGINT / SIGTERM で読むのをやめて終わる。終了コード: 0 は正常、1 はエラー、2 は使い方の誤り。
`run` の終了コード: 0 は正常、1 はエラー、2 は使い方の誤り、75 はマイクの入力の構成の変化（sysexits.h の `EX_TEMPFAIL`。サーバーは失敗に数えずに起動し直す）。

`check` は状態の照会だけを行い、ダイアログ、モデルのダウンロード・予約、音声・画面の取り込みを行わない。成功時は標準出力に次の形の JSON を出して終了コード 0 で終わる。失敗時は標準エラーに理由を出して終了コード 1 で終わる。

```json
{"microphone":"authorized","screenCapture":true,"speechJa":{"installedLocales":["ja_JP"],"status":"installed"}}
```

`speechJa.status` は ja-JP のモジュールに対する `AssetInventory.status(forModules:)` の結果で、`unsupported`・`supported`・`downloading`・`installed` を区別する。`installedLocales` は `SpeechTranscriber.installedLocales` が返す全 locale の識別子一覧（空の場合もある）で、モデル状態から推測せず、日本語だけに絞らない。`microphone` は `notDetermined`・`denied`・`authorized` の三分類（restricted は denied）。`screenCapture` は画面収録の preflight 結果の Bool。未知のモデル・マイク状態はエラーにする。

権限は起動元に付き、モデルの予約は実行ファイルの識別子ごとなので、サーバーで使う状態を確かめるときはサーバーが起動したヘルパーで `check` を行う。

`--audio-dir <dir>` を付けると、トラックごとの録音を、既存のフォルダ `<dir>` の `相手.m4a`・`自分.m4a`（AAC・48 kHz・モノラル）に書く。録音の 0 秒は、発言の `start` / `end` の 0 秒（音声取得を始める直前）と同じ。書き込みに失敗したときは、そのトラックをエラーで終わらせる。終了時は、タップとマイクを止めて録音ファイルを閉じてからプロセスが終わる（呼び出し側は、プロセスの終了で書き終わりを知る）。付けなければ録音しない。

`mix` は、`--session <dir>` 直下の `相手.m4a`・`相手-N.m4a`・`自分.m4a`・`自分-N.m4a`（それ以外のファイルは無視）を 0 秒の位置から重ね、`--out <path>` に 32 kbps・24 kHz・モノラルの m4a（moov は先頭）として書く。長さは一番長い入力と同じで、途切れは無音で埋めない。`--track 自分` なら `自分` のファイルだけを混ぜる。出力のファイルが既にあるとき、録音が無いとき、読めない入力があるときは、上書きせずに標準エラーへ理由を出して 1 で終わる（引数の誤りは usage と 2）。AVFoundation だけで作り、ffmpeg は使わない。

`readings <語>...` は、引数ごとに 1 語として、語ごとのローマ字の読み（CFStringTokenizer の `ja`）を標準出力に `[{"surface":"会議","romaji":"kaigi"}]` の JSON で出す（入力の順）。語を CFStringTokenizer で区切り、語のローマ字をつないだものが読みになる。読みが作れない語（読みが空の語を含む語）は出さない。語が 0 個のときは usage と 2 で終わる。サーバーが利用者の足した語（`cli start --vocab`）の読みを作るために、まとめて 1 回起動する。

`run` は、選んだアプリの共有画面も取り込む（ADR 0011）。ScreenCaptureKit で、`--app` の bundle id と `SCWindow.owningApplication` の bundle id が完全に一致する、画面に出ているウィンドウのうち面積が最大のものを、システムのウィンドウピッカーを使わずに直接撮る（非公開 API は使わない）。1 秒に 4 フレーム取り、128×72 の輝度でマスごとに判定して、画面が変わったときだけ `screen` を流す。比べる相手は最後に送った画面で、輝度差が 10 を超えたマスが、比べたマスの 0.5% を超えたら新しい画面とする。ただし、動いている場所は比べる対象から外す: 前のフレームとの輝度差が 3 を超えたマスは、最後に動いてから 1 秒間と、動いたフレームの割合の移動平均（時間の幅 10 秒）が 0.25 を超える間、「いま動いている」とする。周り 5×5 にいま動いているマスが 8 つ以上あれば（スクロール・動画・顔の小窓）周り 2 マスまで、そうでなければ（キャレットなど）周り 1 マスまで外す。止まって 1 秒で比べる対象に戻る。違うマスが全体の 10% 未満で、前に送った画面（直近 30 枚）のどれか 1 枚と輝度差 6 以内でそろうとき（話している人の枠の移動）は送らない。映り始めた時刻（`start`）は、違うマスが今の値になった時刻の中央値で、前に送ると決めたフレームの時刻より前にはしない。ブラウザ（Chrome・Edge・Safari・Arc・Brave・Firefox）では、ウィンドウのタイトルに「Meet」を含まないタブのあいだは画面を送らず、画像を送った後なら `image` が `null` の `screen` を 1 回流す（タイトルが読めないときは会議のタブとして扱う）。会議アプリ本体はタイトルを見ない。タイトルは取り込みの間 1 秒ごとに `SCShareableContent` で読み直す。OS が idle のフレームを出したときも、輝度の画像は作り直さずに時刻だけ判定器へ進める。画像は縦横の比を保って 1280×720 に収まるように縮めた JPEG（小さければ拡大しない）。会議アプリのウィンドウが見つからないとき（開始時など）は、標準エラーに理由と探し直すことを 1 行出し、見つかるまで 2 秒（`screenWindowRetryInterval`）ごとに `SCShareableContent` を読み直して探す（回数・時間に上限は無い）。見つかったら、その時点で取り込みを始め、最初の画面を送る。探している間は `screen-off` を流さず、音声の取り込みは続ける（ヘルパーは終わらない）。`stop()`（SIGINT / SIGTERM）は探している最中でもすぐ効く。それ以外の取り込みの失敗（`SCShareableContent` の読み込みや開始の失敗）は、標準エラーに理由を 1 行出して画面だけ送らず、音声の取り込みは続ける。

画面収録の許可は、`run` の開始時に公開 API（CoreGraphics の `CGPreflightScreenCaptureAccess`・`CGRequestScreenCaptureAccess`）で 1 回だけ確かめる。まだ聞いていなければ OS のダイアログが出る（会議の途中では確認を出さない）。許可が無い・断られたときは、取り込みを始めず、標準エラーに理由を 1 行出して `screen-off`（`許可なし`）を 1 回流し、音声の取り込みは続ける（エラーで終わらない）。取り込みの途中で止まったとき（`stream(_:didStopWithError:)` で、撮っていたウィンドウがまだあるとき）も同じ。それまでに画像を送っていれば、`screen-off` の前に `image` が `null` の `screen` を送る。撮っていたウィンドウが無くなったときは `screen-off` にせず、`image` が `null` の `screen` を 1 回だけ流し、終わらずに上と同じく探し直して、見つかったら取り込みを始め直す（前と別のウィンドウでも撮る）。

`--no-screen`（値は取らない）を付けると、共有画面を取り込まない。`ScreenCapture` を作らず、画面収録の許可も確かめず、ScreenCaptureKit も呼ばず、`screen-off` も流さない。付けなければ共有画面を使う。

`--origin <host time>` は、`run` の時刻の基準（`AudioGetCurrentHostTime()`）を上書きする。サーバーが予期せず落ちたヘルパーを再起動するときに使い、再起動後のヘルパーの発言・録音の時刻を 0 に戻さず、元の起動の続きにする。`--audio-index <n>`（既定は 1）は、録音ファイルの名前の番号を選ぶ。1 なら `相手.m4a`・`自分.m4a`（今まで通り）、2 以上なら `相手-N.m4a`・`自分-N.m4a` になる。再起動したヘルパーが前回の録音を上書き（`AVAudioFile(forWriting:)` は既存ファイルを黙って切り詰める/置き換える）しないようにするため。

`--self-manual`・`--self-basis`・`--self-last-known`・`--self-idle-for` は、`自分` の休止の規則（`SelfPauseRule`）の状態を引き継ぐ。サーバーが、手で選んだ状態・待ちの進み具合を続けたままヘルパーを起動し直すときに使う。初期状態と同じ値は渡さない。`--self-manual` は手動の状態（`pause` か `take`）、`--self-basis` は手動の基準（手で選んだ時点の判定。`using` か `idle`）、`--self-last-known` は最後に読めた判定（`using` か `idle`）、`--self-idle-for` は「使っていない」が続いた秒数（0 以上）。値が不正なら使い方の誤りとして終了コード 2 で終わる。

`自分` があるとき、ヘルパーは `--app` に当たるプロセス（`相手` の取り込みの対象と同じ規則。自分の pid は除く）の入力の使用（Core Audio の `IsRunningInput`）を読み、会議アプリがマイクを使っていない間は `自分` を自動で休止する。どれか 1 つが使っていれば「使っている」、当たるプロセスが無い・読めないときは「分からない」（休止にせず取る）。「使っていない」が 3 秒続いてから休止に入り、使い始めるとすぐ取る。読み直しは、プロセスの機器とプロセス一覧の変化の通知と、0.5 秒ごとのポーリング。組み合わせの規則は `SelfPauseRule`（Core Audio もタイマーも持たない）。

## サーバーからの指示

サーバーは、ヘルパーの WebSocket に、テキストフレームで JSON を 1 件ずつ送る。今ある指示は `自分` の休止・再開だけ。

```json
{"type":"self-pause","paused":true,"token":"<起動時に環境変数で渡されたトークン>"}
```

- `token` は、サーバーが起動ごとに作って環境変数 `LIVE_MINDMAP_HELPER_CONTROL_TOKEN` でヘルパーに渡す値。一致しない・無い・文字列でない指示は読み捨てる（状態もイベントも変わらない）。環境変数が無い（手で起動した）ときは、標準エラーに 1 行出して、指示を処理しない（イベントの配信は続く）

- `paused` は求める状態（`true` が休止、`false` が再開）。トグルではなく状態を指定する形なので、同じ指示を重ねても結果は変わらない。壊れた JSON・知らない `type`・`paused` が真偽値でない指示も読み捨てる
- 休止の間も、マイクの取り込みは止めずに、`自分` の音だけを捨てる。STT には渡さず、録音には捨てた音と同じ長さ・同じ取得時刻の無音を書く（録音ファイルは休止で分けず 1 本のまま。発言の時刻と録音の位置は休止の後も揃う）。休止か再開かは、指示を受け付けた時刻と、バッファを取得した時刻を比べて決める（読んだ時刻ではない）。休止の前に取った音は、休止の後に読んでも流して発言に確定し、休止中に取った音は、再開の後に読んでも捨てる。休止に入るたびに STT の区間を閉じる。再開すると、新しい Transcriber で次の区間を始め、結果は 1 本の流れにつなぐ。AEC には休止の間も連続した音を渡す
- 状態が変わったときだけ、`self-pause` のイベントを流す（同じ状態の指示は何も変えず、イベントも出さない）
- マイクの許可が無く `自分` を作らないときは、指示を無視する（状態もイベントも変わらない）

## イベントの形

`ws://127.0.0.1:<port>` に、テキストフレームで JSON を流す。`start` / `end` は、`run` が音声取得を始める直前を 0 とする、2 トラック共通の秒数。`id` はサーバーが採番するので、ここでは付けない。`自分` のトラックも `相手` と同じ形で流れる。

```json
{"type":"partial","track":"相手","start":1.5,"end":2,"text":"こんに","duplicate":false,"words":[{"surface":"こんに","romaji":"konni","location":0,"length":3}],"wordTimes":[{"location":0,"length":3,"start":1.5,"end":2}]}
{"type":"remark","track":"相手","start":1.5,"end":3.25,"text":"こんにちは","duplicate":false,"words":[{"surface":"こんにちは","romaji":"konnichiha","location":0,"length":5}],"wordTimes":[{"location":0,"length":5,"start":1.5,"end":3.25}]}
{"type":"partial","track":"自分","start":4,"end":4.5,"text":"はい","duplicate":false,"words":[{"surface":"はい","romaji":"hai","location":0,"length":2}],"wordTimes":[{"location":0,"length":2,"start":4,"end":4.5}]}
{"type":"origin","hostTime":"123456789"}
{"type":"screen","start":12.5,"image":"/9j/4AAQSkZJRg==","lines":["港南店","Zendesk"]}
{"type":"screen","start":80,"image":null}
{"type":"screen-off","start":0.5,"reason":"許可なし"}
{"type":"tap-silent","start":10.5}
{"type":"self-pause","paused":true,"reason":"手動","start":42.5}
{"type":"self-pause-state","manual":"pause","basis":"using","lastKnown":"idle","idleFor":1.5}
{"type":"speaker","track":"相手","start":1.5,"end":2.25,"slot":1,"final":false}
{"type":"speaker","track":"相手","start":0,"end":1.5,"slot":0,"final":true}
{"type":"speaker-off","start":0.5,"reason":"モデルなし"}
{"type":"file-duration","duration":3484.5}
{"type":"file-audio-tracks","count":2}
```

- `words`（`partial` と `remark` の両方、両トラック）: 本文を CFStringTokenizer（`ja`、語の境界）で区切った語の配列。要素は `surface`（表記）・`romaji`（`kCFStringTokenizerAttributeLatinTranscription` のローマ字の読み。無ければ空文字）・`location` / `length`（本文の中の位置と長さ。UTF-16 コード単位で、`start` / `end` の秒とは別）。語が無い本文は空の配列。サーバーは `words` の無いイベントも受け付ける
- `wordTimes`（`partial` と `remark` の両方、両トラック。常に載せる）: STT（SpeechAnalyzer）の結果の run ごとの区間の配列。要素は `location` / `length`（本文の中の位置と長さ。UTF-16 コード単位。`words` と違い、区切りの元は STT の run）・`start` / `end`（会議の原点からの秒。発言の `start` / `end` と同じ基準）。時刻を持たない run は要素にしない。区間を持たない結果は空の配列。サーバーは `wordTimes` の無いイベントも受け付け、`log.jsonl` の発言の行にそのまま残す
- `partial`: 途中結果（トラック・開始・終了・本文・重複の印・語）。同じトラックで `start` が同じ途中結果の列は、同じ発話の更新（本文が変わっても同じ発話）。サーバーは、1 秒更新されない発話を最後の本文・区間で発言にする（`自分` の途中結果は発言にしない）。`duplicate` は、出力先がスピーカーのとき、`自分` の途中結果のうち、前後 8 秒の `相手` の確定結果と `相手` の最新の途中結果をつないだ文字列との文字 3-gram の被覆率が 0.6 以上のものが true（正規化後に 3 文字未満は false、`相手` の途中結果は常に false）。印の付いた途中結果も捨てずに流し、サーバーは字幕に出さない
- `remark`: 確定結果（トラック・開始・終了・本文・重複の印・語）。`duplicate` は、出力先がスピーカーのとき、`自分` の発言のうち前後 8 秒の `相手` の発言と文字 3-gram の被覆率が 0.6 以上のものが true（`相手` の発言は常に false）。印の付いた発言も捨てずに流す。サーバーは印の付いた発言を差分更新に使わず、ログには残す
- `origin`: ヘルパーのプロセスにつき 1 回だけ、時刻の基準が決まった直後（`partial` / `remark` より前）に送る。`AudioGetCurrentHostTime()` の値（`--origin` を渡したときはその値）を `hostTime` に積む。64 bit の値は JSON の number では桁が落ちるので、文字列にする。サーバーは、ライブセッションの間、最初のヘルパーの `origin` の値を覚えておき、再起動したヘルパーに `--origin` として渡すことで、発言の時刻が再起動のたびに 0 へ戻らず、元の開始からの続きになるようにする。`origin` は broadcast した時点でサーバー側のクライアントの接続が間に合わないことが多いため、ヘルパーは値を保持し、broadcast より後に接続したクライアントにも送る
- `screen`: 共有画面の変化。`start` は `origin` と同じ原点（`--origin` を渡したときはその値）からの秒。画像付きの `start` は、違うマスが今の値になった時刻の中央値を、前に送ると決めた時刻で下限補正した値（最初の画像だけは、そのフレームの時刻）。`image` が `null` のときの `start` は、ウィンドウが消えた時刻、または会議以外のタブと判定した時刻。`image` は JPEG の base64。`lines` は、送ると決めた画面だけを Vision（`VNRecognizeTextRequest`、日本語と英語）で読んだ文字の行（文字列の配列。上から順）で、OCR が失敗したときは空の配列（画像は送る）。差分更新のモデルには画像だけを渡す。映していたウィンドウが無くなったときは `image` が JSON の `null`（キーは省かない）で、`lines` のキーは付けない。`screen` も `origin` と同じく、サーバーがつながる前に出た分は最新の 1 件だけを保持し、つながったら送る（`origin` の次に届く）
- `screen-off`: 共有画面を取り込めない（画面収録の許可が無い・断られた・取り込みの途中で止まった）。`start` は `screen` と同じく `origin` と同じ原点からの秒。`reason` はヘルパーが流す限り `許可なし` だけ（`指定` はサーバーが書く）。`origin`・`screen` と同じく、`screen` とは別の key で最新の 1 件を保持し、後からつながったクライアントにも送る。音声の取り込みは止まらない
- `tap-silent`: `相手` のタップを始めてから 10 秒（`tapSilentJudgementDelay`）、フレーム数 1 以上のバッファを 1 つも受け取らなかった。サンプルの値（ゼロかどうか）は見ない。`start` は `origin` と同じ原点からの秒（判定した時刻）。ヘルパーのプロセスにつき最大 1 回だけ流し、別の key で保持して、後からつながったクライアントにも送る。判定の時点で、機器の状態の 1 行を標準エラーにも出す
- `self-pause`: `自分` の休止の状態が変わった（サーバーからの指示と、会議アプリのマイクの使用による。`自分` があれば、起動時に現在の状態（`paused`）を 1 回流す。休止・再開どちらでも。`自分` がなければ流さない）。`paused` は変わった後の状態、`reason` は `手動`（手で選んだ）・`自動`（会議アプリがマイクを使っていない）・`判定できない`（読めない間。取っている）のどれか、`start` は `origin` と同じ原点からの秒。休止中に理由だけが変わったときも流す。別の key で最新の 1 件を保持し、後からつながったクライアントにも送る。サーバーは `paused` が変わったときだけ `log.jsonl` に `self-paused` / `self-resumed` の組で `reason` つきで残す
- `self-pause-state`: `自分` の休止の規則の、起動し直しで引き継ぐ状態（`manual`・`basis`・`lastKnown`・`idleFor`）。値が変わるたびに流し（`自分` があれば、起動時にも 1 回）、別の key で最新の 1 件を保持する。サーバーは覚えるだけで（ログにも画面にも出さない）、ヘルパーを起動し直すとき引数で送り直す

- `file-duration`: `transcribe-file` が最初に 1 回流す、ファイルの音声の全体の長さ（`duration`。秒）。サーバーが進み具合の「全体」に使う。別の key で保持して、後からつながったクライアントにも送る。`run` は流さない
- `file-audio-tracks`: `transcribe-file` が `file-duration` の次に 1 回流す、ファイルの音声トラックの本数（`count`。1 以上）。文字にするのは最初の 1 本だけ。サーバーは 2 本以上のときだけ、`cli recorded` の端末に知らせる。別の key で保持して、後からつながったクライアントにも送る。`run` は流さない
- `speaker`: `相手` のトラックだけに FluidAudio の Sortformer（CoreML、`fastV2_1`）で話者分離をかけた、話者の区間（Issue #1020）。STT の `partial` / `remark` とは別のイベントで、サーバーが確定した区間（`final: true`）から `相手` の発言の話者を決める（Issue #1021。仮の区間は発言に使わない）。`track` は常に `相手`。`start` / `end` は `origin` と同じ原点からの秒（発言の `start` / `end` と同じ規則で、最初のバッファの取得時刻の差を足す）。`slot` は Sortformer の出力の番号（0 始まり。話者のラベルではない）。`final` が `true` なら確定した区間、`false` なら確定より新しい部分の仮の区間（後で変わり得る）。通常の broadcast で流し、保持しない。音声が終わったら残りを確定させて流す。`自分` のトラックには話者分離をかけない。音声は Mac の外に出ない
- `speaker-settled`: `相手` の話者分離が、ここまで確定した（Issue #1021）。`to` より前の確定した区間（`speaker` の `final: true`）は、すべて流した。`track` は常に `相手`。`to` は `origin` と同じ原点からの秒で、値は前に流した値より小さくならない。話者分離の更新ごとに、その更新の区間を流した後で 1 件流す（区間が無い更新、黙っている間も流す）。音声が終わったら、残りを確定させて流した後に、処理した音声の終わりを流す。`to` は FluidAudio の確定の条件（確定済みの末尾から最小の間隔と前後の余白を引いた位置、ただし閉じていない区間・確定待ちの区間の start を越えない）から求める。FluidAudio は 1 回の更新の確定区間を時刻の順ではなく話者の枠の番号順に流し、閉じた区間だけを確定として流すので、サーバーは区間の `end` から「揃った」を判定できない。サーバーは発言の `end` 以上の `to` が届くまで、`相手` の発言を保留する。通常の broadcast で流し、保持しない
- `speaker-off`: 話者分離を使えない。`reason` は `モデルなし`（モデルのファイルが無い。会議中にはモデルを取りに行かない）・`読み込みに失敗`・`途中で停止`（区間の流れがエラーで終わった）のどれか。`start` は `origin` と同じ原点からの秒。認識とセッションは止めない。別の key で保持して、後からつながったクライアントにも送る。モデルはセットアップの段で `bash helper/scripts/fetch-speaker-models.sh`（`live-mindmap-helper install-speaker-models`。保存先は FluidAudio の既定の `~/Library/Application Support/FluidAudio/Models`。入っていれば何もしない）が前もって取得する

### エコーキャンセル（スピーカーのとき）

- 出力先がスピーカー（`marksDuplicates` が true。判定は `run` の開始時に 1 回）のときだけ、マイクの音を STT に渡す前に、WebRTC AEC3 でスピーカーから漏れた相手の声を消す。内蔵のヘッドフォンジャックのイヤホンのときは素通し。Bluetooth はスピーカーのこともあるのでかける（AirPods など漏れないものでは、ほぼ素通しになる）
- 参照信号はタップの音（スピーカーに出る音そのもの）。タップの流れは `相手` の STT と AEC の参照に分けて配る。起動時に stderr へ `echo cancellation: enabled ...` が出る
- 参照とマイクは `hostTime` で揃える。マイクの 10 ms を処理する前に、その時刻までの参照の 10 ms をすべて AEC に渡し、足りないときは無音で埋める。参照が届くのを待つ間はマイクの処理を保留する（500 ms を超えたら無音で埋めて進める）。ファイルの先頭どうしで揃えると、ほとんど消えない
- 両方を 48 kHz・モノラルに変換して 480 サンプルずつ渡す。出力の `hostTime` は元のマイクのまま
- **`--audio-dir` の録音は、AEC の後の音**（STT が聞いた音と同じ）。スピーカーのとき `自分.m4a` には漏れが消えた音が入り、消す前の音は残らない
- 設定は、エコーキャンセルと高域通過フィルターだけを有効にする（ゲイン制御とノイズ抑制は無効）。AEC3 の設定は、エコー経路の強さの初期値（`ep_strength.default_gain`）だけを既定の 1 から 0.01 に下げている（漏れの無い条件の開始直後に発話が削られるのを防ぐ。`docs/investigations/2026-10-04-aec-startup-config.md`）
- Apple の Voice Processing と非公開 API は使わない。AEC3 で取り切れなかった漏れは、下の重複の印が保険として拾う
- ライブラリは `scripts/build-webrtc-apm.sh` でビルドする（freedesktop の `webrtc-audio-processing` の固定コミット。`uv` が要る。meson と ninja は `uvx` で一時的に使う）。ビルド済みなら何もしない。無いまま `swift build` すると、スクリプトを走らせるよう促すエラーで止まる。`pnpm test` と `pnpm typecheck` は、ライブラリが無ければ先にスクリプトを走らせる

### 重複の印（スピーカーのとき）

- 出力先（既定の出力デバイス）は `run` の開始時に 1 回だけ判定する。会議中の切り替えには追従しない
- 内蔵スピーカー、Bluetooth、USB・HDMI・AirPlay などの外部スピーカーでは判定する。イヤホン（内蔵のヘッドフォンジャック）では判定せず、`duplicate` は常に false
- 判定のため、`自分` の確定結果は後 8 秒の `相手` の発言を待ってから流れる（`相手` が無音でも 8 秒で流れる）。途中結果と `相手` の発言は待たない
- 正規化後に 3 文字未満の発言は判定せず、印を付けない

## 確定の遅れの計測（stt-bench）

合成した音声を実時間で SpeechAnalyzer に流し、結果が届いた時刻を JSONL で出す。結論は `docs/investigations/2026-10-02-remark-finalization-latency.md`。

```sh
cd helper
swift run -c release stt-bench synth bench/scenarios/continuous.json /tmp/stt97/cont      # 台本 → wav + 行の時刻 + 正解（--only <名前> --gap <秒>）
swift run -c release stt-bench variants                                                   # 候補の設定の一覧
swift run -c release stt-bench run --variant baseline /tmp/stt97/cont/short.wav [--load <音声2.wav>] > /tmp/stt97/short.jsonl
node ../server/bench/sttLatency.ts /tmp/stt97/short.jsonl --lines /tmp/stt97/cont/short.lines.json [--quiet <秒>]
```

- 台本は `bench/scenarios/`（`continuous.json` は続けて話す・相づちが重なる音声、`bench6.json` は決定と TODO の正解付きの 6 場面）。声は `say`（A = Kyoko、B = Reed）
- 合成した音声と計測の出力は、リポジトリの外（`/tmp` など）に置く。実会議の録音も入れない
- `--load` は、同じ候補の 2 本目の認識を並行して流す（本番の 自分 / 相手 の 2 本同時に当たる）
- 再生して再現率を出すのは `server/bench/sttReplay.ts`（Claude の認証が要る）

## AEC3 の開始直後の計測（stt-bench echo）

会議の音を参照にした、遅れと減衰付きの漏れに、既知の発話を開始 5・30・60 秒に足し、1 つの `WebRTCEchoCanceller` に連続して通す。発話の成分のエネルギーの残り方（dB）を、時刻別・遅れ別に JSONL で出す。結論は `docs/investigations/2026-10-03-aec-startup-double-talk.md`。

```sh
cd helper
bash scripts/build-webrtc-apm.sh                                                          # AEC3 のビルド（済みなら何もしない）
swift run -c release stt-bench synth bench/scenarios/echo.json /tmp/aec118                # meeting.wav（参照）と self.wav（発話）
swift run -c release stt-bench echo /tmp/aec118/meeting.wav /tmp/aec118/self.wav --self-lines /tmp/aec118/self.lines.json \
  [--delays 40,200,300] [--at 5,30,60] [--leak-gain-db -10] [--candidate baseline,bypass-3] [--out /tmp/aec118/out] > /tmp/aec118/baseline.jsonl
```

- 出力の項目: `retentionDb`（発話の残り方。0 なら全部残る）、`leakReductionDb`（同じ区間の漏れの低下量）、`referenceRmsDbfs`。`--leak-gain-db -inf` は漏れの無い対照
- `--candidate`: `baseline`（#118 の設定 = AEC3 の既定値）、`production`（本番の設定）、`bypass-<秒>`（開始から N 秒は AEC の出力を使わない。AEC には通し続ける）
- `--at` の窓は発話の長さ（約 11 秒）なので、近い時刻は別の実行に分ける。`--out` は `stt-bench run` に渡せる 48 kHz の wav を書く

## テスト

```sh
pnpm --filter @live-mindmap/helper test
```

Command Line Tools だけの環境では XCTest がないため、swift-testing のマクロ用に `-plugin-path` を付ける（`package.json` の typecheck script のビルドで渡す。test script はそれを通る）。

## 実機での確認手順（人が行う）

1. Zoom かブラウザの会議（または音声の流れるセミナー）を開き、音を出す
2. `swift run live-mindmap-helper list` に、そのアプリが出ることを確かめる
3. `swift run live-mindmap-helper run --app <出た bundle id>` を起動する
4. 別のターミナルで WebSocket のクライアントをつなぐ（例: `npx wscat -c ws://127.0.0.1:8765`）
5. 会議の音を流したまま、マイクに向かって話す
6. `相手` と `自分` の両方の `partial`（途中結果）と `remark`（発言）が届くことを確かめる。2 トラックの `start` / `end` が同じ基準の秒数で、近い時刻の発言が近い値になることも見る

### スピーカーでの重複の確認

1. 出力先を内蔵スピーカーにして、上の手順で `run` を起動し、WebSocket のクライアントをつなぐ
2. 会議の音をスピーカーから流し、マイクに入る状態にする。`相手` の発言と同じ内容の `自分` の `remark` に `"duplicate":true` が付くことを確かめる。マップに同じ内容が二重に入らないことも見る
3. マイクに向かって自分の言葉で話し、その `remark` が `"duplicate":false` で届くこと（誤って捨てられていないこと）を確かめる
4. 出力先を有線のイヤホン（内蔵のヘッドフォンジャック）に変えて `run` を起動し直し、`duplicate` が常に false であることを確かめる

### 60 分の連続動作と CPU 負荷

1. 上の手順で `run` を起動し、WebSocket のクライアントをつないだままにする
2. 別のターミナルで CPU を 1 分ごとに記録する: `top -pid $(pgrep -f live-mindmap-helper | head -1) -l 0 -s 60 -stats pid,cpu,mem | tee helper-cpu.log`
3. 60 分の間、会議の音とマイクの音を流し続ける。2 本の SpeechAnalyzer が止まらず、両方のトラックの発言が届き続けることを確かめる
4. 終わったら、`helper-cpu.log` から CPU の平均と最大を、この issue（#34）に記録する
