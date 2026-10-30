# 補足を差分更新に同乗させるか、別に呼ぶか: 遅れと費用の見積もり

地図 [#1733](https://github.com/daiki-beppu/live-mindmap/issues/1733) のチケット [#1737](https://github.com/daiki-beppu/live-mindmap/issues/1737) の調査。補足（用語の説明、決定の理由、経緯のまとめなどを先回りでマップに添えるもの。仮の呼び名）を作る手段として、次の 2 つを、今のコードと保存済みの計測ログから見積もる。

- **(a) 同乗**: 今の差分更新の呼び出しに出力を足す
- **(b) 別呼び出し**: 差分更新とは別の呼び出しを立てる

有料のモデル呼び出しや長い計測は流していない。数値は、コード、ADR、issue、開発ログと、手元に保存済みのセッションログ（`log.jsonl` の `diff` の行の `usage`・`call`・`input`・`ops` の数だけ。発言の本文は読み出していない）から出した。

## 結論

**(b) 別呼び出しを勧める。ただし差分更新ごとではなく、出来事（議題・決定・論点の追加など）を引き金にした低い頻度で、差分更新の段取り（`inFlight`）の外で呼ぶ。** ローカルモード・Apple Intelligence では、最初は出さない。

根拠は次の 4 つ。

1. **差分更新は、すでに時間の大半を呼び出しに使っている。** 呼び出しは途切れずに続き、合成会議では会議時間の 84〜89%、実会議（100 分）では 54% が呼び出し中だった。(a) で 1 回の出力を足すと、その分だけ全部の呼び出しが延び、マップの遅れ（この製品の核）に直接効く。
2. **出力 1 トークンあたりの遅れは約 7〜9 ms。** 100 トークン足すと 1 回 +0.7〜0.9 秒で、実会議の p50 2.3 秒に対して +30〜40%。補足が付きやすいのは決定・議題を足す回なので、遅れがいちばん大事な回に乗る。
3. **(a) は出力の形を 2 系統とも変えることになる。** Claude は差分操作の JSON、ChatGPT・ローカル・Apple Intelligence は文ごとの分類の JSON で、出力の形が別。Apple Intelligence は出力が止まらなくなる癖があり、上限 600 トークンで切っている。自由文の欄を足すと、上限に当たる危険と生成時間が増える。
4. **(b) は、段取りの外で呼ぶ前例がもうあり、TLA+ のモデルにも触れない。** 読みの問い合わせ（`katakana`）は差分更新と並んで動く別の呼び出しだ。出来事を引き金にすると、頻度は差分更新の 1/10〜1/20 になる。Sonnet 5.5 でも 1 時間あたり $1 前後、Haiku 5.5 ならさらに 1 桁下に収まる見込み。

(b) を差分更新と同じ頻度で呼ぶと、入力（マップ・直前の発言）をもう一度送ることになり、費用がほぼ 2 倍になる。(b) を選ぶなら、引き金と頻度の上限は必須。

## 1. 差分更新の段取り（`server/src/core/session.ts`）

- **同時に 1 つまで**: `startDiffIfReady` は、`inFlight` が空で、`pending` に発言があり、一時停止・停止でないときだけ呼び出しを始める（`server/src/core/session.ts:362-378`）。呼び出しが終わると `runCall` の `onExit` が `inFlight` を空にし、すぐ次を試す（`:391-406`）。発言が届くたびにも試す（`push`、`:523-533`）。待ち時間（debounce）は置いていない。
- **1 回に渡す発言**: 呼び出しの間に溜まった `pending` を全部渡す。上限は無い（`takeFresh`、`:311-314`）。一時停止からの追いつきの間だけ、`PACED_CALL_REMARKS = 2` 件ずつ渡す（`:286`）。文脈として直前の処理済みの発言を `RECENT = 3` 件添える（`:115`）。遅いモデルでは 1 回に渡る発言が増えるだけで、呼び出しは積み上がらない。この形は [#398](https://github.com/daiki-beppu/live-mindmap/issues/398) で「間隔は変えない」と決めた。
- **再試行**: 一時停止（利用上限）の後は `DIFF_UPDATE_RETRY_MS = 5 分` ごと、または上限が戻る時刻に試し直す（`server/src/core/diffUpdate.ts:30`、`session.ts:380-388`）。
- **形式の検証**: 段取りは `server/formal/DiffUpdateScheduler.tla` が「同時に 2 つ呼ばない」などの 6 つの性質で検証している。`Ref` の操作の回数・順序・条件を変えたら、TLC を回し直す（`verify-diff-update-scheduler` スキル、[docs/knowledge/reflection.md:21-27](../knowledge/reflection.md)）。
- **段取りの外の呼び出し（前例）**: 読みの問い合わせ `katakana` は、`DiffUpdater` の同じサービスにあるが、`inFlight` を通らない。語彙の補正（`server/src/sessionVocabulary.ts:28`）から呼ばれ、差分更新と並んで動く。Claude では、差分更新とは別の query を毎回開く（`server/src/claude.ts:206-218`）。失敗すると空の答えで済ませる（`Effect.catch(() => Effect.succeed([]))`）。
- **段取りの中の別呼び出し（前例）**: 判定の振り分け（`routedDiffUpdater.ts`）は、Jev の判定を差分更新の呼び出しの中で先に直列で呼ぶ（`server/src/routedDiffUpdater.ts:33-63`）。判定は p50 0.18 秒、時間切れ 1 秒なので直列でも済む（[ADR 0020](../adr/0020-judge-behind-swappable-port-optional.md)）。生成を伴う補足は秒単位かかるので、この形（直列）は合わない。

**兼ね合い**: (a) は段取りを変えない。`DiffOperations` の形と反映（`reflectDiff`、[ADR 0024](../adr/0024-reflect-diff-row-in-one-pure-fold.md)）に補足を通すことになる。(b) を `katakana` と同じく段取りの外に置けば、TLA+ のモデルは変わらない。(b) を `inFlight` に入れて差分更新と交互に呼ぶ形にすると、その分マップの遅れが延び、モデルの直しと TLC の回し直しが要る。

## 2. 1 回あたりの量と頻度（保存済みのログから）

対象は、Sonnet 5.5 単独（判定なし）のログ。

- 実会議: `~/.live-mindmap/sessions/2026-10-26T13-05-05.113Z`（100 分、ライブ）
- 合成会議 screen（23 分）を等速で流したもの: [#1395](https://github.com/daiki-beppu/live-mindmap/issues/1395) の `diff-latency-1395/head`、[#997](https://github.com/daiki-beppu/live-mindmap/issues/997) の `split-997/session.1`

| | 実会議 100 分 | screen 等速（#1395 head） | screen 等速（split-997 #1） |
|---|---|---|---|
| 呼び出し | 1101 回（11.0 回/分） | 375 回（16.4 回/分） | 321 回（14.1 回/分） |
| 呼び出し中の時間の割合 | 54% | 84% | 89% |
| 前の呼び出しの終わりから次の始まり p50 | 1.1 秒 | 0.0 秒 | 0.0 秒 |
| 1 回の新しい発言 p50 / 最大 | 1 / 29 | 1 / 6 | 1 / 10 |
| 1 回の時間 p50 / p90 | 2.3 / 4.8 秒 | 2.8 / 4.8 秒 | 3.0 / 6.3 秒 |
| 入力（キャッシュ込み）p50 / p90 | 41.5k / 82.0k | 20.0k / 27.1k | 20.4k / 26.9k |
| 出力 p50 / p90（思考を含む） | 124 / 286 | 144 / 268 | 159 / 315 |
| 中身の無い回（ops が noop だけ） | 422 回（38%） | 124 回（33%） | — |

- 入力のほとんどはキャッシュの読み出しだ。実会議の合計は、キャッシュなしの入力 2.2k、書き込み 4.79M、読み出し 47.2M、出力 172k。Claude は 1 つの query を 14 回使い回し（`server/src/claude.ts:27`、[#87](https://github.com/daiki-beppu/live-mindmap/issues/87)）、2 回目からはマップの変更だけを送る（[ADR 0006](../adr/0006-send-map-changes-within-a-query.md)）。キャッシュは 5 分の TTL（`claude.ts:102`）。
- 出力トークンは、result の `usage` から取っている。思考（`effort: "medium"`、`claude.ts:38-41,97`）を含む。#679 より前のログ（#878 の「約 18 / 回」）は数え方が違い、比べられない（[#1395 の結論](https://github.com/daiki-beppu/live-mindmap/issues/1395)）。
- `human-checks-915` のログ（10/13）は `usage` の数え方が古く、追いつきで 2 件ずつ流しているので、上の表から外した。

### 出力の量と 1 回の時間

1 回の時間を出力トークンに回帰すると、次のとおり。

| ログ | 切片 | 出力 1 トークンあたり | 出力 0〜99 / 100〜199 / 200〜299 / 300〜399 の p50 |
|---|---|---|---|
| 実会議 | 1.5 秒 | 9.4 ms | 1.7 / 2.1 / 3.1 / 4.0 秒 |
| #1395 head | 1.9 秒 | 7.2 ms | 2.0 / 2.5 / 3.3 / 4.0 秒 |
| split-997 #1 | 2.4 秒 | 7.7 ms | 2.0 / 2.7 / 3.6 / 3.7 秒 |

#1395 でも、傾きは出力 1k トークンあたり 7.7〜9.5 秒と出ている。ただし相関は 0.25〜0.46 で、尾（p90）の多くは出力の量では説明できない（時間帯による API の揺れ。[#1395](https://github.com/daiki-beppu/live-mindmap/issues/1395)）。

### 補足の引き金になりうる出来事の頻度

1 時間あたりの `add` の数（種別ごと）を数えた。

| | 議題 | 論点 | 決定 | TODO | 要点 |
|---|---|---|---|---|---|
| 実会議 100 分 | 25.7 | 1.2 | 0 | 1.8 | 347.9 |
| screen 等速（head） | 55.2 | 44.7 | 28.9 | 31.5 | 360.0 |

議題・論点・決定のどれかを足した時だけ補足を考えるとすると、1 時間に約 30〜130 回、多くて 1 分に 2 回ほどになる。差分更新（1 時間に 660〜980 回）の 1/7〜1/30。要点ごとに考えると、差分更新の半分ほどの頻度になり、引き金としては多すぎる。

## 3. 費用の見積もり（Claude、API キー）

Claude の差分更新は、利用者の Anthropic API キーで請求される（[README.ja.md の「Claude の認証」](../../README.ja.md#claude-の認証)）。単価は Sonnet 5.5 が入力 $2・出力 $10 / 1M トークン、キャッシュの読み出しが $0.20（入力の 0.1 倍）、5 分のキャッシュの書き込みが入力の約 1.25 倍（$2.50）。Haiku 5.5 は入力 $0.10・出力 $0.50（10 万トークン以下のプロンプト）。単価は Claude API のスキルが持つ価格表（2026-10-06 時点）から取った。

**今の差分更新（1 時間あたりに直した値）**

| | 書き込み | 読み出し | 出力 | 計 |
|---|---|---|---|---|
| 実会議 100 分 | 2.87M → $7.18 | 28.2M → $5.65 | 103k → $1.03 | **約 $13.9 / 時** |
| screen 等速（head） | 1.30M → $3.25 | 19.0M → $3.80 | 162k → $1.62 | **約 $8.7 / 時** |

出力が費用に占める割合は 7〜19%。大半は入力（キャッシュの書き込みと読み出し）だ。

**(a) 同乗の上乗せ**

- 全部の回で 100 トークン足すと、実会議では出力が +66k / 時（+$0.66）。足した出力は同じ query の後の回の入力にもなり、キャッシュの書き込み・読み出しで +$0.2 前後。合わせて **約 +$0.9 / 時（+6〜7%）**。
- 補足を議題・決定の回にだけ付けるなら、上乗せは 1 桁小さい。ただし遅れは、まさにその回に乗る。
- 補足を書かせる指示で、思考トークンがどれだけ増えるかは測っていない。思考は出力に数えられるので、上の見積もりは下限。

**(b) 別呼び出しの費用**

- **差分更新ごとに Sonnet で呼ぶ**: 同じ大きさの文脈をもう一度送るので、**ほぼ 2 倍（+$9〜14 / 時）**。採れない。
- **出来事ごとに Sonnet で、query を開いたまま使い回す（ADR 0006 と同じ形）**: 1 回あたり、読み出し 20〜40k × $0.20/1M と出力 300 × $10/1M で、約 $0.007〜0.011。1 時間に 30〜130 回で **約 $0.2〜1.4 / 時**。ただし、5 分を超えて間が空くとキャッシュが切れ、書き直し（40k × $2.50/1M = $0.10）が乗る。
- **出来事ごとに毎回開き直す（`katakana` と同じ形）**: 1 回 $0.05〜0.10 で、**$1.5〜13 / 時**。Sonnet でこの形は高い。
- **Haiku 5.5 で呼ぶ**: 単価が Sonnet の 1/20 なので、毎回開き直しても **$0.1〜0.7 / 時**。外の知識（用語・製品の説明）を Haiku に任せてよいかは、質の問いとして残る。

## 4. 差分更新のモデルごとの制約

| モデル | 今の差分更新の形 | 1 回の遅れ（記録） | (a) の制約 | (b) の制約 |
|---|---|---|---|---|
| **Claude**（Sonnet 5.5、または Jev の振り分けで Sonnet / Haiku） | query を 14 回使い回し、マップの変更だけ送る。出力は差分操作の JSON | p50 2.3〜3.0 秒、p90 4.8〜6.3 秒（上の表） | 振り分けでは、Sonnet と Haiku の両方のプロンプト・スキーマに足す（`routedDiffUpdater.ts:33-63`）。足した出力は後の回の入力にもなる | API キーの課金。並べて呼んだときのレート制限は測っていない。`katakana` が別 query の前例 |
| **ChatGPT サブスク**（例 `gpt-6-luna`） | 判定基準が無い普段の回は、文ごとの分類（`localUpdaterLayer`）を 3 文ずつ、毎回 1 から呼ぶ（`server/src/diffUpdater.ts:53`、`localDiffUpdater.ts:5,80-100`） | p50 8.2 秒、最大 11.2 秒。入力 1.1〜1.5k、出力 240〜510（[ADR 0019](../adr/0019-chatgpt-subscription-direct-responses-api.md)、[#635](https://github.com/daiki-beppu/live-mindmap/issues/635)） | 分類のスキーマ（`localPrompt.ts`）に自由文の欄を足すことになる。`max_output_tokens` はこのプラン利用では使えない（ADR 0019） | Plus の 5 時間枠と週の枠は、プランを使う全アプリと共有する。上限（429）で差分更新ごと一時停止する（`chatgptResponses.ts`）。呼び出しの数がそのまま枠を減らす |
| **ローカル LLM**（OpenAI 互換。ローカルモードでは Apple Intelligence だけ） | 分類と同じ形。`max_tokens` は既定 600（`openaiCompatible.ts:31`） | Qwen3.5-4B で p50 21 秒、p90 36 秒（[#487](https://github.com/daiki-beppu/live-mindmap/issues/487)）。内蔵は見送り（[ADR 0012](../adr/0012-local-inference-in-child-process.md)） | 遅さの大半は要約を書く生成（ADR 0012）。出力を足すと、そのまま遅れが延びる | 同じ実行環境に並べて呼ぶと、メモリと計算を取り合う。#487 では 16GB の M4 で遅れが溢れた |
| **Apple Intelligence** | 分類と同じ形。毎回 1 から呼ぶ。文脈長 8192（`helper/Sources/AppleIntelligenceCore/AppleGeneration.swift:51`）、出力上限 600 | p50 6.6 秒、p90 15 秒。入力は最大 2.8k（#487 の v5）。等速では p50 14 秒・p90 22 秒の見込みもある（#398） | 最後の文の `text` で崩れると上限まで出し続けるので、文を最後に生成させ、その後ろに必須の項目を置かない（`localPrompt.ts:75`、#795）。自由文の欄を足すと、この危険が増える。判断の質は「試験的」（ADR 0012） | ローカルモードはクラウドに出さない（[ADR 0014](../adr/0014-local-mode-only-own-child-processes.md)）ので、補足も Apple Intelligence で作るしかない。子プロセスは 1 つ。HTTP サーバーは接続ごとに `Task` を立てる actor（`AppleHTTPServer.swift:4,21`）。並べたときの遅れは測っていない。小さなモデルに外の知識を出させてよいかは、地図の未決事項 |

## 5. (a) と (b) の比べ

| 観点 | (a) 同乗 | (b) 別呼び出し（出来事ごと、段取りの外） |
|---|---|---|
| マップの遅れ | 全部の回、または補足を付ける回が +0.7〜0.9 秒 / 100 トークン。呼び出しが途切れずに続く会議では、溜まる発言が増える | 差分更新には乗らない（並べて呼ぶ）。補足は、きっかけの反映から 1 呼び出しぶん（Sonnet で数秒）遅れて出る |
| 費用（Claude） | +6〜7%（約 +$0.9 / 時）。思考の増加分は未測 | Sonnet で使い回すと $0.2〜1.4 / 時、Haiku なら $0.1〜0.7 / 時。差分更新ごとに呼ぶと約 2 倍 |
| 文脈 | 差分更新の文脈をそのまま使える（新たな入力は無い） | マップと直前の発言を別に渡す。量を抑えるなら、ADR 0006 の形で query を使い回す |
| コードの触る範囲 | Claude の差分操作のスキーマ、分類のスキーマ、`reflectDiff`、ログの `diff` の行、復元・計測 | 新しい口（`katakana` と同じく `DiffUpdater` の隣）、引き金、補足の記録。段取り・反映には触れない |
| 形式の検証 | 段取りは変わらない。反映の規則が増える | 段取りの外なので TLA+ のモデルは変わらない |
| 失敗の扱い | 補足の形が崩れると、差分更新の回ごと失敗になる（`DiffOutputInvalid`） | 補足だけを諦めればよい（`katakana` の前例）。差分更新に波及しない |
| モデルごとの差 | 2 系統の出力の形を両方変える。Apple の暴走の危険 | モデルごとに出す・出さない、使うモデル（例 Claude なら Haiku）を選べる。ローカルモードでは出さない、も選べる |
| 利用上限（ChatGPT・Claude の枠） | 呼び出しの数は増えない | 呼び出しの数が増える（出来事ごとなら差分更新の 1/7〜1/30） |

## 6. 確かめていないこと

- 補足 1 件の出力の大きさ（100〜300 トークンを仮定）と、補足を書かせたときの思考トークンの増え方。
- (b) を並べて呼んだときの、Claude API のレート制限、ChatGPT の枠の減り方、Apple Intelligence の子プロセスでの遅れ。
- 実会議のログは 1 本だけ。合成会議は 23 分で、決定が多い。どちらも Sonnet 5.5 単独で、Jev の振り分けを通したログは手元に無い。
- 金額は 2026-10-06 時点の単価に、保存済みのトークン数を掛けたもの。時間帯による遅れの揺れは大きい（#1395）。

## 出典

- コード: `server/src/core/session.ts`（`:115`、`:286`、`:311-314`、`:362-406`、`:523-533`）、`server/src/core/diffUpdate.ts:30`、`server/src/claude.ts`（`:27`、`:38-41`、`:97-102`、`:206-218`）、`server/src/routedDiffUpdater.ts:33-63`、`server/src/diffUpdater.ts:53`、`server/src/localDiffUpdater.ts:5,80-100`、`server/src/localPrompt.ts:75`、`server/src/openaiCompatible.ts:31`、`server/src/chatgptResponses.ts`、`server/src/sessionVocabulary.ts:28`、`helper/Sources/AppleIntelligenceCore/AppleGeneration.swift:51`、`helper/Sources/AppleIntelligenceCore/AppleHTTPServer.swift:4,21`、`server/formal/DiffUpdateScheduler.tla`
- ADR: [0006](../adr/0006-send-map-changes-within-a-query.md)、[0012](../adr/0012-local-inference-in-child-process.md)、[0014](../adr/0014-local-mode-only-own-child-processes.md)、[0019](../adr/0019-chatgpt-subscription-direct-responses-api.md)、[0020](../adr/0020-judge-behind-swappable-port-optional.md)、[0024](../adr/0024-reflect-diff-row-in-one-pure-fold.md)
- 知識文書: [差分更新の反映](../knowledge/reflection.md)、[更新の計画](../knowledge/update-plan.md)、[server/bench/README.md](../../server/bench/README.md)（`usage` の列）
- issue: [#87](https://github.com/daiki-beppu/live-mindmap/issues/87)、[#130](https://github.com/daiki-beppu/live-mindmap/issues/130)、[#398](https://github.com/daiki-beppu/live-mindmap/issues/398)、[#487](https://github.com/daiki-beppu/live-mindmap/issues/487)、[#635](https://github.com/daiki-beppu/live-mindmap/issues/635)、[#795](https://github.com/daiki-beppu/live-mindmap/issues/795)、[#997](https://github.com/daiki-beppu/live-mindmap/issues/997)、[#1395](https://github.com/daiki-beppu/live-mindmap/issues/1395)
- ログ（数だけ集計、本文は読んでいない）: `~/.live-mindmap/sessions/2026-10-26T13-05-05.113Z/log.jsonl`、`~/live-mindmap-samples/runs/diff-latency-1395/{head,old,noeffort}/log.jsonl`、`~/live-mindmap-samples/runs/split-997/session.{1,2}/log.jsonl`
- 単価: Claude API のスキルの価格表（2026-10-06 時点。Sonnet 5.5 $2 / $10、キャッシュ読み出し $0.20、5 分の書き込みは入力の約 1.25 倍。Haiku 5.5 $0.10 / $0.50）
