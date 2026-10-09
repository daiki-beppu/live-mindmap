# ローカル向けの形で Haiku 5.5 を呼ぶ口があるか

調べた日: 2026-10-10。issue [#695](https://github.com/daiki-beppu/live-mindmap/issues/695)（地図 [#612](https://github.com/daiki-beppu/live-mindmap/issues/612)）の調査。

一次情報（Anthropic の公式ドキュメント platform.claude.com と code.claude.com、それにこのリポジトリのソース）だけを根拠にした。API は呼んでおらず、実測はしていない。

## 結論

- **Anthropic の OpenAI 互換エンドポイントには、そのままは向けられない**。`/v1/chat/completions` の互換層は `response_format` を「Ignored」と明記しており、json_schema も `enum` も効かない。関数呼び出しの `strict` も無視される。エラーにならず黙って無視されるので、向けると「スキーマに縛られていない JSON らしきもの」が返る。加えて prompt caching が無く、effort を渡す口も文書に無い。文書自体が「試して比べるためのもので、本番向けではない」としている。
- **Claude の経路なら、ローカル向けの形を毎回 1 から送れる**。
  - Agent SDK: 呼び出しのたびに `query()` を新しく作り、ローカル向けの形のプロンプトを 1 通だけ流して閉じればよい（今の `layerClaude` のように開いた query を使い回さない）。`outputFormat: {type: "json_schema", schema}` は `enum` を扱い、SDK が出力を検証して、合わなければ出し直させる。画像を添えるには、文字列ではなく `AsyncIterable` で 1 通だけ流す形（streaming input）にする。毎回サブプロセスを起動する分の時間は `startup()` で前もって払える。
  - Messages API を直接呼ぶ: `output_config.format` の json_schema は制約付きデコードで、`enum`（文字列・数値・真偽・null）を扱う。`claude-haiku-5-5` は対応モデルに入っている。画像・prompt caching・`output_config.effort` もそのまま使える。ただし仕様 #660 の 3 つの経路（Claude・OpenAI 互換・ChatGPT）のどれでもない運び手を足すことになる。
- **どちらの Claude の経路でも、`enum` の中身が回ごとに変わることに注意がいる**。親の id を回ごとの `enum` に縛ると、スキーマが毎回変わる。Messages API の構造化出力は、スキーマが変わるたびに文法をコンパイルし直し（初回は遅い）、`output_config.format` を変えるとそのやり取りの prompt cache が無効になると書かれている。1 回あたりの遅れと、キャッシュがどこまで効くかは実測で確かめる必要がある。

## 前提: ローカル向けの形が要ること

仕様 [#660](https://github.com/daiki-beppu/live-mindmap/issues/660) と [#664](https://github.com/daiki-beppu/live-mindmap/issues/664) から。

- 会話は続けず、毎回 1 から呼ぶ。サーバーが発言を文に切り、モデルは文ごとに種類を選ぶ
- 出力の親・論点・根拠などの id は、その回で使える id だけの `enum` に縛る。仮 id はサーバーが振る
- OpenAI 互換の口は `effect/http` で `/v1/chat/completions` を直接呼び、`response_format: json_schema` を使う。ランタイムの癖は設定の追加 body で吸収する
- 画像は設定の `images` が真のときだけ添える

今の Claude の経路（`server/src/claude.ts` の `layerClaude`）は、会議ごとに `query()` を 1 つ開いて使い回し、`outputFormat: {type: "json_schema", schema: OUTPUT_SCHEMA}` と `FORCE_PROMPT_CACHING_5M=1` を付けている。

## OpenAI 互換エンドポイント（`https://api.anthropic.com/v1/`）

出典: [OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)

| 確かめたいこと | 文書の記述 | ローカル向けの形への影響 |
|---|---|---|
| 位置づけ | 「primarily intended to test and compare model capabilities, and is not considered a long-term or production-ready solution for most use cases」 | 本番の経路として頼るものではない |
| `response_format`（json_schema） | Request fields の表で `response_format` は「Ignored. For JSON output, use Structured Outputs with the native Claude API」 | **効かない**。スキーマも `enum` も伝わらない |
| `strict` | 「The `strict` parameter for function calling is ignored, which means the tool use JSON is not guaranteed to follow the supplied schema」 | 関数呼び出しに逃がしても縛れない |
| 無視の仕方 | 「Most unsupported fields are silently ignored rather than producing errors」 | エラーで気づけない。出力の検証だけが頼り |
| 画像 | user の `content` の `image_url` は `url` が「Fully supported」、`detail` は Ignored。base64 の data URL については書かれていない | URL の画像は渡せる。data URL は文書では未確認 |
| prompt caching | 「Prompt caching is not supported」 | 毎回 1 から呼ぶ形では、システムプロンプトが毎回全額 |
| thinking | 追加 body の `thinking` を渡せる（文書の例は `extra_body={"thinking": {...}}`）。ただし「the OpenAI SDK doesn't return Claude's thinking」 | thinking の設定は渡せる。Haiku 5.5 は `{type: "disabled"}` を既定の `medium` でも受けるので、考える量を減らす口はこれだけ（文書の例は `budget_tokens` だが、Haiku 5.5 では 400 になる） |
| effort | `reasoning_effort` は Ignored。`output_config` を渡せるとは書かれていない | effort を下げる口が文書に無い。Haiku 5.5 の既定（`medium`）で動くことになる |
| system メッセージ | system と developer は全部つなげて先頭の `system` に寄せられる | 1 から呼ぶ形なら影響しない |
| 料金 | 互換層の別料金の記述は無い。料金ページにも互換層の項目は無い | 通常の Haiku 5.5 の単価（下の表） |
| レート制限 | 「Rate limits follow Anthropic's standard limits for the `/v1/messages` endpoint」 | Messages API と同じ |
| `usage` | `prompt_tokens`・`completion_tokens` は返る。`prompt_tokens_details` は常に空 | キャッシュの内訳は取れない |

## Claude の経路 1: Agent SDK で毎回 1 から呼ぶ

出典: [Agent SDK reference - TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)、[Get structured output from agents](https://code.claude.com/docs/en/agent-sdk/structured-outputs)、[Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

- `outputFormat`: `{ type: 'json_schema', schema: JSONSchema }`。「the SDK validates the output against it, re-prompting on mismatch」。検証が retry の上限まで通らなければ、結果は `error_max_structured_output_retries` になる
- 対応するスキーマ: 「all basic types ..., `enum`, `const`, `required`, nested objects, and `$ref` definitions」。細かい制限は API の [JSON Schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations) を参照とある。スキーマは JSON Schema draft-07 で検証される
- この文書は、SDK の `outputFormat` が API の制約付きデコードで縛るとは書いていない。書いてあるのは「検証して出し直させる」こと。`enum` 外の id は、検証で弾かれて出し直しになるか、上限で失敗になる。通った出力が `enum` の外になることは無い
- 毎回 1 から呼ぶ: 呼び出しごとに `query()` を作り、1 通流して結果を受けたら閉じる。`persistSession: false`（既定は `true`）で会話を残さない
- 画像: 文字列の prompt（Single Message Input）は「Direct image attachments in messages」に対応しない。画像を添えるときは、prompt を `AsyncIterable<SDKUserMessage>` にして 1 通だけ流し、すぐ終える（今のコードと同じ渡し方で、使い回さないだけ）
- 起動の時間: `query()` のたびに CLI のサブプロセスを起動する。`startup()` は「Pre-warms the CLI subprocess by spawning it and completing the initialize handshake before a prompt is available」で、次の呼び出し用に前もって起こしておける。`prewarm()` の予備は 1 つで 230〜260MB ほどのメモリを持つ
- effort と thinking: Options に `effort`（`low`〜`max`）と `thinking`（既定は対応モデルで `{ type: 'adaptive' }`）がある

## Claude の経路 2: Messages API を直接呼ぶ

出典: [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

- 対応モデルの一覧に `claude-haiku-5-5` がある。Claude API で GA
- 「Structured outputs guarantee schema-compliant responses through constrained decoding」
- `enum` は「strings, numbers, bools, or nulls only - no complex types」で対応。`const`・`anyOf`・`$ref` も使える。`additionalProperties` は `false` 必須。数値・文字列の長さの制約（`minimum`・`maxLength` など）と、`minItems` の 0・1 以外は 400 になる
- 例外: 拒否（`stop_reason: "refusal"`）と `max_tokens` 到達では、スキーマに合わないことがある。また `enum` の文字列は大文字・小文字が保証されない（「Compare enum values case-insensitively」）。id を英小文字と数字だけにしておけば影響しにくい
- 複雑さの上限: optional の項目は全体で 24 個まで、`anyOf` や型の配列を使う項目は 16 個まで。超えると 400
- 文法のキャッシュ: 「The first time you use a specific schema, there is additional latency while the grammar compiles」。コンパイルした文法は最後に使ってから 24 時間キャッシュされ、スキーマの構造を変えると無効になる。名前と description だけの変更なら無効にならない
- prompt cache との関係: 構造化出力は形式を説明するシステムプロンプトを足し、「Changing the `output_config.format` parameter will invalidate any prompt cache for that conversation thread」
- 画像（`image` の base64 ブロック）・prompt caching・`output_config.effort` は Messages API の通常の機能として使える
- thinking との関係: 「Grammars apply only to Claude's direct output, not to ... thinking」。考えた後の最終出力だけが縛られる

### 回ごとの `enum` が変わる影響

ローカル向けの形は、親の id の `enum` を回ごとに作るので、スキーマが毎回少しずつ変わる。上の文書からは次のことが言える。

- 毎回、文法のコンパイルが走る可能性が高い。初回の遅れがどれくらいかは書かれていない
- `output_config.format` が変わるので、その回の prompt cache が効かない可能性がある。足されるシステムプロンプトがどこに入るかは書かれていない

逃げ道は 2 つ考えられる（どちらも未検証）。

1. スキーマでは id を `string` にとどめ、`enum` で縛らずにサーバーで検証する
2. `enum` をやめて、その回の id 一覧をプロンプトに載せる（中身が変わるのは messages の側だけになる）

どちらもローカル向けの形の「列挙型に縛る」を緩める。採るかは、遅れとキャッシュを実測してから決める。

## 料金（Claude Haiku 5.5）

出典: [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)、[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

| 区分 | 入力 | 5 分キャッシュ書き込み | 1 時間キャッシュ書き込み | キャッシュ読み込み | 出力 |
|---|---|---|---|---|---|
| プロンプト 10 万トークン以下 | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| プロンプト 10 万トークン超 | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

- 互換エンドポイントに別の単価は書かれていない。互換層では prompt caching が使えないので、キャッシュ読み込みの安さ（入力の 1/10）は得られない
- Haiku 5.5 の最小キャッシュ長は 512 トークン
- 構造化出力は、形式を説明するシステムプロンプトの分だけ入力が増える

## Haiku 5.5 の thinking と effort

出典: [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)

- thinking は既定で adaptive。`{type: "disabled"}` は effort が `high` 以下のときだけ受け付ける。`{type: "enabled"}`（`budget_tokens`）は 400
- 「telling Claude Haiku 5.5 in the prompt to answer directly didn't stop it from thinking」。考える量を減らすのは effort か `disabled` で行う
- effort は `low`〜`max`、既定は `medium`。#686 で使った `low` にするには、Messages API なら `output_config.effort`、Agent SDK なら `effort` で渡す。互換エンドポイントでは渡す口が文書に無い

## 未確認のこと

- 互換エンドポイントで、追加 body に `output_config` を入れたときに通るか（文書には thinking しか書かれていない。無視される可能性が高い）
- 互換エンドポイントが base64 の data URL の画像を受けるか
- 回ごとに `enum` を変えたときの文法コンパイルの遅れと、prompt cache への影響（Messages API・Agent SDK の両方）
- Agent SDK の `outputFormat` が、内部で API の制約付きデコードを使っているか（文書は検証と出し直しとだけ書く）
