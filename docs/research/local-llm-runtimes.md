# ネイティブのローカル LLM で差分操作をスキーマどおりに出せるか

調べた日: 2026-10-08。issue [#375](https://github.com/daiki-beppu/live-mindmap/issues/375)（地図 [#374](https://github.com/daiki-beppu/live-mindmap/issues/374)）の調査。

一次情報（公式ドキュメント、ソースコード、リリースノート、モデルカード）だけを根拠にした。手元の M4・16GB にはどのランタイムも入っておらず（`which ollama lms llama-server mlx_lm.server` はどれも無し）、この調査では実測していない。速度は公開ベンチマークからの**推定**で、16GB の段は後のチケットで実測する前提。

## 結論

- **スキーマどおりに出せる**。llama.cpp server・Ollama・LM Studio は、OpenAI 互換の `response_format: {type: "json_schema", json_schema: {schema}}` を受け取り、文法（grammar）でトークンを制約して出力させる。`SCHEMA` で使っている `anyOf`・`const`・`enum`・`minItems`・`additionalProperties: false`・`required` は、3 つが使う変換器（llama.cpp の json-schema-to-grammar、XGrammar、Outlines）のどれでも扱われている。
- **mlx-lm の server（`mlx_lm.server`）だけは構造化出力を持たない**。文書化されたリクエスト項目にも `server.py` にも `response_format` が無い。使うならプロンプトで頼んで検証・再試行するしかなく、第 1 の経路には向かない。
- **プレフィックス（KV）キャッシュは 4 つとも持つ**。OpenAI 互換 API は状態を持たないので、会話の配列を毎回丸ごと送り、ランタイムが前回と一致する前置きを使い回す形になる。ADR 0006 の「開いた query に変更だけを足す」は「messages に変更だけを足していく」に置き換えれば成り立つ。ただし、思考（thinking）を有効にするとチャットテンプレートが過去の応答を書き換えて一致が途切れることがあるので、差分更新では思考を切る。
- **16GB の段は Qwen3.5-9B と Gemma 4 12B（どちらも 4bit）を本命に実測する**。速さが足りなければ Qwen3.5-4B・Gemma 4 E4B に下げる。推定では 9B で 1 回 15〜25 秒かかり、今の「2 発言ごと・同時に 1 つまで」が詰まる可能性が高い。
- **32GB 以上の段は Qwen3.6-35B-A3B と Gemma 4 26B-A4B（どちらも MoE）を第 1 候補にし、品質寄りに Qwen3.8-27B・Gemma 4 31B を挙げる**。すべて未検証。
- **ローカルモードで気を付ける通信**: Ollama のデスクトップアプリは 1 時間ごとに更新を確認し、端末 ID を送る。さらに Ollama には `:cloud` の付いたモデル名があり、localhost に投げても ollama.com で推論される。宛先が localhost かどうかの検査だけでは「外に出ない」を守れない。

## 前提: 差分更新が LLM に求めること

`server/src/claude.ts` から読み取った要件。

- `SCHEMA` は `{ops: [...]}`。`ops` の要素は `anyOf` で 6 種（add・update・combine・move・delete・noop）の object を並べ、それぞれ `op: {const: ...}`・`additionalProperties: false`・`required` を持つ。`kind` と `planStatus` は `enum`、`evidence` は `minItems: 1` の文字列配列。
- `SYSTEM` は日本語で約 2,900 字（2〜3 千トークン程度と見積もる。トークナイザーで数えてはいない）。最初の呼び出しはこれにマップ全体と発言が乗る。
- ADR 0006: 開いた query を 14 回使い回し、2 回目からはマップの変更だけを送る。開き直すとき（回数・失敗・ストリームの終わり）は全体を送る。

## ランタイムごとの構造化出力

| ランタイム（確認した版） | OpenAI 互換の `response_format: json_schema` | 制約のかけ方 | 本件のスキーマ |
|---|---|---|---|
| llama.cpp server（v0.6.0、2026-10-05） | 受け付ける | JSON Schema を GBNF の文法に変換して、生成時にトークンを制約 | 使っている機能はすべて変換される |
| Ollama（v0.40.0、2026-09-25） | 受け付ける（`format` に読み替え） | GGUF は内部で起動する llama-server の文法。Apple Silicon では対応アーキテクチャが既定で MLX で動き、XGrammar で制約 | 同上 |
| LM Studio | 受け付ける | GGUF は llama.cpp の文法、MLX は Outlines | 同上（Outlines は正規表現ベースで、試していない） |
| mlx-lm server（0.32.0） | **無い** | なし | 使えない |

### llama.cpp server

- `/v1/chat/completions` は `response_format` で `json_object` と、スキーマで制約した JSON を受け付ける（[server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)「POST /v1/chat/completions」）。実装では `type: "json_schema"` のとき `json_schema.schema` を取り出す（[server-common.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-common.cpp) の `response_format` の処理）。OpenAI の形のまま送れる。
- 変換器（[json-schema-to-grammar.cpp](https://github.com/ggml-org/llama.cpp/blob/master/common/json-schema-to-grammar.cpp)）は `anyOf`（union の規則）、`const`、`enum`、`minItems`/`maxItems`（繰り返しの回数）、`required` と任意プロパティ、`additionalProperties` を規則に落とす。
- 制限（[grammars/README.md](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)）: 同じ型の中で `properties` と `anyOf`/`oneOf` を混ぜられない、入れ子の `$ref` が壊れる、`uniqueItems`・`not`・`if/then/else` などは非対応で、**非対応の機能は黙って無視される**。`SCHEMA` は `anyOf` を配列の要素に置き、各選択肢が自分の `properties` を持つ形なので、混ぜる制限には当たらない。
- 文法が守るのは形だけ。`parent` や `node` に存在する id が入るかは守らない。適用できない操作は今もマップに出ないので（ADR 0006）、扱いは変わらない。

### Ollama

- OpenAI 互換層は `response_format.type == "json_schema"` のとき `json_schema.schema` をそのまま `format` に渡す（[openai/openai.go](https://github.com/ollama/ollama/blob/main/openai/openai.go)）。
- GGUF のモデルは「上流の llama-server をサブプロセスとして」動かす（[llm/server.go](https://github.com/ollama/ollama/blob/main/llm/server.go) の `NewLlamaServer` のコメント）。制約は llama.cpp と同じ。
- v0.40.0 から、Apple Silicon では MLX が対応するアーキテクチャ（gemma4・qwen3.5・qwen3.6・qwen3.8 など）が既定で MLX で動く（[v0.40.0 のリリースノート](https://github.com/ollama/ollama/releases/tag/v0.40.0)）。MLX 側の構造化出力は XGrammar（[mlxrunner/grammar.go](https://github.com/ollama/ollama/blob/main/mlxrunner/grammar.go)）。XGrammar の変換器は `anyOf`・`oneOf`・`const`・`enum`・`minItems`・`additionalProperties` を扱う（[json_schema_converter.cc](https://github.com/mlc-ai/xgrammar/blob/main/cpp/json_schema_converter.cc)）。
- 思考するモデルでは、思考の部分は制約せず、思考が閉じてから形式を当てる（`llm/server.go` の `ThinkingClose`）。v0.34.4 で「思考するモデルの構造化出力が 1 回の生成で済むようになった」（[v0.34.4](https://github.com/ollama/ollama/releases/tag/v0.34.4)）。
- 公式ドキュメントは「スキーマを文字列でもプロンプトに入れると良い」と勧める（[Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)）。Ollama Cloud では構造化出力が使えない（同ページ）。
- **文脈長の落とし穴**: 既定の文脈長は 4,096 トークンで、OpenAI 互換 API からは変えられない（[FAQ](https://docs.ollama.com/faq)、[OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)）。`SYSTEM` とマップと会話が入りきらないので、`OLLAMA_CONTEXT_LENGTH` か Modelfile の `num_ctx` で広げる必要がある。

### LM Studio

- `response_format` の `json_schema` で受け付ける。GGUF は llama.cpp の文法、MLX は Outlines で制約する。「7B 未満のモデルは構造化出力ができないことがある」と注意書きがある（[Structured Output](https://lmstudio.ai/docs/developer/openai-compat/structured-output)）。
- MLX のエンジン（[lmstudio-ai/mlx-engine](https://github.com/lmstudio-ai/mlx-engine)）は `outlines-core==0.1.26` を使う。outlines-core の変換器は `anyOf`・`oneOf`・`enum`・`const`・`minItems`・`additionalProperties` を扱う（[parsing.rs](https://github.com/dottxt-ai/outlines-core/blob/main/src/json_schema/parsing.rs)）。正規表現に落とす方式なので、任意プロパティの多い 6 択のスキーマでコンパイルが重くならないかは試していない。
- 画面なしで動かすなら `llmster`（`lms daemon up`）がある（[Headless](https://lmstudio.ai/docs/developer/core/headless)）。

### mlx-lm server

- README は「本番には勧めない」と書き、リクエスト項目に `response_format` が無い（[SERVER.md](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md)）。`server.py` にも `response_format`・`json_schema` の処理は無い（2026-10-08 の main で確認）。`max_tokens` の既定が 512 なのも注意。
- MLX で動かしたいなら、Ollama（MLX ランナー＋XGrammar）か LM Studio（mlx-engine＋Outlines）を通す方が構造化出力を得られる。

## プレフィックス（KV）キャッシュ

OpenAI 互換 API は会話を覚えないので、こちらが messages を全部送り、ランタイムが「前回と同じ前置き」を見つけて計算を省く。ADR 0006 の作りをそのまま写すなら、messages に「最初の全体 → 応答 → 変更 → 応答 …」と足していき、14 回で開き直す（全体を送り直す）。

| ランタイム | キャッシュ | 気を付けること |
|---|---|---|
| llama.cpp server | `cache_prompt` が既定で有効。前回の処理と比べて「まだ見ていない後ろの部分」だけを計算する。`--cache-ram`（既定 8192 MiB）でスロット外にもキャッシュを持つ | `cache_prompt` はバッチの大きさの違いで結果が完全には一致しない（非決定的）と明記。Gemma 4（スライディング窓）や Qwen3.5 系（Gated DeltaNet との混成）は途中まで巻き戻せないため、`--ctx-checkpoints`（既定 32）の位置からしか再開できない。足していくだけなら問題は出にくい |
| Ollama | llama-server ランナーは上記を引き継ぐ。MLX ランナーは前置きの木（trie）でキャッシュを持ち、会話をまたいで使い回す。再帰型・回転型の層も扱う | 既定ではモデルを 5 分使わないとメモリから下ろす（`keep_alive`）。下ろすとキャッシュも消えるので、会議中は `keep_alive: -1` か `OLLAMA_KEEP_ALIVE` で保つ |
| LM Studio | GGUF は llama.cpp のキャッシュ。MLX は mlx-engine の `cache_wrapper.py` | 中身の細部は確かめていない |
| mlx-lm server | `LRUPromptCache` の `fetch_nearest_cache` で一番近いキャッシュを使う | 構造化出力が無いので本件では使わない |

出典: llama.cpp の [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)（`--cache-prompt`・`cache_prompt`・`--cache-ram`・`--ctx-checkpoints`・`--swa-full`）、Ollama の [mlxrunner/prefix_cache.go](https://github.com/ollama/ollama/blob/main/mlxrunner/prefix_cache.go) 冒頭の不変条件、[FAQ](https://docs.ollama.com/faq)（keep_alive）、mlx-engine の [mlx_engine/cache_wrapper.py](https://github.com/lmstudio-ai/mlx-engine/tree/main/mlx_engine)、mlx-lm の [server.py](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py)。

### 思考を切る理由

- Qwen3.5 は既定で思考モードで、`<think>…</think>` を先に出す（[Qwen3.5-9B のモデルカード](https://huggingface.co/Qwen/Qwen3.5-9B)）。Qwen3.8-27B は思考が既定で有効、過去の思考を残す `preserve_thinking` も既定で有効（[Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B)）。どちらも `chat_template_kwargs: {"enable_thinking": false}` で切れる。Gemma 4 も思考モードを切り替えられる（[gemma-4-12B-it](https://huggingface.co/google/gemma-4-12B-it)）。
- 思考を残すと、出力トークンが増えて遅くなる。過去の思考を落とすテンプレートだと、前回送った応答と今回のテンプレートの出力がずれて、その位置からキャッシュが効かなくなる。差分更新では思考を切り、応答（ops の JSON）をそのまま履歴に戻すのが安全。
- gpt-oss は推論の強さを low / medium / high で選ぶ方式で（[Ollama の gpt-oss](https://ollama.com/library/gpt-oss)）、切るのではなく low にする。

## 候補のモデル

日本語の扱いは、モデルカードの多言語の記載で判断した。Llama は外した。Llama 3.1 8B の対応言語は英・独・仏・伊・葡・ヒンディー・西・タイで日本語が無く（[モデルカードのメタデータ](https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct)）、新しい Llama 4 は Scout でも 109B の MoE で、この 2 段に入らない。

### 16GB の段（M4・16GB で実測する）

| モデル | 種類 | 4bit の大きさ | 文脈長 | ライセンス | M4 での目安（推定） |
|---|---|---|---|---|---|
| **Qwen3.5-9B** | 密。Gated DeltaNet と注意の混成 | 6.6GB（q4_K_M） | 262,144 | Apache 2.0 | 生成 13〜16 tok/s、読み込み 150 tok/s 前後 |
| **Gemma 4 12B** | 密。スライディング窓（1024）と全体注意の混成 | 7.7〜8.0GB（QAT q4_0 の GGUF あり） | 256K | Apache 2.0 | 生成 11〜12 tok/s、読み込み 110〜120 tok/s |
| Qwen3.5-4B（速さ優先の控え） | 同上 | 3.3GB（q4_K_M） | 262,144 | Apache 2.0 | 生成 25〜30 tok/s、読み込み 300 tok/s 前後 |
| Gemma 4 E4B（速さ優先の控え） | 実効 4.5B（埋め込み込み 8B） | 6.6〜9.5GB | 128K | Apache 2.0 | 生成 20 tok/s 台（推定の幅が大きい） |

- 大きさは Ollama のライブラリ（[qwen3.5](https://ollama.com/library/qwen3.5/tags)・[gemma4](https://ollama.com/library/gemma4)）、構造・文脈長・ライセンスはモデルカード（[Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)・[gemma-4-12B-it](https://huggingface.co/google/gemma-4-12B-it)）による。Qwen3.5 は 201 の言語、Gemma 4 は 35 以上の言語に対応（140 以上で事前学習）とある。
- gpt-oss-20b（14GB、MXFP4、MoE、Apache 2.0）は Ollama のページで「16GB 以上」とあるが、16GB の Mac では OS とほかのアプリと分け合うので載りきらない見込みが高い。Mac の GPU が使えるメモリには上限があり、16GB 機では物理メモリより小さい（値は未確認、実測で確かめる）。
- Gemma 4 26B-A4B（4bit で 16〜19GB）も 16GB には入らない。

**速度の推定の仕方**: llama.cpp の Apple Silicon ベンチマーク（[discussion #4167](https://github.com/ggml-org/llama.cpp/discussions/4167)）で、M4（GPU 10 コア、帯域 120 GB/s）は Llama 2 7B Q4_0（3.56 GiB）の読み込み（pp512）が 221 tok/s、生成が 24 tok/s。生成はおおむね重みの大きさに反比例し、読み込みは計算量（パラメータ数）に反比例するとして比で割った。混成アーキテクチャや MLX での差は入っていない。

**1 回の呼び出しの目安（Qwen3.5-9B、推定）**:

- query を開いた最初の呼び出し: `SYSTEM` とマップと発言で 4 千トークンとすると、最初のトークンまで約 25 秒。
- 2 回目以降: キャッシュが効けば読み込むのは変更と新しい発言の数百トークンで 2〜4 秒。ops の JSON を 150〜300 トークン出すのに 10〜20 秒。合わせて 15〜25 秒。
- 4B に下げると半分程度。いずれも、地図の「遅さへの対応」（呼び出しの間隔、溜まった発言のまとめ方）を実測で決める必要がある。

### 32GB 以上の段（未検証、公開情報から選んだ）

| モデル | 種類 | 4bit の大きさ | 文脈長 | ライセンス | ねらい |
|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B** | MoE（35B 中 3B が動く） | 22〜24GB | 262,144 | Apache 2.0 | 動く重みが 3B なので速く、品質も取れる |
| **Gemma 4 26B-A4B** | MoE（25.2B 中 3.8B が動く） | 16〜19GB | 256K | Apache 2.0 | 同上。カードは「4B 並みの速さ」と書く |
| Qwen3.8-27B | 密（混成） | 18GB（q4_K_M） | 262,144 | Apache 2.0 | 2026-08 公開の最新。品質寄り、密なので遅い |
| Gemma 4 31B | 密 | 19〜20GB | 256K | Apache 2.0 | 品質寄り |
| gpt-oss-20b | MoE、MXFP4 | 14GB | 128K | Apache 2.0 | 日本語の扱いは確かめていない |

出典: [Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B)、[gemma-4-26B-A4B-it](https://huggingface.co/google/gemma-4-26B-A4B-it)、[Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B)、Ollama の [qwen3.6](https://ollama.com/library/qwen3.6)・[qwen3.8](https://ollama.com/library/qwen3.8/tags)・[gemma4](https://ollama.com/library/gemma4)・[gpt-oss](https://ollama.com/library/gpt-oss)。

速さの目安: 同じベンチマークで M4 Pro（273 GB/s）は M4 の約 2 倍、M4 Max（546 GB/s）は約 3.4 倍の生成速度。MoE は動く重みだけ読むので、3〜4B が動くモデルは同じ機械の密な 4B に近い生成速度が見込める（推定）。

文脈長について: Qwen3.5/3.6/3.8 は 4 層のうち 1 層だけが全体注意、Gemma 4 はスライディング窓との混成なので、長い会議でも KV キャッシュのメモリが伸びにくい。どのモデルも 128K 以上あるので、14 回分の会話が文脈長で詰まることはまず無い。詰まるのは Ollama の既定 4,096 のような設定の側。

## 外への通信（ローカルモードへの影響）

| ランタイム | 推論中の内容の送信 | それ以外の通信 | 止め方 |
|---|---|---|---|
| llama.cpp server | 無い | `-hf` でモデルを取るとき Hugging Face に繋ぐ | `--offline`（キャッシュだけを使い通信しない） |
| Ollama | ローカルのモデルなら無い（「ローカルで動かす限り、プロンプトやデータは見ない」） | デスクトップアプリが 1 時間ごとに `https://ollama.com/api/update` へ、OS・CPU・版・時刻と、macOS では端末 ID を付けて問い合わせる。自動更新を切っても問い合わせは続き、止まるのはダウンロードだけ。`:cloud`/`-cloud` の付いたモデルは ollama.com で推論される | クラウドは `OLLAMA_NO_CLOUD=1` か `~/.ollama/server.json` の `disable_ollama_cloud: true`。更新確認はアプリを使わずに `ollama serve` だけで動かす（`app/updater` はデスクトップアプリの部品） |
| LM Studio | 無い（「メッセージ・履歴・文書は送らない」、テレメトリーも無い） | 起動時の更新確認で版・OS・IP。モデル検索・ダウンロード、ランタイムの確認で huggingface.co など | 更新確認を止める設定は文書に無い。有料のクラウド機能を使うと内容が送られる |
| mlx-lm server | 無い | Hugging Face からのモデル取得 | `HF_HUB_OFFLINE=1`、テレメトリーは `HF_HUB_DISABLE_TELEMETRY=1`（`DO_NOT_TRACK` も同じ） |

出典: llama.cpp の [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)（`--offline`・`-hf`）、Ollama の [FAQ](https://docs.ollama.com/faq) と [app/updater/updater.go](https://github.com/ollama/ollama/blob/main/app/updater/updater.go)（`UpdateCheckURLBase`・`UpdateCheckInterval = 60 * 60 * time.Second`・`checkForUpdate` のクエリ、「Always check for updates」のコメント）、[Ollama の gemma4](https://ollama.com/library/gemma4)（`gemma4:cloud`）、LM Studio の [App Privacy](https://lmstudio.ai/app-privacy) と [Offline Operation](https://lmstudio.ai/docs/app/offline)、Hugging Face の [環境変数](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables)。

ローカルモードの設計への含意:

- 発言やマップがランタイム経由で外へ出る経路は、Ollama のクラウドモデルと LM Studio のクラウド機能。サーバーが宛先を localhost に限っても防げない。Ollama なら、モデル名が `:cloud`・`-cloud` で終わるものを拒むか、`OLLAMA_NO_CLOUD=1` を前提にする。
- 更新確認は内容を含まないが、端末 ID や IP は出る。「何も外に出ない」をどこまで約束するか（会議の内容に限るか、通信そのものか）を決める必要がある。通信そのものまで約束するなら、llama.cpp server の `--offline` が一番言い切りやすい。

## 決めるときの材料（地図の「まだ決めていないこと」への入力）

- 第 1 のネイティブ経路は llama.cpp server か Ollama。どちらも OpenAI 互換の口 1 つで、構造化出力とプレフィックスキャッシュが揃う。Ollama は導入が楽で MLX も使えるが、文脈長・keep_alive・クラウドモデル・更新確認の 4 点を設定で潰す必要がある。mlx-lm server は外す。
- 呼び出し側でやること: `response_format` に今の `SCHEMA` をそのまま渡す、思考を切る（`chat_template_kwargs`）、messages を足していく形で ADR 0006 を写す、文脈長を明示する。スキーマを文字列でプロンプトにも入れるかは評価で決める。
- 実測で確かめること（16GB の段）: Qwen3.5-9B と Gemma 4 12B の 1 回の所要時間と、既存の回帰評価での品質。速さが足りなければ 4B 級に下げる。gpt-oss-20b が載るかどうか。
