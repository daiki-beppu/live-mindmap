# ローカルで画像を読めるモデルで共有画面を渡せるか

調査日: 2026-10-08 / チケット: [#377](https://github.com/daiki-beppu/live-mindmap/issues/377)（地図 [#374](https://github.com/daiki-beppu/live-mindmap/issues/374)）

背景: 地図 #179 で、Claude には共有画面を画像のまま（JPEG、1280×720 前後）、変わったときだけ渡すと決めた（画面を指す発言 12〜13/20、OCR の文字は 7〜8/20）。ここでは、ローカルモードでも同じことができるかを、一次情報（モデルカード・ランタイムの公式ドキュメントとソース・論文）から調べた。モデルは落としておらず、実測はしていない。数値はすべて出典のもので、手元の M4・16GB での確認は [#380](https://github.com/daiki-beppu/live-mindmap/issues/380) に回す。

## 結論

1. **ネイティブのランタイムでは渡せる。** Qwen3.5（0.8B/2B/4B/9B）、Qwen3-VL（2B/4B/8B）、Gemma 4（E2B/E4B/12B）が、Ollama・llama.cpp・LM Studio・MLX-VLM のどれでも画像を入力でき、どのランタイムでも OpenAI 互換の `/v1/chat/completions` に画像と JSON スキーマを同じリクエストで載せられる。地図 #374 の「OpenAI 互換の口 1 つ」で足りる。
2. **16GB の M4 なら、1 つのモデルで画像と差分更新の JSON の両方をこなす形しか現実的でない。** GPU が使えるメモリは 16GB のおよそ 2/3（約 10.7GB）で、差分更新用とは別に画像用のモデルを常駐させる余裕は無い。第一候補は、もとから画像と文字を一緒に学習した **Qwen3.5-9B（4bit で 6.6〜7.6GB）**、軽い側は **Qwen3.5-4B（3.3〜4.0GB）**。ただし、スキーマどおりの差分操作を出せるかは [#375](https://github.com/daiki-beppu/live-mindmap/issues/375) の結果しだい。
3. **日本語のスライド・表・グラフ**: 日本語に絞った公開評価（JAMMEval、2026-04）では Qwen3-VL-8B がオープンなモデルの首位で、文書（JDocQA）と日本語 OCR（CC-OCR-JA）では GPT-5.1 を上回った。Qwen3.5-9B/4B は、文書・グラフの英中心のベンチマークで Qwen3-VL-30B と同等以上の数値。Qwen3.5 と Gemma 4 については、**日本語に絞った公開評価が見つからなかった**。合成会議の素材（`~/live-mindmap-samples/synth/screen/`）で測るまでは推定にとどまる。
4. **画像 1 枚あたりの目安は、9B 級で 5〜10 秒、4B 級で 3〜5 秒**（M4・10 コア GPU の公開ベンチマークからの見積もり。実測ではない）。変わったときだけ送るので 1 時間 30 枚なら計算は数分だが、その呼び出しは 1 回あたりこれだけ遅れる。
5. **WebGPU では、今は勧められない。** WebLLM が画像を受けられるのは Phi-3.5-vision だけ。Transformers.js なら Qwen3.5（〜9B）と Gemma 4（E2B/E4B）を WebGPU で動かせ、JSON スキーマで縛る実験的なパッケージもあるが、日本語の画面を読む力と速度を示す公開情報は無い。
6. **代わりの手段として Apple Vision の OCR の文字は渡せる。** 文字だけなら画像を受けないモデルでも、どのランタイムでもそのまま載る。#183 で分かっている弱点（グラフで対応が崩れる）はそのまま残る。

## 1. ランタイムごとの、画像を受けられる候補

| ランタイム | 画像の渡し方 | JSON スキーマでの出力 | 16GB で乗る主な候補 |
|---|---|---|---|
| Ollama | `/api/chat` の `images`、OpenAI 互換の `image_url` | `format` に JSON スキーマ。OpenAI 互換では `response_format`。画像を使うモデルでも同じ（公式ドキュメントに画像からの抽出例がある） | `qwen3.5:4b`/`9b`、`qwen3-vl:4b`/`8b`、`gemma4:e4b`/`12b` |
| llama.cpp（`llama-server`） | 本体 GGUF と `mmproj` を読み、OpenAI 互換の `image_url` | `response_format`（`json_schema`）を文法に変換して縛る | Qwen3.5・Qwen3-VL・Gemma 4 の GGUF（`mmproj` つき）。`--image-max-tokens` で 1 枚のトークン数に上限を付けられる |
| LM Studio | OpenAI 互換の `image_url`。GGUF（llama.cpp）と MLX の両エンジン | `response_format`。GGUF は llama.cpp の文法、MLX は Outlines で縛る。「7B 未満は構造化出力ができないことがある」と注意書き | 上と同じモデルの GGUF/MLX 版 |
| MLX-VLM（`mlx_vlm.server`） | OpenAI 互換の `/v1/chat/completions` と `/v1/responses` | `json_schema` の構造化出力に対応（ストリームも可）。サーバー既定で thinking はオフ | Qwen3.5、Gemma 4 など。`mlx-community` の 4bit 版 |
| WebGPU: WebLLM | 画像を受けるのは Phi-3.5-vision だけ | JSON スキーマの文法あり | 日本語の画面を読む候補は無い |
| WebGPU: Transformers.js | `processor(prompt, image)` → `generate`（`device: "webgpu"`, `dtype: "q4f16"`） | `@huggingface/transformers-structured-output`（実験的）で JSON スキーマに縛れる | `onnx-community/Qwen3.5-{0.8B,2B,4B,9B}`、`onnx-community/gemma-4-{E2B,E4B}-it-ONNX` |

モデルの大きさ（Ollama のタグ、4bit 相当）:

| モデル | ファイル | 文脈長 | 備考 |
|---|---|---|---|
| Qwen3.5-4B | 3.3〜4.0GB | 256K | 画像と文字を事前学習から一緒に学習。201 言語。既定で thinking あり（`enable_thinking: false` で切る） |
| Qwen3.5-9B | 6.6〜7.6GB | 256K | 同上 |
| Qwen3-VL-4B / 8B | 3.3GB / 6.1GB | 256K | OCR は 32 言語。Ollama 0.12.7 以降 |
| Gemma 4 E4B | 6.6〜9.5GB | 128K | 音声も受ける。画像のトークン数を 70/140/280/560/1120 から選ぶ |
| Gemma 4 12B | 7.7〜8.0GB | 256K | エンコーダを持たない「Unified」型 |
| Gemma 4 26B A4B / 31B | 16〜20GB | 256K | 16GB には乗らない（32GB 以上の段の候補） |

## 2. 日本語のスライド・表・グラフを読む力

### 日本語に絞った評価

- **JAMMEval**（2026-04、Sugiura ほか）は、既存の日本語 VLM ベンチマーク 7 つを作り直したもの。共有画面に近いのは、官公庁の文書画像を問う **JDocQA-Refined**、日本の企業の IR 資料のグラフと表を問う **JGraphQA-Refined**、日本語の文字を読む **CC-OCR-JA-Refined**。
- 結果: 「Qwen3-VL-8B がオープンなモデルの首位で、JDocQA-Refined と CC-OCR-JA-Refined のような文字を読む課題では GPT-5.1 を上回る」。対象のオープンなモデルは Qwen3-VL-{2B,4B,8B}、InternVL3.5、Sarashina2.2-Vision-3B など。**Qwen3.5 と Gemma 4 は評価に入っていない**。
- JMMMU（日本語の専門科目）は知識寄りで、画面の読み取りとは測るものが違う。

### 英中心のベンチマークでの比較（モデルカードの値）

| | Qwen3.5-9B | Qwen3.5-4B | Qwen3-VL-30B（参考） |
|---|---|---|---|
| OCRBench | 89.2 | 85.0 | 83.9 |
| OmniDocBench1.5（文書の読み取り） | 87.7 | 86.2 | 86.8 |
| CharXiv(RQ)（グラフの読解） | 73.0 | 70.8 | 56.6 |
| CC-OCR（多言語を含む OCR） | 79.3 | 76.7 | 77.8 |
| AI2D（図） | 90.2 | 89.6 | 86.9 |

Gemma 4 のモデルカードは、画像の用途に「文書・PDF の読み取り、画面と UI の理解、グラフの読解、OCR（多言語を含む）」を挙げ、OmniDocBench 1.5 の編集距離（小さいほど良い）は E4B 0.181、12B 0.164、26B A4B 0.149。指標が Qwen と違うので直接は比べられない。OCR や小さい文字には大きいトークン数（560 か 1120）を使うよう書かれている。

### 読み

- 日本語の文書・OCR で強いと公開データで言えるのは Qwen3-VL-8B。Qwen3.5-9B/4B は同じ系統の後継で、英中心の文書・グラフの数値はさらに上なので、日本語でも同等以上の見込みが高い。ただし推定。
- グラフは #183 で OCR が崩れた場所で、画像を渡す意味がいちばん大きい。CharXiv の差（Qwen3.5-9B 73.0、Qwen3-VL-30B 56.6）から、グラフは Qwen3.5 のほうが有利と読める。
- Gemma 4 E4B は MMMU Pro 52.6% と、同じ大きさの Qwen3.5-4B（66.3）より低い。日本語の画面を読む候補としては、Qwen3.5 の後ろに置く。

## 3. 16GB の M4 で差分更新のモデルと兼ねられるか

- **メモリ**: macOS は GPU（Metal）に回すメモリを物理メモリの約 2/3〜3/4 に抑え、16GB では約 10.7GB が目安（`recommendedMaxWorkingSetSize`。`sysctl iogpu.wired_limit_mb` で上げられる）。参考に、Qwen3-VL-8B の **8bit** を M4（10 コア、32GB）で動かしたピークは、文脈 1k で 9.7GB、16k で 11.9GB（oMLX のコミュニティ計測）。16GB では 4bit が前提。
- **2 つ常駐は無理**: 差分更新の文字のモデル（〜7GB）と画像のモデル（〜4〜7GB）を同時に置くと上限を超える。読み替えのたびにモデルを入れ替える形も、数秒〜十数秒の読み込みが会議中に入るので向かない。
- **1 つで兼ねる形は、仕組みの上ではどのランタイムでもできる**: 画像を受けるモデルに、画像と JSON スキーマ（`format` / `response_format`）を同じリクエストで渡せる（§1 の表）。Qwen3.5 はもとから画像と文字を一緒に学習したモデルで、文字だけの用途にもそのまま使える。地図 #374 の「差分更新のモデル」を Qwen3.5 にすれば、画像を受けるために別のモデルは要らない。
- **注意点**
  - Qwen3.5 は既定で thinking が付く。差分更新では `enable_thinking: false`（Ollama は `think: false`、MLX-VLM はサーバー既定でオフ）にしないと、遅くなるうえ、文法で縛る出力と衝突しやすい。
  - LM Studio は「7B 未満は構造化出力ができないことがある」と書いている。4B を使うなら、スキーマどおりに出るかを #375 と #380 で確かめる。
  - 小さいモデルにとって、画像を足すことは文脈が数百〜千トークン増えることでもある。ADR 0006 の「開いたまま変更だけ送る」と組み合わせたとき、画像を含むプレフィックスがキャッシュに乗り続けるか（llama-server の prompt cache、MLX-VLM の prefix cache）は #378 と合わせて詰める。

## 4. 画像 1 枚あたりの処理時間の目安

実測ではない。公開の数値から見積もった。

- **画像のトークン数**: Qwen3.5 / Qwen3-VL は 16px のパッチを 2×2 でまとめ、1 トークンが 32×32px。1280×720 は約 40×23 = **約 920 トークン**（Claude の 1,196 トークンとほぼ同じ量）。llama.cpp の `--image-max-tokens` や Qwen の `max_pixels` で減らせる（640×360 なら約 230）。Gemma 4 は 70〜1120 から選ぶ固定の予算。
- **プレフィル（読み込み）の速さ**: M4（10 コア GPU、120GB/s）で 7B の Q4_0 は約 221 トークン/秒（llama.cpp の Apple Silicon 計測）。Qwen3-VL-8B 8bit の MLX は 1k 文脈で 217 トークン/秒（oMLX）。
- **画像を符号化する時間**: M4 Max（40 コア GPU）で Qwen3-VL-4B の 1024×1024 が初回約 2.1 秒（vllm-mlx の論文）。M4（10 コア）はおよそ 4 倍遅いとみて、1〜数秒。
- **見積もり**: 9B 級で 920 トークン ÷ 約 200 トークン/秒 ≒ 4.5 秒 ＋ 符号化 1〜数秒 → **1 枚 5〜10 秒**。4B 級はその半分程度で **3〜5 秒**。640×360 に縮めればさらに 1/3〜1/4。
- **差分更新に足される遅れ**: 画像が付く呼び出しだけ、上の時間が上乗せされる。出力の生成（9B Q4 で 20 トークン/秒前後）は画像の有無で変わらない。#251 の「変わったときだけ、1 回に最大 3 枚」だと、3 枚付いた呼び出しは 15〜30 秒延びうる。ローカルでは上限を 1 枚にするか、縮めて送るかを決める必要がある（地図 #374 の「遅さへの対応」）。
- 同じ画像をもう一度載せる場合は、プレフィックスキャッシュが効けば符号化と読み込みを省ける（vllm-mlx の論文では 2 回目は 1 秒前後）。開き直しで「今と直前の 1 枚を送り直す」（#251）ときにだけ効く。

## 5. Apple の Foundation Models（参考）

WWDC26 で、OS 内蔵の Foundation Models の端末上のモデルが画像を受けられるようになった（`Attachment(NSImage)` などをプロンプトに添える。大きい画像ほどトークンと時間を使う）。ダウンロードが要らず、Swift のヘルパーから呼べ、`@Generable` で型どおりに出せる。ただし文脈は 8,192 トークンで、画像 1 枚とマップと発言を一緒に載せる差分更新には狭い。日本語の画面を読む力の公開評価も見つからなかった。差分更新のモデルの候補ではなく、「画像を短い文字にしてから差分更新のモデルに渡す」前処理の候補として、試す価値はある。

## 6. 画像を読めないときの代わり: Apple Vision の OCR の文字

- #181 で、Apple Vision（accurate / `RecognizeDocumentsRequest`）は 640×360 でも日本語と表を読めると確認済み。文字は画像を受けないモデルにも、どのランタイム（WebLLM を含む）にもそのまま載る。
- トークンも画像より少なく、ローカルでは画像より速い。ただし #183 のとおり、グラフでは対応が崩れて間違った数字を出した（画面を指す発言 7〜8/20、画像は 12〜13/20）。
- したがって、ローカルでは「画像を受けるモデルなら画像、受けないモデル（WebLLM の文字のモデルなど）なら OCR の文字」に分けられる。どちらを渡したかはログに残し、#380 の回帰評価で比べる。

## 未確認のこと（#380 で測る）

- Qwen3.5-9B / 4B が、合成会議の素材のスライド 8 枚（日本語のグラフと表）を、画面を指す発言で正しく使えるか。Claude の 12〜13/20 にどこまで近づくか
- 画像を付けたまま、差分操作がスキーマどおりに出るか（4B で特に）
- M4・16GB での実際の 1 枚あたりの時間と、ピークのメモリ
- Transformers.js（WebGPU）の Qwen3.5-4B で、1 枚にかかる時間

## 出典

- Qwen3.5-9B モデルカード: https://huggingface.co/Qwen/Qwen3.5-9B
- Qwen3.5-4B モデルカード（画像ベンチマークの表）: https://huggingface.co/Qwen/Qwen3.5-4B
- Qwen3.5 の画像の前処理（patch_size 16、merge_size 2）: https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/preprocessor_config.json
- Qwen3-VL README（32 言語の OCR、32 倍の圧縮）: https://github.com/QwenLM/Qwen3-VL
- Gemma 4 モデルカード: https://ai.google.dev/gemma/docs/core/model_card_4
- Gemma 4 E4B（ONNX、WebGPU の例とトークン予算）: https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX
- Ollama のモデル: https://ollama.com/library/qwen3.5 、https://ollama.com/library/qwen3-vl 、https://ollama.com/library/gemma4
- Ollama の構造化出力: https://docs.ollama.com/capabilities/structured-outputs
- llama.cpp の画像入力: https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md
- llama-server（`--image-max-tokens`、`response_format`）: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Qwen 公式の Qwen3-VL-8B GGUF（`mmproj` つき）: https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF
- LM Studio の構造化出力: https://lmstudio.ai/docs/developer/openai-compat/structured-output
- MLX-VLM README（サーバー、`json_schema`、thinking の既定）: https://github.com/Blaizzy/mlx-vlm
- WebLLM のモデル一覧（VLM は Phi-3.5-vision のみ）: https://github.com/mlc-ai/web-llm/blob/main/src/config.ts
- Transformers.js の対応モデル: https://github.com/huggingface/transformers.js
- Transformers.js の構造化出力: https://github.com/huggingface/transformers.js/tree/main/packages/transformers-structured-output
- JAMMEval（日本語 VLM 評価、2026-04）: https://arxiv.org/abs/2604.00909
- llama.cpp の Apple Silicon 計測: https://github.com/ggml-org/llama.cpp/discussions/4167
- oMLX の計測（Qwen3-VL-8B 8bit、M4 10 コア 32GB）: https://omlx.ai/benchmarks/il1sgnsw
- vllm-mlx の論文（M4 Max での画像の符号化とキャッシュ）: https://arxiv.org/abs/2601.19139
- Metal の `recommendedMaxWorkingSetSize`: https://developer.apple.com/documentation/metal/mtldevice/recommendedmaxworkingsetsize
- WWDC26「Foundation Models」の画像入力: https://developer.apple.com/videos/play/wwdc2026/241/
