# PROTOTYPE: リアルタイム音声取得と STT の経路（ローカル完結）

使い捨て。issue [#9](https://github.com/daiki-beppu/live-mindmap/issues/9) の問いに答えるための計測器。main には入れない。

## 何が入っているか

| ファイル | 役割 |
| --- | --- |
| `analyzer-bench.swift` | 音声ファイルを実時間のペースで SpeechAnalyzer（ja-JP・端末内）に流し、途中結果・確定結果の到着時刻を JSON Lines で出す |
| `live-capture.swift` | 相手の声 = Core Audio のプロセスタップ（`--app <bundle id>` でアプリを指定）、自分の声 = マイク を別トラックで取って SpeechAnalyzer に流す。`--aec` でマイクに Apple の音声処理（エコーキャンセル）をかける。`--list` で音を出しうるプロセスを一覧 |
| `analysis/stats.jq` | 確定結果の長さ・遅延の分布 |
| `analysis/sentcut.py` | 途中結果を「。」で切ったとき、確定結果と一致するか・どれだけ早いか |
| `analysis/agree.py` | ストリーミングの結果と Kanary の全文ファイルの一致度 |
| `analysis/dedupe.py` | マイクの確定結果が、前後 8 秒の相手トラックの本文にどれだけ含まれるか（二重文字起こしの判定） |

```sh
swiftc -O -swift-version 5 analyzer-bench.swift -o /tmp/analyzer-bench   # Xcode 不要（Command Line Tools で可）
/tmp/analyzer-bench ~/live-mindmap-samples/facilitators-meeting.m4a --volatile > fac.jsonl
jq -s -c -f analysis/stats.jq fac.jsonl

swiftc -O -swift-version 5 live-capture.swift -o /tmp/live-capture
/tmp/live-capture --list
/tmp/live-capture --app us.zoom.xos > live.jsonl     # Ctrl-C で止める
```

## 結果（2026-09-30、macOS 27.0、Apple Silicon）

### STT: SpeechAnalyzer を直接使う

60 分のサンプル 2 本を実時間で流した結果（2 本を同時に流しているので、遅延はやや多めに出ている可能性がある）。

| | ファシリテーター会議 | ブレスト |
| --- | --- | --- |
| 確定結果の数 | 251 | 321 |
| 確定結果 1 つの長さ p50 / p95 / 最大 | 13.4 / 22.0 / 34.4 秒 | 8.6 / 16.9 / 23.6 秒 |
| 音声の終わり → 確定が届く p50 / p95 | 6.1 / 11.4 秒 | 6.5 / 11.2 秒 |
| 話し始め → 確定が届く p50 / p95 | 19.2 / 29.7 秒 | 15.2 / 24.4 秒 |
| 途中結果の遅れ p50 / p95 | 0.07 / 0.11 秒 | 0.07 / 0.11 秒 |
| Kanary の全文ファイルとの文字一致率（5 分窓の平均） | 98.9% | 98.9% |

- Kanary（`kanary transcribe`）は内部で同じ SpeechAnalyzer を使っていて、精度はほぼ同じ。10 秒チャンクの処理は約 0.2 秒（アプリ起動済み）だが、チャンクの境界で語が抜ける（「結局どちら。」+「安定的に…」の間の「の方が」が消える）
- 途中結果を「。」で切っても、確定結果と一致するのは 74%（不一致の多くは句読点・1 字の違い）で、確定より早く出せる時間も p50 0.2 秒〜11 秒とばらつく

### 音声取得: 会議アプリを指定したプロセスタップ + マイク

- Mac 全体のタップは、会議と関係ない音（別の動画など）も拾う。アプリを指定したタップ（Zoom なら `us.zoom.xos`）なら、その会議アプリの音だけになる。ブラウザの Meet はブラウザ全体（`com.google.Chrome` とヘルパー）の音になる
- 許可ダイアログはマイクだけで出た。システム音声のタップは、起動したターミナル（Orca）の権限で動いた
- 出力先は `kAudioDevicePropertyTransportType` と `DataSource` で判定できる（内蔵スピーカー = `bltn` + `ispk`）

### スピーカーで聞くときの二重文字起こし

| 条件 | 相手のトラック | 自分のトラック |
| --- | --- | --- |
| エコーキャンセルなし | 届く | 相手の音声がほぼそのまま二重に文字になる |
| エコーキャンセルあり（同じプロセス） | **タップが止まる**（マイクを先に開始しても、ダッキングを最小にしても同じ） | 漏れは「あ」1 語だけ |
| エコーキャンセルあり（別プロセス） | 届くが、会議アプリの音量が約 1/3 に下がる（利用者の耳にも小さく聞こえる） | 漏れは「あ」1 語だけ |

エコーキャンセルなしで漏れたマイクの確定結果は、前後 8 秒の相手トラックの文字 3-gram の 68〜100% を含んでいた（12 件）。確定結果の区切りはトラック間でずれるので、確定結果どうしの突き合わせではなく、時間窓の中の文字列で判定する必要がある。自分の声（相手トラックに入らない）の被覆率と、自分と相手が同時に話したときの扱いは、まだ確かめていない。
