# System One モデル 3 社（Jev・OpenAI Decisions・Clef）を判定の用途で比べる

Issue [#758](https://github.com/daiki-beppu/live-mindmap/issues/758)（地図 [#757](https://github.com/daiki-beppu/live-mindmap/issues/757)）の調査。2026-10-10 時点の公式ドキュメントと、このリポジトリの Jev の実測（[docs/knowledge/2026-09-30.md](../knowledge/2026-09-30.md)・[2026-10-02.md](../knowledge/2026-10-02.md)）だけを使った。有料の API は呼んでいない。各社の数字は各社が自分で測った値で、条件はそろっていない。

## まとめ

| 観点 | Jev（TypeSafe） | OpenAI Decisions（`gpt-6-luna`） | Clef-flash / Clef / Clef-omni（Cloudflare Workers AI） |
|---|---|---|---|
| 状態 | early access（順番待ちから順に解放）[^ts-blog] | 公開ベータ。「数週間で GA の見込み」[^oai-dec] | Workers AI で提供中（10/01 公開、10/09 に omni 追加）[^cf-cl1001][^cf-cl1009] |
| 応答時間（公表値） | 端から端まで 70〜500 ms（西海岸のノート PC から）[^ts-blog]。Cloudflare の 43 ベンチでは中央値 524 ms / p95 536 ms[^cf-blog] | 絶対値なし。「Responses API の約 10 倍速い」だけ[^oai-dec] | Cloudflare の 43 ベンチで Clef-flash 中央値 38.8 / p95 122.4 ms、Clef 209.3 / 238.6 ms[^cf-blog]。10/09 以降の Clef は入力 約 3,400 トークンで 305 / 531 ms[^cf-cl1009] |
| このリポジトリの実測 | 1 回 約 0.2 秒（9/30、10/02）[^k0930][^k1002] | なし | なし |
| 入力単価（100 万トークン） | $0.042[^ts-models] | $0.10（Decisions はこれだけ。キャッシュ・出力の課金なし）[^oai-dec] | flash $0.038 / omni $0.150 / Clef $0.240[^cf-pricing] |
| 出力単価 | 無料[^ts-models] | 課金なし[^oai-dec] | 課金なし[^cf-clef][^cf-flash] |
| 60 分（約 117 万トークン）の見積もり | 約 $0.049 | 約 $0.117（地域処理なら +10% で 約 $0.129） | flash 約 $0.044 / omni 約 $0.176 / Clef 約 $0.281 |
| 無料枠 | 記載なし | 記載なし | 1 日 10,000 Neurons（flash なら 1 日 約 289 万トークンぶん。60 分の会議 2 本強）[^cf-pricing] |
| 日本語 | 「主な学習言語は英語。CJK も扱うが同じ精度ではない。自分のデータで試すこと」[^ts-models] | 記載なし | 記載なし（土台は Qwen3.5-9B / Qwen3.8-27B）[^cf-blog][^hf-flash] |
| 質問の形 | Choice・Score・Noul（yes/no の確率）。Choice と Score は確率の分布と confidence[^ts-api] | `choice`・`score`・`predicate`（真である確率）。choice と score は確率の分布と confidence。答えに `refusal` がある[^oai-dec] | `choice`・`score`・`noul`（Jev と同じ System One API）。全選択肢に確率[^cf-clef] |
| 1 回に複数の質問 | できる。3 種を混ぜられ、並列に独立して評価。「質問を足しても応答時間はほぼ変わらない」[^ts-intro] | できる。独立した質問を 1 つの `questions` に並べる。依存する質問は別の呼び出し[^oai-dec] | できる。1〜64 問[^cf-clef] |
| 選択肢の上限 | 255（大きい集合は 2 段で採点）[^ts-blog] | 記載なし | 記載なし |
| 入力 | テキストだけ（文字列・JSON・配列）。画像・音声・動画は不可[^ts-models] | テキストと画像（base64 の data URL だけ。URL・`file_id` は不可）[^oai-dec] | テキスト・JSON・画像 4 枚まで（URL 不可）。omni は音声 4 本（各 300 秒まで）・動画 2 本も[^cf-clef][^cf-omni] |
| 文脈長 | 1 回 64k。state と最長の質問で 32k[^ts-models] | 記載なし（モデル `gpt-6-luna` としては 105 万。272K 超は単価 2 倍）[^oai-model][^oai-dec] | flash 24,576（10/09 に 64K から縮小。超えると state を切り詰め）/ Clef・omni 64K[^cf-flash][^cf-cl1009] |
| 学習利用 | しない[^ts-models] | しない（API 既定）[^oai-data] | しない[^cf-data][^cf-blog] |
| 保存・ZDR | ZDR はエンタープライズ向けに相談[^ts-legal] | 不正監視ログ 最大 30 日。ZDR・HIPAA は条件を満たす顧客のみ[^oai-data] | 「リクエストと応答を読まない・保存しない・学習しない」（微調整に参加した場合を除く）[^cf-blog] |
| 地域 | 記載なし | 地域処理は米国と欧州（EEA + スイス）。日本はない[^oai-dec][^oai-data] | 推論する場所の記載なし |
| 使い始める条件 | 招待されたアカウントで API キー。このリポジトリには鍵がある（1Password `TYPESAFE_API_KEY`） | OpenAI の API キーと SDK の新しい版（JS 7.30.0 以上など）[^oai-dec] | Cloudflare アカウント。無料枠を超えるなら Workers Paid[^cf-pricing]。Node からは REST `/ai/run` で呼べる[^cf-cl1001] |
| 手元で動かせるか | 不可（重みは非公開。顧客ごとの微調整もしない）[^ts-models] | 不可 | 重みを Apache 2.0 で公開。flash は 9B、量子化版が 44 種あり、SGLang で `/v1/systemone` を出せる。Mac での動作の記載はない[^hf-flash] |
| 微調整 | しない（state と質問の書き方で合わせる）[^ts-models] | 記載なし（`gpt-6-luna` は Fine-tuning 非対応[^oai-model]） | 強化学習の微調整を、デザインパートナー向けに Cloudflare の人手付きで提供。セルフサービスは今後[^cf-blog][^cf-rl] |

見積もりの 117 万トークンは、Jev のトークナイザーで数えた 9/30 の値（状態にマップを入れて 60 分）[^k0930]。他社はトークナイザーが違うので、日本語では件数が変わる。また 1 回あたりは 約 3,000〜4,000 トークン（117 万 ÷ 発言 300〜400 件）で、どの社も文脈長・長文の割増の境目（OpenAI の 272K）には届かない。

## 社ごとの補足

### Jev（TypeSafe）

- エンドポイントは `POST https://api.typesafe.ai/v1/systemone`。`jev-latest` は今 `jev-1.13.0` を指す。別名は新しい版で答えが変わるので、閾値を合わせたら版の ID を固定するよう勧めている[^ts-models]。
- レート上限は 毎秒 10 万トークン / 80 リクエスト。ただし「需要が多く、予告なく変わる」と注意書きがある[^ts-models]。
- 弱点を公表している（jev-1.13 の jaggedness）。このリポジトリに関係するのは 2 つ。state に関係のない中身が増えると精度が落ちる（context rot）、Choice の選択肢の順番で答えが変わり、先頭に寄ることがある[^ts-jag]。9/30 の「どのノードの話か」は、マップの全ノードを選択肢に並べる質問なので、両方に当たる。
- このリポジトリの実測: 1 回 約 0.2 秒、60 分で 約 $0.05。「どのノードの話か」は Claude が実際に更新したノードと 86% 一致、「話題が切り替わったか」はどの設計でも判定できなかった[^k0930]。6 場面での Jev 自体の費用は $0.002[^k1002]。

### OpenAI Decisions API

- エンドポイントは `POST /v1/decisions`、モデルは `gpt-6-luna` だけ[^oai-dec]。
- Decisions の課金は入力だけ $0.10 / 100 万トークン。ただし「地域処理の割増と長文の倍率はかかる」[^oai-dec]。地域処理（データ所在地）は 10% 増し[^oai-pricing]。
- 文脈長・質問数の上限・選択肢数の上限・レート上限・日本語の精度は、Decisions のページに書かれていない。`gpt-6-luna` のモデルのページは、対応エンドポイントに Decisions を挙げていない（Chat Completions・Responses・Batch だけ）[^oai-model]。モデルのページのレート上限（Build 階層で 5,000 RPM）が Decisions にも当たるかは分からない。
- 答えの型に `refusal` があるので、拒否されたときの扱いを決めておく必要がある[^oai-dec]。
- 画像は base64 だけ。共有画面を判定に使う案（#757 の「Not yet specified」）には、Decisions と Clef の両方が使える。
- 音声からの操作は、Live API の client delegation として別のガイドになっている[^oai-dec]。

### Cloudflare Clef 一家

- Clef は 27B（Qwen3.8-27B を凍結して LoRA と判定の頭を学習）、Clef-flash は 9B（Qwen3.5-9B）。生成はせず、1 回の prefill のあと選択肢を並列に採点する[^cf-blog]。
- 「Jev と同じ System One API に従うので、Jev の組み込みはエンドポイントとモデルを替えるだけで移れる」[^cf-cl1001]。live-mindmap の判定の段を「差し替えられる 1 つの口」にする方針（#757）とかみ合う。
- 精度の公表値（Cloudflare 自身の測定。英語のベンチ）[^cf-cl1001][^cf-cl1009]:

  | ベンチ | Clef | Clef-flash | Clef-omni | Jev |
  |---|---|---|---|---|
  | BFCL | 98.47 | 98.76 | 98.2 | 95.75 |
  | BANKING77（macro-F1） | 94.20 | 90.93 | 94.8 | 79.74 |
  | CLINC150+OOS（macro-F1） | 97.43 | 66.77 | 97.7 | 89.27 |
  | Amazon ESCI（macro-F1） | 57.48 | 57.39 | 57.8 | 55.21 |
  | PhishNChips（accuracy） | 79.60 | 75.05 | 73.2 | 62.55 |

  Clef-flash は CLINC150+OOS（範囲外の発話を見分ける意図分類）で 66.77 と大きく落ちる。「どのノードにも関係しない」「雑談」を拾う質問はこれに近い形なので、flash を選ぶならここを自分の素材で確かめる。
- 10/09 の値下げで、Clef-flash の文脈長は 64K から 24K に縮んだ（「24K を超えるリクエストは 0.24%」）。超えると state が切り詰められる[^cf-cl1009][^cf-flash]。1 回 約 3,000〜4,000 トークンなら収まるが、長い会議でマップが大きくなると近づく。
- Clef-omni は音声（1 本 300 秒まで、約 13 トークン/秒）を直接入力できる[^cf-omni]。文字起こしを経ずに判定する案も理屈の上ではあり得るが、ローカル完結の STT（ADR 0002）とは別の話になる。
- ローカルモード（#374）: 重みは Apache 2.0 で公開され、量子化版も 44 種ある。Hugging Face のカードが挙げる動作確認は H200 1 枚だけで、Apple シリコン・MLX には触れていない[^hf-flash]。Mac で動くか、日本語でどの速さかは確かめていない。

## 分からないこと・測る必要があること

1. **日本語の精度**。3 社とも日本語の公表値はない。Jev だけが「英語が主、CJK は同じ精度ではない」と書いている。9/30 の素材（合成会議）で、同じ質問（役割 8 択・どのノードの話か）を 3 社に投げ、Claude のラベルとの一致率を比べる必要がある。
2. **同じ条件の応答時間**。Jev はこのリポジトリで約 0.2 秒、Cloudflare の表では 524 ms と食い違う（測った場所と入力の大きさが違う）。Decisions は絶対値が無い。ローカル Node サーバー（日本）から、1 回 約 3,000〜4,000 トークンの入力で、3 社の p50/p90 を同じスクリプトで測る。Workers AI は推論する場所が書かれていないので、日本からの往復も込みで測る。
3. **日本語のトークン数**。117 万トークンは Jev のトークナイザーの値。OpenAI・Qwen 系で同じ入力が何トークンになるかで、見積もりが変わる。各社の応答の `usage` で数える。
4. **Decisions の上限**。文脈長・質問数・選択肢数・レート上限が Decisions のページに無い。API リファレンスの公開を待つか、ベータで試して確かめる。マップの全ノードを選択肢にする質問では、選択肢数の上限が効く。
5. **Clef-flash の範囲外の判定**。CLINC150+OOS の 66.77 が、「どのノードにも関係しない」の判定でどう出るか。
6. **選択肢の順番による偏り**。Jev は公表済み。他の 2 社も同じ偏りがあるか、選択肢を並べ替えて答えが変わるかを測る。
7. **Clef の手元実行**。量子化した Clef-flash が Apple シリコンで動くか、速さは足りるか（ローカルモードで使えるかの判断材料）。
8. **データの扱いの細部**。Workers AI の推論地域・ログの保存期間、TypeSafe の通常アカウントの保存期間（DPA の中身）は、今回読んだ範囲に書かれていない。

## 出典

[^ts-blog]: TypeSafe, "Introducing System One Models and Jev" https://typesafe.ai/blog/introducing-system-one-models-and-jev
[^ts-models]: TypeSafe Docs, Models https://docs.typesafe.ai/models
[^ts-api]: TypeSafe Docs, API reference https://docs.typesafe.ai/api
[^ts-intro]: TypeSafe Docs, Introduction https://docs.typesafe.ai/introduction
[^ts-jag]: TypeSafe Docs, Jev 1.13 jaggedness https://docs.typesafe.ai/model-jaggedness/jev-1.13
[^ts-legal]: TypeSafe Docs, Legal https://docs.typesafe.ai/legal
[^oai-dec]: OpenAI, Decisions guide https://developers.openai.com/api/docs/guides/decisions
[^oai-pricing]: OpenAI, Pricing https://developers.openai.com/api/docs/pricing
[^oai-model]: OpenAI, GPT-6 Luna model page https://developers.openai.com/api/docs/models/gpt-6-luna
[^oai-data]: OpenAI, Data controls https://developers.openai.com/api/docs/guides/your-data
[^cf-cl1001]: Cloudflare changelog, "Introducing Clef" (2026-10-01) https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/
[^cf-cl1009]: Cloudflare changelog, "Clef-omni adds audio and video input, Clef-flash is now cheaper, and Clef is faster" (2026-10-09) https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/
[^cf-blog]: Cloudflare blog, Clef decision models https://blog.cloudflare.com/clef-decision-models/
[^cf-clef]: Workers AI model page, Clef https://developers.cloudflare.com/workers-ai/models/clef/
[^cf-flash]: Workers AI model page, Clef-flash https://developers.cloudflare.com/workers-ai/models/clef-flash/
[^cf-omni]: Workers AI model page, Clef-omni https://developers.cloudflare.com/workers-ai/models/clef-omni/
[^cf-pricing]: Workers AI pricing https://developers.cloudflare.com/workers-ai/platform/pricing/
[^cf-data]: Workers AI data usage https://developers.cloudflare.com/workers-ai/platform/data-usage/
[^cf-rl]: Cloudflare, Clef RL interest form https://www.cloudflare.com/resource/clef-rl-interest/
[^hf-flash]: Hugging Face, Cloudflare/clef-flash https://huggingface.co/Cloudflare/clef-flash
[^k0930]: このリポジトリ [docs/knowledge/2026-09-30.md](../knowledge/2026-09-30.md)（差分更新エンジンの試作 8〜10 節）
[^k1002]: このリポジトリ [docs/knowledge/2026-10-02.md](../knowledge/2026-10-02.md)（AI 呼び出しを速くする案の計測）
