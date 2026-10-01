# helper

会議の音声を文字起こしして発言をサーバーへ流す Swift のヘルパー（ADR 0002）。#33 で作る。この段階ではサーバーとはつながない。

前提: macOS 26 以降。初回は ja-JP の音声認識モデルを `AssetInventory` で取得する。システム音声の取得とマイクの使用は、起動したターミナルの権限で動く。初回の `run` でマイクの許可を求められる。

## 構成

- `Sources/HelperCore`: イベントの形、会議アプリの選択、Core Audio のプロセスタップ、マイク（AVAudioEngine）、SpeechAnalyzer、WebSocket
- `Sources/live-mindmap-helper`: 引数の解釈と配線だけ。STT は `Transcriber` プロトコルの後ろにある
- `Tests/HelperCoreTests`: 純粋なロジックと WebSocket のローカル接続のテスト

## 使い方

```sh
cd helper
swift run live-mindmap-helper list                         # 音を出している会議アプリを JSON で出す
swift run live-mindmap-helper run --app <bundle id> [--port <n>]   # 既定のポートは 8765
```

`run` は、選んだアプリ（本体と helper のプロセス）だけをタップする。Zoom は `us.zoom.xos`、ブラウザはブラウザ全体になる（Meet のタブだけには絞れない）。合うプロセスがなければ、Mac 全体のタップには切り替えず、エラーで終わる。音声の処理が取得に追いつかず、未消費のバッファが上限（2048 個）を超えたときも、音声を捨てずにエラーで終わる。
同時にマイクも取り、`自分` のトラックとして、`相手` とは別の SpeechAnalyzer で文字起こしする（2 本が並行して動く）。Apple の音声処理（エコーキャンセル）は有効にしない（有効にするとプロセスタップが止まる）。マイクのデバイスが切り替わっても取得は再開しない。マイクが許可されていないときは、エラーで終わる。Ctrl-C（SIGINT / SIGTERM）で、タップ・マイク・WebSocket を片付けて終わる。

## イベントの形

`ws://127.0.0.1:<port>` に、テキストフレームで JSON を流す。`start` / `end` は、`run` が音声取得を始める直前を 0 とする、2 トラック共通の秒数。`id` はサーバーが採番するので、ここでは付けない。`自分` のトラックも `相手` と同じ形で流れる。

```json
{"type":"partial","track":"相手","text":"こんに"}
{"type":"remark","track":"相手","start":1.5,"end":3.25,"text":"こんにちは","duplicate":false}
{"type":"partial","track":"自分","text":"はい"}
```

- `partial`: 途中結果（トラック・本文）
- `remark`: 確定結果（トラック・開始・終了・本文・重複の印）。重複の判定はヘルパーでは行わないので、`duplicate` は常に false

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

### 60 分の連続動作と CPU 負荷

1. 上の手順で `run` を起動し、WebSocket のクライアントをつないだままにする
2. 別のターミナルで CPU を 1 分ごとに記録する: `top -pid $(pgrep -f live-mindmap-helper | head -1) -l 0 -s 60 -stats pid,cpu,mem | tee helper-cpu.log`
3. 60 分の間、会議の音とマイクの音を流し続ける。2 本の SpeechAnalyzer が止まらず、両方のトラックの発言が届き続けることを確かめる
4. 終わったら、`helper-cpu.log` から CPU の平均と最大を、この issue（#34）に記録する
