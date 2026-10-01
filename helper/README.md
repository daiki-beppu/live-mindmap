# helper

会議の音声を文字起こしして発言をサーバーへ流す Swift のヘルパー（ADR 0002）。#33 で作る。この段階ではサーバーとはつながない。

前提: macOS 26 以降。初回は ja-JP の音声認識モデルを `AssetInventory` で取得する。システム音声の取得は、起動したターミナルの権限で動く。

## 構成

- `Sources/HelperCore`: イベントの形、会議アプリの選択、Core Audio のプロセスタップ、SpeechAnalyzer、WebSocket
- `Sources/live-mindmap-helper`: 引数の解釈と配線だけ。STT は `Transcriber` プロトコルの後ろにある
- `Tests/HelperCoreTests`: 純粋なロジックと WebSocket のローカル接続のテスト

## 使い方

```sh
cd helper
swift run live-mindmap-helper list                         # 音を出している会議アプリを JSON で出す
swift run live-mindmap-helper run --app <bundle id> [--port <n>]   # 既定のポートは 8765
```

`run` は、選んだアプリ（本体と helper のプロセス）だけをタップする。Zoom は `us.zoom.xos`、ブラウザはブラウザ全体になる（Meet のタブだけには絞れない）。合うプロセスがなければ、Mac 全体のタップには切り替えず、エラーで終わる。音声の処理が取得に追いつかず、未消費のバッファが上限（2048 個）を超えたときも、音声を捨てずにエラーで終わる。Ctrl-C（SIGINT / SIGTERM）で、タップと WebSocket を片付けて終わる。

## イベントの形

`ws://127.0.0.1:<port>` に、テキストフレームで JSON を流す。`start` / `end` はキャプチャ開始からの秒数。`id` はサーバーが採番するので、ここでは付けない。`自分` のトラックも同じ形で流せる。

```json
{"type":"partial","track":"相手","text":"こんに"}
{"type":"remark","track":"相手","start":1.5,"end":3.25,"text":"こんにちは","duplicate":false}
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
5. `相手` の `partial`（途中結果）と `remark`（発言）が届くことを確かめる
