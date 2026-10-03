# helper

会議の音声を文字起こしして発言をサーバーへ流す Swift のヘルパー（ADR 0002）。#33 で作る。この段階ではサーバーとはつながない。

前提: macOS 26 以降。ビルドの前に、WebRTC AEC3 のライブラリを `scripts/build-webrtc-apm.sh` で用意する（下の「エコーキャンセル」）。初回は ja-JP の音声認識モデルを `AssetInventory` で取得する。システム音声の取得とマイクの使用は、起動したターミナルの権限で動く。初回の `run` でマイクの許可を求められる。

## 構成

- `Sources/CWebRTCAPM`: WebRTC AEC3 の C++ を閉じ込めた SwiftPM のシム。公開ヘッダーは C の関数だけ
- `scripts/build-webrtc-apm.sh`: AEC3 の静的ライブラリをビルドして `.deps/webrtc-apm/`（gitignore 済み）に置く
- `Sources/HelperCore`: イベントの形、会議アプリの選択、Core Audio のプロセスタップ、マイク（AVAudioEngine）、SpeechAnalyzer、WebSocket
- `Sources/live-mindmap-helper`: 引数の解釈と配線だけ。STT は `Transcriber` プロトコルの後ろにある
- `Sources/stt-bench`: 音声認識の確定の遅れを測る開発者向けの道具（Issue #97）。製品の `live-mindmap-helper` には含まれない
- `Tests/HelperCoreTests`: 純粋なロジックと WebSocket のローカル接続のテスト
- `Tests/SttBenchTests`: `stt-bench` の合成の時刻計算（`say` や音声認識は使わない）

## 使い方

```sh
cd helper
swift run live-mindmap-helper list                         # 音を出している会議アプリを JSON で出す
swift run live-mindmap-helper run --app <bundle id> [--port <n>] [--audio-dir <dir>]   # 既定のポートは 8765
```

`run` は、選んだアプリ（本体と helper のプロセス）だけをタップする。Zoom は `us.zoom.xos`、ブラウザはブラウザ全体になる（Meet のタブだけには絞れない）。合うプロセスがなければ、Mac 全体のタップには切り替えず、エラーで終わる。音声の処理が取得に追いつかず、未消費のバッファが上限（2048 個）を超えたときも、音声を捨てずにエラーで終わる。
同時にマイクも取り、`自分` のトラックとして、`相手` とは別の SpeechAnalyzer で文字起こしする（2 本が並行して動く）。Apple の音声処理（Voice Processing のエコーキャンセル）は有効にしない（有効にするとプロセスタップが止まる）。スピーカーのときは、下の「エコーキャンセル」で漏れを消す。マイクのデバイスが切り替わっても取得は再開しない。マイクが許可されていないときは、エラーで終わる。Ctrl-C（SIGINT / SIGTERM）で、タップ・マイク・WebSocket を片付けて終わる。

`--audio-dir <dir>` を付けると、トラックごとの録音を、既存のフォルダ `<dir>` の `相手.m4a`・`自分.m4a`（AAC・48 kHz・モノラル）に書く。録音の 0 秒は、発言の `start` / `end` の 0 秒（音声取得を始める直前）と同じ。書き込みに失敗したときは、そのトラックをエラーで終わらせる。終了時は、タップとマイクを止めて録音ファイルを閉じてからプロセスが終わる（呼び出し側は、プロセスの終了で書き終わりを知る）。付けなければ録音しない。

## イベントの形

`ws://127.0.0.1:<port>` に、テキストフレームで JSON を流す。`start` / `end` は、`run` が音声取得を始める直前を 0 とする、2 トラック共通の秒数。`id` はサーバーが採番するので、ここでは付けない。`自分` のトラックも `相手` と同じ形で流れる。

```json
{"type":"partial","track":"相手","start":1.5,"end":2,"text":"こんに","duplicate":false}
{"type":"remark","track":"相手","start":1.5,"end":3.25,"text":"こんにちは","duplicate":false}
{"type":"partial","track":"自分","start":4,"end":4.5,"text":"はい","duplicate":false}
```

- `partial`: 途中結果（トラック・開始・終了・本文・重複の印）。同じトラックで `start` が同じ途中結果の列は、同じ発話の更新（本文が変わっても同じ発話）。サーバーは、1 秒更新されない発話を最後の本文・区間で発言にする（`自分` の途中結果は発言にしない）。`duplicate` は、出力先がスピーカーのとき、`自分` の途中結果のうち、前後 8 秒の `相手` の確定結果と `相手` の最新の途中結果をつないだ文字列との文字 3-gram の被覆率が 0.6 以上のものが true（正規化後に 3 文字未満は false、`相手` の途中結果は常に false）。印の付いた途中結果も捨てずに流し、サーバーは字幕に出さない
- `remark`: 確定結果（トラック・開始・終了・本文・重複の印）。`duplicate` は、出力先がスピーカーのとき、`自分` の発言のうち前後 8 秒の `相手` の発言と文字 3-gram の被覆率が 0.6 以上のものが true（`相手` の発言は常に false）。印の付いた発言も捨てずに流す。サーバーは印の付いた発言を差分更新に使わず、ログには残す

### エコーキャンセル（スピーカーのとき）

- 出力先がスピーカー（`marksDuplicates` が true。判定は `run` の開始時に 1 回）のときだけ、マイクの音を STT に渡す前に、WebRTC AEC3 でスピーカーから漏れた相手の声を消す。内蔵のヘッドフォンジャックのイヤホンのときは素通し。Bluetooth はスピーカーのこともあるのでかける（AirPods など漏れないものでは、ほぼ素通しになる）
- 参照信号はタップの音（スピーカーに出る音そのもの）。タップの流れは `相手` の STT と AEC の参照に分けて配る。起動時に stderr へ `echo cancellation: enabled ...` が出る
- 参照とマイクは `hostTime` で揃える。マイクの 10 ms を処理する前に、その時刻までの参照の 10 ms をすべて AEC に渡し、足りないときは無音で埋める。参照が届くのを待つ間はマイクの処理を保留する（500 ms を超えたら無音で埋めて進める）。ファイルの先頭どうしで揃えると、ほとんど消えない
- 両方を 48 kHz・モノラルに変換して 480 サンプルずつ渡す。出力の `hostTime` は元のマイクのまま
- **`--audio-dir` の録音は、AEC の後の音**（STT が聞いた音と同じ）。スピーカーのとき `自分.m4a` には漏れが消えた音が入り、消す前の音は残らない
- 設定は、エコーキャンセルと高域通過フィルターだけを有効にする（ゲイン制御とノイズ抑制は無効）
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
