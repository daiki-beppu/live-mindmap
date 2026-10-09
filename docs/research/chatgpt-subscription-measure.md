# ChatGPT のサブスクで差分更新を回せるかを測る（issue #635 の計測）

2026-10-09 に計測。発言の本文は載せず、数字だけを書く。

## 条件

- アカウント: ChatGPT Plus（$20）。Sign in with ChatGPT のプラン利用で、`live-mindmap` として動的に登録した
- 試作: `server/bench/chatgpt.ts`（OAuth・トークン更新・Responses API を SSE で読む）と、`server/src/prototypeLocalUpdater.ts` の `LOCAL_LLM_ROUTE=chatgpt`。#487 の v5（毎回 1 から呼び、文ごとに分類し、id を列挙型に縛る）を、そのまま `instructions` と `text.format` に載せた
- トークンは `~/.live-mindmap-proto/chatgpt/`（0600）。リポジトリには置かない
- 素材: 上限を使いすぎないよう、`synth/screen` の 16:00〜19:20（11 発言、決定 3・TODO 3）だけを切り出した（`~/live-mindmap-samples/synth/screen-cut/`）。`play` は待ち時間なし → `eval --truth`
- モデル: `gpt-6-luna`（上限の消費が最も軽い）

## 結果

| | ChatGPT Luna v5 |
| --- | --- |
| 構造化出力（列挙型・anyOf・minItems/maxItems を含む） | 6/6 回通った。失敗 0 |
| 決定 / TODO の再現 | 3/3・3/3 |
| 作った決定 / TODO（正解 3 / 3） | 4 / 6 |
| 1 回の時間 | 中央 8.2 秒・最大 11.2 秒。最初のバイトまで 1.4〜2.0 秒 |
| トークン（1 回） | 入力 1.1〜1.5k、出力 240〜510（うち推論 0〜317） |
| 上限の消費 | ping を含む 7 回で、Plus の 5 時間の枠の 1% 未満（利用者が設定の「使用量」で確認） |

- 選べるモデル（`GET /v1/models`、`visibility: list`）: `gpt-6.1-sol`・`gpt-6-astra`・`gpt-6-sol`・`gpt-6-luna`・`gpt-5.6-sol`・`gpt-5.6-terra`・`gpt-5.6-luna`
- 応答ヘッダーに上限の残りは出ない（`x-codex-turn-state`・`x-oai-request-id` など）。アプリから消費を知る手段は無く、429 の `subscription_sharing_usage_limit_exceeded` で知るしかない
- 推論の量は送れる項目で決められず（`temperature`・`max_output_tokens` は使えない）、回によって 0〜317 トークン推論した

## 見積もり

- 待ち時間なしで 3.3 分の会議に 6 回、およそ 33 秒に 1 回。2 時間の会議ならおよそ 200 回になる
- 7 回で 1% 未満なので、1 回あたり 0.14% 未満。200 回でも 5 時間の枠の 3 割未満に収まる見込み（上の値は上限で、実際はもっと少ない）。Plus の 5 時間の枠は Codex など他のアプリと共有する

## 確かめていないこと

- 会議 1 本を通しての品質と、Claude・Apple Intelligence との同じ区間での比較（上限と費用を抑えるため流していない）
- `play --realtime` での遅れ
- Sol など重いモデルの消費
