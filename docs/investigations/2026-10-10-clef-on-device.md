# Clef の重みを Mac の端末内で動かせるか（Issue #759）

地図 #757 の問い。Cloudflare の Clef / Clef-flash（判定専用の System One モデル）の重みを、利用者の Mac（Apple Silicon）の中で動かせるかを、一次情報（Cloudflare の changelog・ブログ・Workers AI のモデルページ、Hugging Face のモデルカードとファイル一覧、llama.cpp の PR）で調べた。重みは落としていないので、**この Mac での実測は無い**。速さ・メモリの数字は、変換した人がモデルカードに載せた値（自己申告）と、そこからの見積もりである。調べた日は 2026-10-10。

## 結論

- **動かせる。ただし実用の候補は Clef-flash（9B）の 4-bit だけ。** 重みは Apache-2.0 で Hugging Face に公開されており、MLX・llama.cpp・Core ML のどれにも、判定の頭（joint schema head）まで動かす変換が既にある。Clef（27B）は 4-bit でも 32GB 以上の Mac が要り、1k トークンで M5 Max でも 1.4 秒かかるので、端末内の候補から外してよい。
- **メモリ**: Clef-flash 4-bit は重み約 5〜6GB、ピーク 7.0GB（1k トークン）〜8.6GB（16k）。変換した人の案内は「16GB の Mac が下限」。16GB の Mac では、Apple Intelligence（ADR 0012）・SpeechAnalyzer・会議アプリ・Chrome と同居するので、取り合いで遅れる恐れが高い（16GB の M4 で Qwen3.5-4B がメモリの取り合いで遅れが溢れた前例が ADR 0012 にある）。**24GB 以上で余裕、16GB は実測しないと判断できない。**
- **1 回の応答時間の見込み**: 数百トークンの入力で、M5 Pro / M5 Max では 0.3〜0.9 秒（自己申告の実測）。この Mac と同じ **16GB の M4（無印）では 1〜3 秒程度と見積もる**（GPU のコア数の差からの推定で、実測ではない）。Workers AI 上の Clef-flash の中央 38.8 ms より 1〜2 桁遅いが、話し終わりからノードまでの p50 12.5 秒（#757）に対しては小さい。
- **置き場所**: ヘルパーに入れず、サーバーが起動する**別の子プロセス**にして、ループバックで Jev 互換の `/v1/systemone` を出させる形が、ADR 0012（推論は子プロセス）・0014（ローカルモードは自前の子プロセスだけ）・0017（重い依存は管理ディレクトリ）と噛み合う。重みは `cli install` で `~/.live-mindmap/deps/` に入れる。
- **未確認で、採否に効くもの**: 日本語の発言での判定の質（モデルカードに言語の記載が無い）と、16GB の Mac で会議と同居したときの遅れ。どちらもこの Mac で 1 度測れば分かる（「次に測ること」）。

## 重み・ライセンス・大きさ

| | Clef | Clef-flash | Clef-omni（参考） |
|---|---|---|---|
| 公開先 | [Cloudflare/clef](https://huggingface.co/Cloudflare/clef) | [Cloudflare/clef-flash](https://huggingface.co/Cloudflare/clef-flash) | [Cloudflare/clef-omni](https://huggingface.co/Cloudflare/clef-omni) |
| ライセンス | Apache-2.0 | Apache-2.0 | Apache-2.0 |
| 元のモデル | Qwen3.8-27B を事後学習 | Qwen3.5-9B を事後学習 | Qwen3-Omni-30B-A3B（MoE）を事後学習 |
| パラメータ（HF の safetensors 集計） | 27,356,728,560（BF16） | 9,409,813,744（BF16） | 35,259,818,545 |
| リポジトリの合計 | 約 55.0GB | 約 19.1GB | 約 70.8GB |
| 判定の頭（`joint_head.safetensors`） | 256MB | 244MB | — |
| 入力 | テキスト・JSON・画像・動画 | テキスト・JSON・画像・動画 | 上に加えて音声 |

出典: Hugging Face の API（`/api/models/Cloudflare/<名前>?blobs=true`）のファイル一覧と `safetensors.parameters`、各モデルカード。公開は [Workers AI の changelog（2026-10-01）](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/)が「Apache 2.0 で Hugging Face に重みを公開する」と書いている。Clef-omni は [2026-10-09 の changelog](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/) で追加された。

- **オープンなのは重みとコードだけ**で、学習データは公開されていない（[ブログ](https://blog.cloudflare.com/clef-decision-models/)は「社内の合成データ」と書く）。
- 起点にした [cloudflare.com/resource/clef-rl-interest](https://www.cloudflare.com/resource/clef-rl-interest/) は、強化学習の微調整サービスの申込フォームで、重みの事実は載っていない。

## 仕組み（端末内で動かすときに効くところ）

[モデルカード](https://huggingface.co/Cloudflare/clef-flash)と[ブログ](https://blog.cloudflare.com/clef-decision-models/)による。

- 文章を生成しない。入力（state と、型付きの問い）を **1 回の前向き計算（prefill だけ）** で読み、Qwen の最終の隠れ状態を小さな transformer の頭が読んで、問いごとに選択肢 1 つにつき 1 つの logit を出す。問いごとに softmax して確率にする。問いの型は `noul`（真偽）・`choice`・`score`（順序つき）。
- このため**速さを決めるのは prefill（計算量）で、生成の速さ（メモリ帯域）ではない**。入力のトークン数にほぼ比例して遅くなる。
- 公式の実行コードは `joint_schema_model.py`（PyTorch、`load_release_model(path, device="cuda")`）。動作確認は torch 2.11・transformers 5.10.2・H200 1 枚。**Mac（MPS・MLX）への言及は公式には無い。**
- 公式の推論サーバーは SGLang（`lmsysorg/sglang:dev-clef`）で、Jev 互換の `/v1/systemone` を出す。手順は H200 / B200 / B300 向け。
- 入力の上限: 参照実装の `encode_record` は既定 `max_length` 16,384 トークン（頭もこの長さで学習）。Workers AI の [Clef-flash のページ](https://developers.cloudflare.com/workers-ai/models/clef-flash/)は文脈長 24,576 トークン、[ブログ](https://blog.cloudflare.com/clef-decision-models/)は Clef を 64k と書いており、数字が揃っていない。端末内では 16k を上限と見ておく。
- 汎用の生成ツール（`mlx_lm.generate`・LM Studio・Ollama）は背骨だけを読み込んで意味のない文章を出す。**判定の頭を動かす専用の経路が要る**（[mlx-community/clef-flash-4bit](https://huggingface.co/mlx-community/clef-flash-4bit) の Limitations）。

### 「41GB の VRAM が要る」について

The Register など二次の報道は、Cloudflare の PM が「Clef-flash は 41GB 以上、Clef は 85GB 以上の GPU で動く」と述べたと伝えている（例: [korben.info](https://korben.info/en/cloudflare-launches-clef-open-weight-decision-models-vs-jev.html)）。報道では**同時 1 件・64k の文脈を前提**にした BF16 の数字で、一次情報（モデルカード・ブログ）には最小の VRAM は書かれていない。4-bit・数千トークンで使う端末内の話には当てはまらない（下の実測値を参照）。

## Mac で動かす手段

Hugging Face の `base_model:quantized:Cloudflare/clef-flash` に 40 件近い変換がある。判定の頭まで動かし、Apple Silicon で測った値を載せているのは次の 3 系統。**どれも Cloudflare 公式ではない第三者の変換**で、MLX 版は Python の実行コード（`clef_mlx.py`）を同梱する。

### MLX（Python）: mlx-community/clef-flash-4bit ほか

[mlx-community/clef-flash-4bit](https://huggingface.co/mlx-community/clef-flash-4bit) のモデルカードの値（M5 Max、テキスト入力）:

| 版 | 元 | 取得 | ピークメモリ（1k / 4k / 16k トークン） | 応答（1k / 16k トークン） | Mac の RAM の下限 |
|---|---|---|---|---|---|
| clef-flash-4bit | 9B | 6.2GB | 7.0 / 7.2 / 8.6GB | 0.31 秒 / 7.0 秒 | 16GB |
| clef-flash-8bit | 9B | 10.7GB | 11.4 / 11.6 / 13.0GB | 0.34 秒 / 7.7 秒 | 24GB（短い入力なら 16GB） |
| clef-4bit | 27B | 16.3GB | 17.1 / 17.5 / 19.6GB | 1.4 秒 / 26.0 秒 | 32GB |
| clef-8bit | 27B | 29.8GB | 30.5 / 30.8 / 33.0GB | 1.5 秒 / 32.0 秒 | 48GB |

- RAM の下限がピークより高いのは、macOS が既定で GPU に使わせるのが RAM の約 70〜75% だから、とカードは書いている。
- 質: 公式の PyTorch（bf16）との突き合わせで、テキスト 10 問の最上位の答えが 10/10 一致。Decision Index の抜き取り 2,000 件で、4-bit は 54.65、MLX の bf16 は 55.63（約 1 点の低下）、答えの一致 96.4%。
- 使い方: `pip install "mlx-vlm>=0.7.4,<0.8"`（torch は不要）。`python clef_mlx.py serve --port 8000` で、ループバックに Jev / SystemOne 互換の `POST /v1/systemone` を立てられる。1 件ずつ順に処理し、認証は無い。
- カード自身が「無印の M シリーズでは長い入力が数倍遅い」と注意している。

### MLX（Swift）: speech-swift の `Clef`

[aufklarer/Clef-flash-9B-MLX-4bit](https://huggingface.co/aufklarer/Clef-flash-9B-MLX-4bit) は、[soniqo/speech-swift](https://github.com/soniqo/speech-swift)（Apache-2.0）の `Clef` ライブラリで動かす版。テキストのみ、重み 5.04GB + 頭 244MB。

- M5 Pro 48GB・release ビルド・303 トークン・3 問で、温まった後の中央 **0.918 秒**、最初の 1 回 4.02 秒。Python 参照とのトークン列は 303/303 一致、確率の差は最大約 0.003。
- 2026-10-02 時点で「開発プレビュー、未リリース」。メモリと p95 は測っていない、と書いている。

### Core ML（Swift）: FluidInference/clef-flash-coreml

[FluidInference/clef-flash-coreml](https://huggingface.co/FluidInference/clef-flash-coreml)（2026-10-10 公開）。テキストのみ、8-bit 重み、Mac の GPU で動く。実行は [FluidInference/FluidUse](https://github.com/FluidInference/FluidUse) の `ClefFlashManager`（Swift、macOS 15+、Apache-2.0）。

- 構成: デコーダを 4 層ずつ 8 個の `.mlpackage`（計 6.5GB）、頭 465MB（問い 16・選択肢 96 まで）、入出力の埋め込み各 2.0GB。入力長は 256 / 512 / 1024 / 2048 トークンのバケツ。
- M5 Pro 24GB・GPU で、約 370 トークン・3 問の 1 件が中央 **0.49 秒**（p95 0.57 秒）。読み込み約 40 秒。
- 「デコーダだけで約 7GB を占め、ほかに大きなプロセスがあるとページングして急に遅くなる」「Qwen3.5 の Gated DeltaNet 層は Neural Engine で動かない（ANE に載る演算は 0）」と書いている。**ANE で省メモリ・低消費電力に回す道は無い。**
- 質: fp32 参照との比較で 611 問中の不一致 1（僅差のもの）。ARC-Easy 100.0%、ARC-Challenge 99.0%。

### llama.cpp

- [ggml-org/llama.cpp#29831](https://github.com/ggml-org/llama.cpp/pull/29831)「model: add support for clef decision model (text-only)」が **2026-10-03 にマージ済み**。選択肢の区間の平均を取るため、新しい API（`llama_batch_ext_set_decision_order`）を足している。既知の制限は、画像は未対応・1 バッチ 1 系列。
- 重みは [ggml-org/Clef-Flash-GGUF](https://huggingface.co/ggml-org/Clef-Flash-GGUF)（Q4_K_M 6.5GB、Q8_0 9.7GB）。`llama serve -hf ggml-org/Clef-Flash-GGUF` で `/v1/systemone` を出す。
- Mac での速さ・メモリの値は、一次情報には見当たらなかった。また、node-llama-cpp がこの新しい API に追随しているかは確かめていない（ADR 0012 で見送った node-llama-cpp の経路をそのまま使えるとは限らない）。
- 同じ名前の GGUF でも、bartowski などの汎用の量子化は Clef 対応の llama.cpp を前提にしているかがカードから読めない。使うなら ggml-org の版にする。

## この Mac（16GB の M4 無印）での見込み

この作業をした Mac は `Apple M4`・16GB（`sysctl`）。上の値はどれも M5 Pro / M5 Max なので、そのままは使えない。

- **メモリ**: Clef-flash 4-bit のピーク 7〜8.6GB は、16GB の GPU の既定の上限（約 11〜12GB）には収まる。しかし会議中は SpeechAnalyzer・Apple Intelligence（ローカルモードの差分更新）・会議アプリ・Chrome が同居する。Core ML 版のカードが書くページングと、ADR 0012 の 16GB M4 でのメモリの取り合いの前例から、**16GB では会議と同居したときの遅れが読めない**。8-bit（ピーク 11.4GB〜）は 16GB では外す。
- **速さ（見積もり）**: prefill は GPU の計算量で決まる。M4 無印の GPU は 10 コアで、M5 Pro / Max（約 16〜40 コア、加えて M5 は GPU コアごとに行列演算の加速器を持つ）より数倍遅い。数百トークン・数問の判定で **1〜3 秒程度**、1k トークンで 2〜5 秒程度と見る。これは推定で、測っていない。
- 判定の入力を短く保つ（直近の発言だけ、数百トークン）ほど端末内でも速い。16k 近い入力は M5 Max でも 7 秒かかるので、端末内では使えない。

## live-mindmap に載せるときの置き場所

既存の ADR に沿うと、次の形になる。

1. **サーバーが起動する子プロセスにする（ヘルパーには入れない）。** ヘルパーは音声の取り込み・AEC3・SpeechAnalyzer を担う常駐プロセスで、7GB 級のモデルを同じプロセスに入れると、落ちたときや取り合いのときに字幕まで止まる。ADR 0012 は推論を子プロセスに分ける理由として「落ちても失うのは差分更新だけ」を挙げており、判定も同じ扱いにできる。
2. **口は Jev 互換の `/v1/systemone` にする。** 上の 3 系統（`clef_mlx.py serve`・`llama serve`、Swift 版は自前で包む）はどれも Jev / SystemOne の要求と応答の形をそのまま出す。地図 #757 の「差し替えられる 1 つの口」を Jev の形にしておけば、Workers AI の Clef・Jev・端末内の Clef を、宛先の違いだけで切り替えられる。
3. **ローカルモードで使えるのは自前の子プロセスだけ（ADR 0014）。** 利用者が別に立てた `llama serve` や `clef_mlx.py serve` は、ループバックでも、ローカルモードの判定には使えない。live-mindmap が起動した子のポートであることを開始時に確かめる。
4. **重みと実行環境は管理ディレクトリに固定版で入れる（ADR 0017）。** 4-bit で 5〜7GB あるので、通常の依存には入れず、`cli install` で `~/.live-mindmap/deps/` に入れ、`start` の前の確かめで欠けを exit 3 で知らせる。第三者の変換なので、リポジトリのコミットの sha を固定し、同梱の Python は読んでから使う。Cloudflare の重みから自分で変換する（`mlx_vlm.convert -q --q-bits 4 --q-group-size 64`、頭はそのままコピー、と mlx-community のカードにある）のも手。
5. **実行環境の候補**: ヘルパーと同じ Swift で揃えるなら、speech-swift の `Clef`（MLX Swift、開発プレビュー）か FluidUse の `ClefFlashManager`（Core ML）を包んだ小さな Swift の実行ファイル。Python を利用者の Mac に持ち込まずに済む。最短で測るだけなら `clef_mlx.py serve`。llama.cpp は Mac での実測値が無い。
6. **Mac によっては判定の段を省く。** 16GB で遅れが溢れる場合や、Apple Intelligence と同時に載らない場合は、地図 #757 の決定どおり判定の段を省いて動かす。RAM で分けるなら、24GB 以上を端末内 Clef の対象にするのが変換者の案内と合う。

## 次に測ること（未確認）

- **日本語の判定の質**: モデルカード・ブログに対応言語の記載が無い。背骨の Qwen3.5 は多言語だが、Clef の事後学習は社内の合成データで、日本語の会議の発言で判定が保たれるかは分からない。合成会議の素材で、Workers AI の Clef-flash と端末内の 4-bit を同じ問いで比べる。
- **16GB の M4 での遅れとメモリ**: `mlx-community/clef-flash-4bit` を入れ、数百トークン・数問の判定を、会議（SpeechAnalyzer と Apple Intelligence が動いている状態）と同居させて p50 / p90 を測る。単独と同居の両方。
- **常駐のコスト**: 読み込みに Core ML 版で約 40 秒、MLX Swift 版で最初の 1 回 4 秒。ADR 0012 と同じく、`start` で読み込んでからセッションを始める形が要る。

## 出典

- Cloudflare: [Clef の発表（Workers AI changelog, 2026-10-01）](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/)、[Clef-omni（changelog, 2026-10-09）](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/)、[ブログ: clef-decision-models](https://blog.cloudflare.com/clef-decision-models/)、[Workers AI: Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)、[RL の申込ページ](https://www.cloudflare.com/resource/clef-rl-interest/)
- Hugging Face（公式）: [Cloudflare/clef](https://huggingface.co/Cloudflare/clef)、[Cloudflare/clef-flash](https://huggingface.co/Cloudflare/clef-flash)、[Cloudflare/clef-omni](https://huggingface.co/Cloudflare/clef-omni)
- Hugging Face（第三者の変換）: [mlx-community/clef-flash-4bit](https://huggingface.co/mlx-community/clef-flash-4bit)、[aufklarer/Clef-flash-9B-MLX-4bit](https://huggingface.co/aufklarer/Clef-flash-9B-MLX-4bit)、[FluidInference/clef-flash-coreml](https://huggingface.co/FluidInference/clef-flash-coreml)、[ggml-org/Clef-Flash-GGUF](https://huggingface.co/ggml-org/Clef-Flash-GGUF)
- llama.cpp: [PR #29831](https://github.com/ggml-org/llama.cpp/pull/29831)
- 二次（41GB の発言の出どころ）: [korben.info](https://korben.info/en/cloudflare-launches-clef-open-weight-decision-models-vs-jev.html)、[The Register](https://www.theregister.com/a/5300649)
- リポジトリ内: ADR 0012・0014・0017、地図 #757
