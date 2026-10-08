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
swift run live-mindmap-helper run --app <bundle id> [--port <n>] [--audio-dir <dir>] [--origin <host time>] [--audio-index <n>] [--no-screen]   # 既定のポートは 8765
swift run live-mindmap-helper mix --session <dir> --out <path> [--track 自分]   # セッションの録音を 0 秒から重ねて 1 本の 16 kbps モノラル m4a にする
```

`run` は、選んだアプリ（本体と helper のプロセス）だけをタップする。Zoom は `us.zoom.xos`、ブラウザはブラウザ全体になる（Meet のタブだけには絞れない）。合うプロセスがなければ、Mac 全体のタップには切り替えず、エラーで終わる。音声の処理が取得に追いつかず、未消費のバッファが上限（2048 個）を超えたときも、音声を捨てずにエラーで終わる。
同時にマイクも取り、`自分` のトラックとして、`相手` とは別の SpeechAnalyzer で文字起こしする（2 本が並行して動く）。Apple の音声処理（Voice Processing のエコーキャンセル）は有効にしない（有効にするとプロセスタップが止まる）。スピーカーのときは、下の「エコーキャンセル」で漏れを消す。マイクのデバイスが切り替わっても取得は再開しない。マイクが許可されていないときは、エラーで終わる。Ctrl-C（SIGINT / SIGTERM）で、タップ・マイク・WebSocket を片付けて終わる。

`--audio-dir <dir>` を付けると、トラックごとの録音を、既存のフォルダ `<dir>` の `相手.m4a`・`自分.m4a`（AAC・48 kHz・モノラル）に書く。録音の 0 秒は、発言の `start` / `end` の 0 秒（音声取得を始める直前）と同じ。書き込みに失敗したときは、そのトラックをエラーで終わらせる。終了時は、タップとマイクを止めて録音ファイルを閉じてからプロセスが終わる（呼び出し側は、プロセスの終了で書き終わりを知る）。付けなければ録音しない。

`mix` は、`--session <dir>` 直下の `相手.m4a`・`相手-N.m4a`・`自分.m4a`・`自分-N.m4a`（それ以外のファイルは無視）を 0 秒の位置から重ね、`--out <path>` に 16 kbps・モノラルの m4a（moov は先頭）として書く。長さは一番長い入力と同じで、途切れは無音で埋めない。`--track 自分` なら `自分` のファイルだけを混ぜる。出力のファイルが既にあるとき、録音が無いとき、読めない入力があるときは、上書きせずに標準エラーへ理由を出して 1 で終わる（引数の誤りは usage と 2）。AVFoundation だけで作り、ffmpeg は使わない。

`run` は、選んだアプリの共有画面も取り込む（ADR 0011）。ScreenCaptureKit で、`--app` の bundle id と `SCWindow.owningApplication` の bundle id が完全に一致する、画面に出ているウィンドウのうち面積が最大のものを、システムのウィンドウピッカーを使わずに直接撮る（非公開 API は使わない）。1 秒に 4 フレーム取り、128×72 の輝度でマスごとに判定して、画面が変わったときだけ `screen` を流す。比べる相手は最後に送った画面で、輝度差が 10 を超えたマスが、比べたマスの 0.5% を超えたら新しい画面とする。ただし、動いている場所は比べる対象から外す: 前のフレームとの輝度差が 3 を超えたマスは、最後に動いてから 1 秒間と、動いたフレームの割合の移動平均（時間の幅 10 秒）が 0.25 を超える間、「いま動いている」とする。周り 5×5 にいま動いているマスが 8 つ以上あれば（スクロール・動画・顔の小窓）周り 2 マスまで、そうでなければ（キャレットなど）周り 1 マスまで外す。止まって 1 秒で比べる対象に戻る。違うマスが全体の 10% 未満で、前に送った画面（直近 30 枚）のどれか 1 枚と輝度差 6 以内でそろうとき（話している人の枠の移動）は送らない。映り始めた時刻（`start`）は、違うマスが今の値になった時刻の中央値で、前に送ると決めたフレームの時刻より前にはしない。ブラウザ（Chrome・Edge・Safari・Arc・Brave・Firefox）では、ウィンドウのタイトルに「Meet」を含まないタブのあいだは画面を送らず、画像を送った後なら `image` が `null` の `screen` を 1 回流す（タイトルが読めないときは会議のタブとして扱う）。会議アプリ本体はタイトルを見ない。タイトルは取り込みの間 1 秒ごとに `SCShareableContent` で読み直す。OS が idle のフレームを出したときも、輝度の画像は作り直さずに時刻だけ判定器へ進める。画像は縦横の比を保って 1280×720 に収まるように縮めた JPEG（小さければ拡大しない）。会議アプリのウィンドウが見つからないとき（開始時など）は、標準エラーに理由と探し直すことを 1 行出し、見つかるまで 2 秒（`screenWindowRetryInterval`）ごとに `SCShareableContent` を読み直して探す（回数・時間に上限は無い）。見つかったら、その時点で取り込みを始め、最初の画面を送る。探している間は `screen-off` を流さず、音声の取り込みは続ける（ヘルパーは終わらない）。`stop()`（SIGINT / SIGTERM）は探している最中でもすぐ効く。それ以外の取り込みの失敗（`SCShareableContent` の読み込みや開始の失敗）は、標準エラーに理由を 1 行出して画面だけ送らず、音声の取り込みは続ける。

画面収録の許可は、`run` の開始時に公開 API（CoreGraphics の `CGPreflightScreenCaptureAccess`・`CGRequestScreenCaptureAccess`）で 1 回だけ確かめる。まだ聞いていなければ OS のダイアログが出る（会議の途中では確認を出さない）。許可が無い・断られたときは、取り込みを始めず、標準エラーに理由を 1 行出して `screen-off`（`許可なし`）を 1 回流し、音声の取り込みは続ける（エラーで終わらない）。取り込みの途中で止まったとき（`stream(_:didStopWithError:)` で、撮っていたウィンドウがまだあるとき）も同じ。それまでに画像を送っていれば、`screen-off` の前に `image` が `null` の `screen` を送る。撮っていたウィンドウが無くなったときは `screen-off` にせず、`image` が `null` の `screen` を 1 回だけ流し、終わらずに上と同じく探し直して、見つかったら取り込みを始め直す（前と別のウィンドウでも撮る）。

`--no-screen`（値は取らない）を付けると、共有画面を取り込まない。`ScreenCapture` を作らず、画面収録の許可も確かめず、ScreenCaptureKit も呼ばず、`screen-off` も流さない。付けなければ共有画面を使う。

`--origin <host time>` は、`run` の時刻の基準（`AudioGetCurrentHostTime()`）を上書きする。サーバーが予期せず落ちたヘルパーを再起動するときに使い、再起動後のヘルパーの発言・録音の時刻を 0 に戻さず、元の起動の続きにする。`--audio-index <n>`（既定は 1）は、録音ファイルの名前の番号を選ぶ。1 なら `相手.m4a`・`自分.m4a`（今まで通り）、2 以上なら `相手-N.m4a`・`自分-N.m4a` になる。再起動したヘルパーが前回の録音を上書き（`AVAudioFile(forWriting:)` は既存ファイルを黙って切り詰める/置き換える）しないようにするため。

## イベントの形

`ws://127.0.0.1:<port>` に、テキストフレームで JSON を流す。`start` / `end` は、`run` が音声取得を始める直前を 0 とする、2 トラック共通の秒数。`id` はサーバーが採番するので、ここでは付けない。`自分` のトラックも `相手` と同じ形で流れる。

```json
{"type":"partial","track":"相手","start":1.5,"end":2,"text":"こんに","duplicate":false}
{"type":"remark","track":"相手","start":1.5,"end":3.25,"text":"こんにちは","duplicate":false}
{"type":"partial","track":"自分","start":4,"end":4.5,"text":"はい","duplicate":false}
{"type":"origin","hostTime":"123456789"}
{"type":"screen","start":12.5,"image":"/9j/4AAQSkZJRg=="}
{"type":"screen","start":80,"image":null}
{"type":"screen-off","start":0.5,"reason":"許可なし"}
```

- `partial`: 途中結果（トラック・開始・終了・本文・重複の印）。同じトラックで `start` が同じ途中結果の列は、同じ発話の更新（本文が変わっても同じ発話）。サーバーは、1 秒更新されない発話を最後の本文・区間で発言にする（`自分` の途中結果は発言にしない）。`duplicate` は、出力先がスピーカーのとき、`自分` の途中結果のうち、前後 8 秒の `相手` の確定結果と `相手` の最新の途中結果をつないだ文字列との文字 3-gram の被覆率が 0.6 以上のものが true（正規化後に 3 文字未満は false、`相手` の途中結果は常に false）。印の付いた途中結果も捨てずに流し、サーバーは字幕に出さない
- `remark`: 確定結果（トラック・開始・終了・本文・重複の印）。`duplicate` は、出力先がスピーカーのとき、`自分` の発言のうち前後 8 秒の `相手` の発言と文字 3-gram の被覆率が 0.6 以上のものが true（`相手` の発言は常に false）。印の付いた発言も捨てずに流す。サーバーは印の付いた発言を差分更新に使わず、ログには残す
- `origin`: ヘルパーのプロセスにつき 1 回だけ、時刻の基準が決まった直後（`partial` / `remark` より前）に送る。`AudioGetCurrentHostTime()` の値（`--origin` を渡したときはその値）を `hostTime` に積む。64 bit の値は JSON の number では桁が落ちるので、文字列にする。サーバーは、ライブセッションの間、最初のヘルパーの `origin` の値を覚えておき、再起動したヘルパーに `--origin` として渡すことで、発言の時刻が再起動のたびに 0 へ戻らず、元の開始からの続きになるようにする。`origin` は broadcast した時点でサーバー側のクライアントの接続が間に合わないことが多いため、ヘルパーは値を保持し、broadcast より後に接続したクライアントにも送る
- `screen`: 共有画面の変化。`start` は `origin` と同じ原点（`--origin` を渡したときはその値）からの秒。画像付きの `start` は、違うマスが今の値になった時刻の中央値を、前に送ると決めた時刻で下限補正した値（最初の画像だけは、そのフレームの時刻）。`image` が `null` のときの `start` は、ウィンドウが消えた時刻、または会議以外のタブと判定した時刻。`image` は JPEG の base64。映していたウィンドウが無くなったときは `image` が JSON の `null`（キーは省かない）。`screen` も `origin` と同じく、サーバーがつながる前に出た分は最新の 1 件だけを保持し、つながったら送る（`origin` の次に届く）
- `screen-off`: 共有画面を取り込めない（画面収録の許可が無い・断られた・取り込みの途中で止まった）。`start` は `screen` と同じく `origin` と同じ原点からの秒。`reason` はヘルパーが流す限り `許可なし` だけ（`指定` はサーバーが書く）。`origin`・`screen` と同じく、`screen` とは別の key で最新の 1 件を保持し、後からつながったクライアントにも送る。音声の取り込みは止まらない

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

Command Line Tools だけの環境では XCTest がないため、swift-testing のマクロ用に `-plugin-path` を付ける（`package.json` の test script）。

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
