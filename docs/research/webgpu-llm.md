# ブラウザ内の WebGPU で動く LLM の現状（2026 年 10 月）

issue #376（地図 #374）の調査。ブラウザの中で WebGPU を使う LLM の実行環境（WebLLM（MLC）、transformers.js／ONNX Runtime Web、Chrome 組み込みの Prompt API）が、live-mindmap の差分更新（`server/src/claude.ts` の差分操作スキーマ）に使えるかを、一次情報で確かめた。モデルのダウンロードと実機での計測はしていない。数字は出典の値か、出典から計算した推定で、どちらかを書き分けた。

## 結論

- **使える見込みはある。ただし 16GB の M4 では 4B〜9B 級の 4bit 量子化が上限。その場合でも、今の SYSTEM とマップを毎回渡すには文脈長を既定の 4096 から上げる必要がある。** 実行環境の第一候補は WebLLM。モデルの数、JSON Schema による出力の制約（XGrammar）、会話をまたいだ KV キャッシュの再利用、Worker での実行、キャッシュの仕組みがすべて揃っている。
- **差分操作のスキーマ（`anyOf` で 6 種の op、`const`・`enum`・`minItems`・`additionalProperties: false`）は、XGrammar の変換器がどのキーワードも扱える**（コードで確認。実際にこのスキーマを通したわけではない）。transformers.js も 4.3（2026-09）で JSON Schema の制約を足したが、「experimental」の別パッケージで、扱えるキーワードの範囲は確かめていない。
- **Chrome（113 以降）と Safari 26（macOS Tahoe 26）のどちらも WebGPU を既定で有効にしている。** ただし WebLLM の Safari での動作は issue に不具合報告が残っており、Mac の Safari で大きいモデルが動くかは未確認。最初は Chrome を対象にするのが無難。
- **ダウンロードは 4B 級で約 2.3〜3GB、8〜9B 級で約 4.6〜5GB。** 既定のキャッシュは Cache API（OPFS・IndexedDB も選べる）。2 回目以降はキャッシュから読む。
- **速度の公表値は M3 Max で 8B が 41 tok/s。** M4（120GB/s）はメモリ帯域が M3 Max の 3 分の 1 以下なので、8B の生成は 10 tok/s 台と推定される。JSON で数百トークン出すと 1 回あたり十数秒から数十秒かかる見込み。実測が要る。
- **タブが裏に回ったときの扱いは、ドキュメントで保証されていない。** Chrome は、5 分以上隠れていて無音のタブのタイマーを間引く。省エネモードでは、CPU を多く使うタブを凍結する。WebGPU の計算そのものを間引くかどうかは、どの一次情報にも書いていない。
- **ダウンロードの後は、推論中に外へ通信しない作りにできる。** WebLLM も transformers.js も、モデル・wasm の取得先を自前の URL（localhost の Node サーバー）に向けられる。何も設定しなければ、初回は huggingface.co・raw.githubusercontent.com・cdn.jsdelivr.net から取る。ローカルモードでは、自前で配った上で CSP の `connect-src 'self'` で縛るのが確かめやすい。

## 1. 実行環境の候補と版

| 実行環境 | 最新版（2026-10-08 時点） | 要点 |
|---|---|---|
| WebLLM（`@mlc-ai/web-llm`） | 0.2.85（2026-09-08） | MLC／TVM でコンパイルしたモデルを WebGPU で動かす。OpenAI 互換の `chat.completions` API。JSON Schema・EBNF・structural tag で出力を制約できる |
| transformers.js（`@huggingface/transformers`） | 4.3.1（2026-10-07） | ONNX Runtime Web の上で動く。4.3 で構造化出力（experimental）と Safari 26 の WebGPU を追加 |
| ONNX Runtime Web（`onnxruntime-web`） | 1.30.0 | transformers.js の下回り。単体でも使えるが、生成ループやトークナイザは自分で書くことになる |
| Chrome の Prompt API（Gemini Nano） | Web は Chrome 148 で安定版 | 組み込みのモデル（Gemini Nano）を `LanguageModel` で呼ぶ。`responseConstraint` に JSON Schema を渡せる。日本語に対応。Chrome だけ |

出典: [web-llm releases](https://github.com/mlc-ai/web-llm/releases)、[transformers.js v4.3 リリースノート](https://github.com/huggingface/transformers.js/releases/tag/4.3.0)、npm の各パッケージ、[Built-in AI APIs の状況表](https://developer.chrome.com/docs/ai/built-in-apis)

Prompt API について補足する。モデルを選べず（Gemini Nano 固定）、文脈長も公表されていない（API の `contextWindow` で取得する）。条件は、プロファイルがあるボリュームに空き 22GB 以上、GPU の VRAM が 4GB より多い、または RAM 16GB 以上・4 コア以上。「モデルを使っても Google や第三者にデータは送られない」と明記されている（[Prompt API](https://developer.chrome.com/docs/ai/prompt-api)、2026-08-26 更新）。インストールなしで試せる経路としては一番手軽だが、品質を比べて推奨モデルを選ぶ（#374 の方針）余地が無い。そのため、ここでは脇の候補にとどめる。

## 2. 動くモデルとサイズの上限

### WebLLM の組み込みモデル

WebLLM 0.2.85 の `prebuiltAppConfig`（`src/config.ts`、モデルライブラリは `v0_2_84/base`）から、日本語の差分更新に使えそうなものを抜き出した。`vram_required_MB` は WebLLM 自身の見積もりで、既定の文脈長 4096 での値。ダウンロード量は Hugging Face のリポジトリにあるファイルの合計。

| モデル（q4f16_1） | VRAM 見積もり | ダウンロード | 備考 |
|---|---|---|---|
| Qwen3.5-2B | 2,245 MB | 1.08 GB | 201 言語。既定は thinking |
| Qwen3.5-4B | 3,868 MB | 2.39 GB | 同上。ハイブリッド構造（RNN 状態を持つ） |
| Qwen3.5-9B | 6,433 MB | 5.06 GB | 同上 |
| Qwen3-4B | 3,432 MB | 2.28 GB | 100 以上の言語 |
| Qwen3-8B | 5,696 MB | 4.62 GB | 同上 |
| Llama-3.1-8B-Instruct | 5,001 MB | 4.53 GB | 日本語は公式の対応言語に入っていない |
| gemma-2-9b-it | 6,422 MB | 5.22 GB | |
| gemma-2-2b-jpn-it | 1,895 MB | 1.49 GB | 日本語向けの調整版だが 2B |

ほかに Phi-3.5／4-mini、Mistral-7B、Hermes 系、SmolLM2、OLMo-2、Ministral-3-3B、DeepSeek-R1-Distill がある。Gemma 3 は 1B だけ、Gemma 4 は入っていない。q4f32_1 版は、`shader-f16` が無い環境向けで 2〜3 割重い。

- 上限を決めるのは、ブラウザが WebGPU に許すバッファの大きさ（`maxBufferSize`／`maxStorageBufferBindingSize`。WebLLM はモデルごとに `buffer_size_required_bytes` で確かめる）と、Mac の統合メモリのうち GPU が使える分。組み込みの中では 9B 級の q4f16（6.4GB）が 16GB の M4 で現実的な上限になる。70B（Llama-3/3.1-70B）も一覧にはあるが、16GB では載らない
- **文脈長**: 組み込みモデルのほとんどは `context_window_size` を 4096 に上書きしている（125 件。1024 が 26 件、2048 が 10 件）。`ChatOptions` でもっと大きく上書きできるが、その分 KV キャッシュの VRAM が増える。例えば Qwen3-8B（36 層・KV ヘッド 8・ヘッド次元 128、fp16）は、1 トークンあたり約 144KB。16k トークンでは KV だけで約 2.4GB 増える（推定）。Qwen3.5 は大半の層が線形注意（RNN 状態）なので、KV の増え方はこれより小さい
- 文脈長を超えると `ContextWindowSizeExceededError` になる（`src/llm_chat.ts`）

### live-mindmap の入力の大きさ（推定）

`SYSTEM` は約 2,500 字、`NOOP_SCOPE` は約 350 字ある。これにスキーマ（JSON で約 1,000 字）と、60 分で 50 ノードのアウトライン（約 1,500〜2,000 字）、直前の発言と新しい発言が足される。1 回目の入力は 5,000〜6,000 字ほどになる。日本語は 1 字が 1 トークン前後になりやすいので、**既定の 4096 トークンには収まらない見込み**。ADR 0006 のように 14 回分の会話を開いたまま積むなら、さらに要る。8k〜16k に上げる前提で VRAM を見積もるべきだ（トークン数は実測していない）。

WebLLM は、前回の会話の続き（それまでのメッセージが一致する）なら KV キャッシュをリセットせずに使い回す（`engine.ts` の "Multiround chatting, reuse KVCache"）。「開いたまま変更だけ送る」形は、ブラウザでも成り立つ作りになっている。

### transformers.js（ONNX）のモデル

onnx-community に、Qwen3.5-0.8B/2B/4B（9B もあるが中身は未整備）、Qwen3-0.6B/1.7B/4B、Gemma 3（270m/1B/4B）、Gemma 4 E2B/E4B、LFM2 系、Granite 4.0 などがある。q4f16 のダウンロード量は Qwen3.5-2B が 1.58GB、Qwen3.5-4B が 3.0GB、Qwen3-4B が 2.83GB。Gemma 4 E4B は 5.18GB で、画像・音声の部分を含む。7〜9B 級で WebGPU 向けに整ったものは見当たらず、選べる上限は WebLLM より一段小さい。

### 16GB の M4 での候補

日本語・指示追従・JSON の三つを考えると、試す順は次のとおり。

1. **Qwen3.5-4B（WebLLM、q4f16）**: 2.4GB、VRAM 3.9GB に文脈分が加わる。会議アプリ・Chrome・ヘルパーと同時に動かしても余裕がある
2. **Qwen3-8B／Qwen3.5-9B（WebLLM、q4f16）**: 4.6〜5GB、VRAM 5.7〜6.4GB に文脈分が加わる。品質は上がる見込みだが、16GB では会議アプリと取り合う。速度も半分ほどになる
3. Qwen3.5-2B は速度の下限を見る比較用

Qwen3／3.5 は既定で thinking する。WebLLM では `extra_body: { enable_thinking: false }` で止められる（`chat_completion.ts`）。差分更新では止めるか、thinking の分の時間を見込む。品質の足切りは既存の回帰評価で決める（#374 の方針）。ここでは決めていない。

出典: [web-llm `src/config.ts`](https://github.com/mlc-ai/web-llm/blob/main/src/config.ts)、[Qwen3.5-4B モデルカード](https://huggingface.co/Qwen/Qwen3.5-4B)、[Qwen3-8B モデルカード](https://huggingface.co/Qwen/Qwen3-8B)、Hugging Face API のファイル一覧（`mlc-ai/*`、`onnx-community/*`）

## 3. 出力の制約（JSON Schema・grammar）

### WebLLM

`response_format` の `type` には `text`／`json_object`／`grammar`／`structural_tag` を指定できる（`src/openai_api_protocols/chat_completion.ts` の `ResponseFormat`）。

- `{ type: "json_object", schema: JSON.stringify(SCHEMA) }` で JSON Schema に従わせる。`schema` は**文字列**で渡す
- `{ type: "grammar", grammar: "<EBNF>" }` で任意の文法にできる
- 中身は XGrammar（`@mlc-ai/web-xgrammar` 0.1.27）。トークンごとのマスクを WebAssembly で計算する。`usage.extra` に `grammar_init_s`・`grammar_per_token_s` が出るので、制約にかかった時間を測れる
- XGrammar の JSON Schema 変換器（`cpp/json_schema_converter.cc`）は、`anyOf`・`oneOf`・`allOf`・`$ref`・`const`・`enum`・`minItems`・`additionalProperties` を扱える。扱えないキーワードは警告を出して無視する（`uniqueItems`・`contains` など）。`description` は制約に関係しない。**差分操作のスキーマで使っているキーワードは、どれも扱える範囲にある**。ただし WebLLM が同梱するのは 0.1.27 で、上流の最新は 0.2.8（2026-09）。この版で通るかは実機で確かめる必要がある
- 0.2.85 で「不正な structural tag の初期化で固まる」不具合が直った

### transformers.js

4.3 で `@huggingface/transformers-structured-output` を追加した。`StructuredOutputProcessor` を `logits_processor` に渡し、`json_schema`／`json_object`／正規表現で制約する。「experimental」「依存なし」で、同時に生成できるのは 1 系列まで。`anyOf` などの対応範囲はリリースノートに書かれていない。

### Prompt API

`prompt(…, { responseConstraint: schema })` に JSON Schema を渡せる。対応するキーワードの範囲は確かめていない。

出典: [web-llm `chat_completion.ts`](https://github.com/mlc-ai/web-llm/blob/main/src/openai_api_protocols/chat_completion.ts)、[web-llm 0.2.85](https://github.com/mlc-ai/web-llm/releases/tag/v0.2.85)、[xgrammar `json_schema_converter.cc`](https://github.com/mlc-ai/xgrammar/blob/main/cpp/json_schema_converter.cc)、[transformers.js 4.3.0](https://github.com/huggingface/transformers.js/releases/tag/4.3.0)

## 4. Chrome と Safari の WebGPU

| ブラウザ | macOS での状況 |
|---|---|
| Chrome／Edge | 113 から既定で有効 |
| Safari | 26（macOS Tahoe 26）から既定で有効。iOS／iPadOS／visionOS 26 も同じ |
| Firefox | Apple Silicon の macOS 26 で 145 から（参考） |

出典: [gpuweb Implementation Status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)、[web.dev「WebGPU is now supported in major browsers」（2025-11-25）](https://web.dev/blog/webgpu-supported-major-browsers)

- WebGPU は安全なコンテキストでしか使えないが、live-mindmap は `localhost` で配っているので条件を満たす
- **WebLLM の Safari 対応**: README は Safari を名指ししていない。issue では、iOS 26 の Safari で大きいモデルを読み込むとタブが落ちる報告があり（[#753](https://github.com/mlc-ai/web-llm/issues/753)、閉じられたが「こちらでは直せない」との見立て）、Safari の WebContent プロセスのメモリ上限が疑われている。これは iOS の話で、**Mac の Safari で 4〜9B が動くかは確かめていない**
- transformers.js は 4.3 で「Safari 26 以上で WebGPU を有効にした」
- Prompt API は Chrome だけ

ブラウザを問わない、という前提を置かない（利用者の方針）なら、推論は Chrome で動かし、表示は他のブラウザでもかまわない、という分け方もある。どのタブで推論するかは #379 で決める。

## 5. モデルの取得とキャッシュ

- **取得先（既定）**: WebLLM は、重みを `https://huggingface.co/mlc-ai/<model>`、モデルライブラリ（wasm）を `https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/…` から取る（`modelLibURLPrefix`）。transformers.js は、モデルを `https://huggingface.co/` から、ONNX Runtime の wasm を `https://cdn.jsdelivr.net/npm/onnxruntime-web@<版>/dist/` から取る（`env.js`、`backends/onnx.js`）
- **キャッシュ**: WebLLM は `AppConfig.cacheBackend` で `cache`（Cache API、既定で一番よく試されている）／`indexeddb`／`opfs`／`cross-origin`（Chrome の Cross-Origin Storage 拡張、実験的）を選べる。0.2.85 で OPFS の同期アクセスハンドルを追加した。`hasModelInCache()`・`deleteModelAllInfoInCache()` で、キャッシュの有無を確かめたり消したりできる。整合性の確認には SRI ハッシュ（`integrity`）を使える。transformers.js は `env.useBrowserCache`（Cache API、既定で有効）と、実験的な Cross-Origin Storage
- **容量**: Safari（ブラウザアプリ）は、1 オリジンあたり最大でディスクの 60%、全体で 80% まで使える。消すときはオリジン単位で、最後に操作した時刻が古いものから消す。`navigator.storage.persist()` を許すかどうかは「ホーム画面の Web アプリか」などの経験則で決まる（[WebKit の Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)）。キャッシュは消えうる前提で、「再取得になることがある」と案内する
- **初回の待ち時間**: ダウンロードの量（4B 級 2.3〜3GB、8〜9B 級 4.6〜5GB）を回線速度で割った時間に、コンパイルと GPU への読み込みが加わる。100Mbps なら 4B 級でダウンロードだけで約 3〜4 分（計算値）。`initProgressCallback`（WebLLM）／`progress_callback`（transformers.js）で進み具合を出せる。キャッシュがあっても、毎回の起動で GPU への読み込みとシェーダのコンパイルに数秒〜数十秒かかる見込み（未計測）
- **同じオリジンから配る**: WebLLM の `ModelRecord.model`／`model_lib` には任意の URL を指定できる。`model_lib` が `localhost` を含む URL か相対パスなら、WebLLM は wasm をキャッシュせず毎回 fetch する（`engine.ts`）。transformers.js では `env.allowRemoteModels = false`・`env.localModelPath`・`env.backends.onnx.wasm.wasmPaths` で同じことができる。この場合、Node サーバーがモデルを一度取得して配ることになり、取得と保存の役はサーバー側に移る

## 6. 速度とタブが裏に回ったとき

### 速度の目安

- WebLLM の論文の評価（MacBook Pro M3 Max、4bit）: Llama-3.1-8B が 41.1 tok/s（ネイティブの MLC-LLM は 57.7、71%）、Phi-3.5-mini が 71.1 tok/s（ネイティブ 89.3、80%）。「ネイティブの最大約 80% の生成速度を保つ」（[arXiv 2412.15803](https://arxiv.org/abs/2412.15803)）
- 生成の速度はメモリ帯域でほぼ決まる。手元の M4 は 120GB/s（[MacBook Air M4 の仕様](https://support.apple.com/en-us/122209)）で、M3 Max は最大 400GB/s。**8B 級で 10〜13 tok/s、4B 級でその 2 倍程度と推定する**（計算による推定で、実測していない）
- 差分更新の出力は、ふつう数十〜数百トークンの JSON になる。8B 級なら、プレフィル（初回 5k トークン級）と生成を合わせて 1 回あたり十数秒〜数十秒かかる見込み。今の「2 発言ごと・同時に 1 つまで」に間に合うかは、#374 の「遅さへの対応」で計測してから決める
- transformers.js の WebGPU で LLM を動かしたときの公式のトークン速度は見当たらなかった

### タブが裏に回ったときの挙動

- **Chrome のタイマー**: 隠れたタブのタイマーは 1 秒に 1 回まで。さらに「5 分以上隠れている」「連鎖が 5 回以上」「30 秒以上無音」「WebRTC を使っていない」がすべてそろうと、1 分に 1 回まで間引かれる（[Chrome 88 のタイマー間引き](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)）。WebSocket で依頼を受けてすぐ推論する作りなら、タイマーには頼らずに済む
- **Chrome の凍結**: Chrome 133 からは、省エネモードがオンのとき、5 分以上隠れていて無音、かつ「CPU を多く使う」タブを凍結する（イベントハンドラ・タイマー・Promise が止まる）。マイク・カメラ・画面キャプチャ・`RTCPeerConnection` を使うタブ、ほかのグループを止める Web Lock や IndexedDB の接続を持つタブは除外される。一時的に逃れる手段として、BackgroundPageFreezeOptOut の origin trial がある（[Freezing on Energy Saver](https://developer.chrome.com/blog/freezing-on-energy-saver)）。推論するタブは、会議の間に CPU／GPU を使い続けるので、対象になりうる
- **Worker と WebGPU**: WebLLM は Dedicated Worker・Service Worker で動かせる。Service Worker は「ブラウザがいつでも止めうる」ので、ハートビートで保つ作りになっている（README）。隠れたタブの Worker や WebGPU のキュー投入が間引かれるかどうかは、Chrome にも WebKit にも一次情報が見当たらなかった。**実測が要る**。会議中は会議アプリが前面に出て、ブラウザが裏に回るのがふつうなので、ここは確かめておく価値が高い
- Safari のバックグラウンドの扱いは、公式の文書が見当たらなかった

## 7. 推論中の通信

- WebLLM・transformers.js とも、推論の処理そのものはブラウザの中で完結する。ソース（`engine.ts`・`cache_util.ts`・`llm_chat.ts`）にテレメトリや解析の送信は見当たらない。ネットワークに出るのは、設定・トークナイザ・重み・wasm の取得（`fetchWithCache`）だけ
- ただし既定では、外部のホスト（huggingface.co・raw.githubusercontent.com・cdn.jsdelivr.net）から取得する。キャッシュがあれば外へは出ないが、キャッシュが消えた・版が変わったときには取りに行く
- ローカルモードで「外に出ない」を確かめられる形にするなら、次の組み合わせが考えられる
  1. モデル・wasm・ライブラリを Node サーバー（localhost）から同じオリジンで配る（§5）
  2. ページに CSP の `connect-src 'self'`（と `script-src 'self' 'wasm-unsafe-eval'` など）を付ける。外への fetch はブラウザが拒むので、設定を間違えても漏れない
  3. モデルの初回取得は、ローカルモードを始める前の別の手順にする（取得の間だけ外に出ることを明示する）
- Prompt API の Gemini Nano については、Google が「データは Google にも第三者にも送られない」と書いている。ただしモデルの取得と更新は Chrome が管理するので、上の 2 のような形では縛れない

## 確かめていないこと

- 差分操作のスキーマを WebLLM（web-xgrammar 0.1.27）に実際に通して、文法がコンパイルできるか、1 トークンあたりの制約の時間
- M4・16GB での生成速度、プレフィルの時間、文脈長を 8k／16k に上げたときの VRAM と、会議アプリ・ヘルパーと同時に動かしたときの余裕
- 実際のトークン数（今の SYSTEM・スキーマ・50 ノードのマップ）
- Mac の Safari 26 で 4B〜9B が読み込めるか、`shader-f16` があるか
- 隠れたタブ・裏のウィンドウ・Worker で、WebGPU の推論が間引かれるか止まるか（Chrome・Safari）
- 日本語の差分更新の品質（回帰評価は別チケット）
- Prompt API の文脈長と、JSON Schema の対応範囲
- Node から WebGPU を使う道（Dawn のバインディング）は、#379 の範囲として調べていない
