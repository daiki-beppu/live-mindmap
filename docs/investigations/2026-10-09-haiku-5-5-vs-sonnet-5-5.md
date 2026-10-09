# Haiku 5.5 と Sonnet 5.5 の公表値と、今の呼び方で Haiku 5.5 が使えるか（調査）

チケット「Haiku 5.5 と Sonnet 5.5 の公表値と、今の呼び方で Haiku 5.5 が使えるか」（地図「差分更新のモデル」の子）の調査メモ。2026-10-09 時点の一次情報（Anthropic のドキュメント・発表・システムカード、`node_modules` にある Agent SDK 0.3.288 の型と同梱の Claude Code 2.1.288 の本体）だけに当たった。API キーが手元に無かったため、実際の呼び出しとトークン数の計測（count_tokens）はしていない。数値の見積もりは、見積もりと書いてある。

## 結論

- **呼べる見込みは高い。ただし、同じ条件で比べるには effort を明示する必要がある。** 同梱の Claude Code 2.1.288（ビルド 2026-10-02）は Haiku 5.5（公開 2026-10-07）より古く、モデルの一覧に `claude-haiku-5-5` が無い。それでも、知らないモデル ID は API（first party）にそのまま送られ、adaptive thinking と effort を付けて呼ぶ作りになっている。構造化出力（`outputFormat: json_schema`）も Haiku 5.5 は対応している。止まる理由は見つからなかった。
- **effort の既定が、モデルごとに別の値になる。** 今の Sonnet 5.5 は、Claude Code が自分の一覧の既定 `medium` を送っている（API の既定は `high`）。Haiku 5.5 は一覧に無いので、起動時に取りに行くモデル一覧に載っていなければ、コードの最後の既定 `high` が送られる（API の既定は `medium`）。`cli eval` で比べるときは、両方の effort を同じ値に固定する（SDK の `effort` オプションか、環境変数 `CLAUDE_CODE_EFFORT_LEVEL`）。
- **料金は、公表単価でおおむね 1/20（キャッシュの読み出しだけ 1/10）。** 1 回の入力（キャッシュ分も含む）が 10 万トークンを超えると、Haiku 5.5 は高い料金表（5 倍）に切り替わる。
- **キャッシュの最小長は両方 512 トークン。** 今の SYSTEM は約 4,750 字で、どう見積もっても 512 トークンを大きく超える（後述）。
- **速さ・日本語の公表値は、比べられる数字が無い。** 速さは「Fastest（Haiku 5.5）／Fast（Sonnet 5.5）」という相対表記だけで、トークン毎秒や最初のトークンまでの時間は公表されていない。日本語単独のスコアも無い。多言語の平均（GMMLU 42 言語）は Haiku 5.5 が 87.8%、Sonnet 5.5 が 92.1%。

## 1. 公表値の比較

| 項目 | Sonnet 5.5（今） | Haiku 5.5 | 出典 |
|---|---|---|---|
| モデル ID | `claude-sonnet-5-5` | `claude-haiku-5-5` | [Models overview][overview] |
| 公開日 | 2026-09-28 | 2026-10-07 | [Sonnet 5.5][sonnet] / [Haiku 5.5][haiku] |
| 入力 | $2 / MTok | $0.10 / MTok（プロンプトが 10 万トークン以下）、$0.50（超え） | [Pricing][pricing] |
| 出力 | $10 / MTok | $0.50 / MTok（10 万以下）、$2.50（超え） | [Pricing][pricing] |
| キャッシュ書き込み（5 分 TTL） | $2.50 / MTok | $0.125（10 万以下）、$0.625（超え） | [Pricing][pricing] |
| キャッシュ書き込み（1 時間 TTL） | $4 / MTok | $0.20（10 万以下）、$1（超え） | [Pricing][pricing] |
| キャッシュ読み出し | **$0.10 / MTok**（入力の 0.05 倍） | $0.01（10 万以下）、$0.05（超え） | [Pricing][pricing] |
| 文脈長 | 100 万トークン | 100 万トークン | [Models overview][overview] |
| 出力の上限 | 12.8 万トークン | 12.8 万トークン | [Models overview][overview] |
| キャッシュに乗る最小の長さ | 512 トークン | 512 トークン | [Prompt caching][caching] |
| thinking | adaptive（既定で有効） | adaptive（既定で有効） | [Models overview][overview] |
| effort の既定（API） | `high` | `medium` | [Models overview][overview] |
| 比較上の遅れ | Fast | Fastest | [Models overview][overview] |
| 知識のカットオフ（信頼できる範囲／学習データ） | 2026 年 6 月 / 2026 年 6 月 | 2026 年 6 月 / 2026 年 6 月 | [Models overview][overview] |
| 入力 → 出力 | テキストと画像 → テキスト | テキストと画像 → テキスト | 各モデルのページ |
| 構造化出力 | 対応 | 対応 | [Structured outputs][so]（supportedModels に両方ある） |
| トークナイザ | 新しい方（Claude 4.7 以降と同じ） | 新しい方（Claude 4.7 以降と同じ） | [Pricing][pricing]・[What's new in Haiku 5.5][haikunew] |

補足:

- **Sonnet 5.5 のキャッシュ読み出しは $0.10。** 料金表の注 2 に「Claude Opus 5.5 と Claude Sonnet 5.5 のキャッシュ読み出しは入力の 0.05 倍」とある。`docs/knowledge/2026-10-04.md` の費用の計算は $0.2 で出しているので、読み出しの分だけ高めに出ている。
- **Haiku 5.5 の 10 万トークンの境目は、1 回の要求ごとに判定される。** 判定に使うのは、キャッシュの読み出しと書き込みも含めたすべての入力トークン。超えた要求は、一部がキャッシュに当たっていても全体が高い料金表で請求される（[Pricing の Long context pricing][pricing]）。開いた query を 14 回使い回すと、回を追うごとに履歴が積もる。長い会議で最初のメッセージに送るマップ全体や画面の画像が大きい場合、境目に近づくかは測って確かめる。
- **トークン数は 2 つのモデルでほぼ同じになる見込み。** どちらも新しいトークナイザを使うので、Sonnet 5.5 で測った `usage` のトークン数はそのまま Haiku 5.5 の見積もりに使える（出力の thinking の量は effort とモデルで変わる）。
- **費用の目安。** トークン数が同じなら、入力・出力・キャッシュ書き込みは 1/20、キャッシュ読み出しは 1/10 になる。出力（thinking を含む）の量はモデルと effort で変わるので、実際の比は `cli eval` の `usage` で出す。
- **バッチは使っていないので関係ない**（どちらも 50% 引き）。

## 2. キャッシュの最小長と今の SYSTEM

- 最小長は Haiku 5.5・Sonnet 5.5 とも 512 トークン。Haiku 4.5 は 4,096 だった（どちらも [Prompt caching][caching]）。
- `server/src/claude.ts` の SYSTEM は、テンプレート文字列が約 4,350 字で、ここに `NOOP_SCOPE`（約 400 字）が埋め込まれる。合わせて約 4,750 字で、ほぼ日本語。
- **トークン数は数えていない（見積もり）。** ANTHROPIC_API_KEY が無く、count_tokens を呼べなかった。日本語を 1 字あたり 0.6〜1.2 トークンと置くと 2,900〜5,700 トークンになる。`docs/knowledge/2026-10-08.md` にも「約 4,000 字で 3,000〜4,000 トークンの見込み」とある。最悪の 4 字で 1 トークンと置いても約 1,200 トークンで、512 は超える。
- キャッシュされる前置きは、system に加えて、Claude Code が足す構造化出力用のツール（`StructuredOutput`）の定義と、出力のスキーマも含む。そのぶん、さらに余裕がある。
- `FORCE_PROMPT_CACHING_5M` は Claude Code の環境変数で、モデルによらず効く。Claude Code にはモデル系列ごとにキャッシュを切る `DISABLE_PROMPT_CACHING_HAIKU` もあるが、設定しなければ効かない（同梱の Claude Code 本体の文字列から確認）。

## 3. 今の呼び方で Haiku 5.5 を呼べるか

今の呼び方は次のとおり（`server/src/claude.ts`）。Agent SDK 0.3.288 の `query()` に `model: "claude-sonnet-5-5"`、`systemPrompt: SYSTEM`、`tools: []`、`maxTurns: 4`、`outputFormat: { type: "json_schema", schema }`、`env: { ...process.env, FORCE_PROMPT_CACHING_5M: "1" }` を渡す。開いた query を最大 14 回使い回し、`thinking` と `effort` は渡していない。

### 3.1 SDK の型

- `Options.model?: string` で、どのモデル ID でも渡せる（`sdk.d.ts`）。
- `Options.thinking?: ThinkingConfig`（`adaptive` / `enabled` / `disabled`）と `Options.effort?: EffortLevel` がある。thinking の説明は「`{ type: 'adaptive' }` … This is the default for models that support it.」。
- `outputFormat: {type: 'json_schema'}` は、Claude Code が「end-turn tool」（`StructuredOutput` というツールの呼び出し）で実現している（`sdk.d.ts` の説明と、本体の `"StructuredOutput"`）。結果は `result` メッセージの `structured_output` に入る。モデルが変わってもこの流れは同じ。

### 3.2 同梱の Claude Code 2.1.288 の挙動（本体の文字列を読んだ）

SDK は同梱の Claude Code（`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.288` の `claude`、`BUILD_TIME: 2026-10-02T16:42:03Z`）を子プロセスとして動かす。本体の JS を `strings` で取り出して読んだ。

- **一覧に Haiku 5.5 が無い。** 組み込みのモデル一覧には `claude-sonnet-5-5`（`default_effort: "medium"`、`adaptive_thinking` など）はあるが、`claude-haiku-5-5` は無い。Haiku は `claude-haiku-4-5` までしか無い。
- **知らない ID でも送る。** 知らないモデルは `tengu_api_unrecognized_model` を記録するだけで、ID はそのまま API に送る。
- **thinking は adaptive で送る。** adaptive にするかを決める関数は、`claude-3-*`・`claude-opus-4-0/4-1/4-5`・`claude-sonnet-4-0/4-5`・`claude-haiku-4-5` を除外し、残りは first party なら adaptive にする。`claude-haiku-5-5` は除外に当たらないので adaptive になる。`budget_tokens`（Haiku 5.5 では 400 になる）は送らない。
- **effort は送る。** effort に対応するかを決める関数も同じ形で、`claude-haiku-5-5` は first party なら「対応」になる。API が effort を拒んだときは、そのモデルを「effort 非対応」として覚え直す仕組みもある。
- **送る effort の値は、次の順で決まる。** (1) 環境変数 `CLAUDE_CODE_EFFORT_LEVEL`、(2) Anthropic 側の設定でモデルごとに上書きされる値、(3) 利用者の設定（SDK の `effort` オプションなど）、(4) 起動時に取りに行くモデル一覧の `default_effort`、(5) 組み込みの一覧の `default_effort`。どれも無ければ `"high"`。
  - Sonnet 5.5 は (5) で **`medium`**。今の差分更新は API の既定の `high` ではなく `medium` で動いている、と読める（(2)(4) で上書きされていなければ）。
  - Haiku 5.5 は (5) に無い。(4) に載っていなければ **`high`** になる（API の既定は `medium`）。
  - つまり何も指定しないと、Sonnet 5.5 は medium、Haiku 5.5 は high で比べることになりうる。実際に送った値は外から見えにくい。
- **sampling（temperature など）は送らない。** temperature を送るのは Opus 4.7 だけ。Haiku 5.5 で 400 になる temperature・top_p・top_k は付かない。
- **prefill は使わない。** 構造化出力はツールの呼び出しで返るので、Haiku 5.5 で 400 になる assistant の prefill は関係しない。
- **ほかの小さな違い。** 知らないモデルは、文脈長と出力の既定を一覧から取れず、Claude Code の既定値を使う。差分更新は 1 回の出力が 100〜300 トークンで、14 回で開き直すので、自動の要約（compaction）にも出力の上限にも届かない。モデル名に `haiku` を含むと付けない beta ヘッダーが 1 つあるが、API 側で必要なものではない。

### 3.3 API 側で Haiku 5.5 が違うところ

[Haiku 5.5 の移行ガイド][haikumig]・[What's new][haikunew]・[Models overview][overview] から、今の呼び方に関係するものだけ挙げる。「JSON の出力形式と自前のツール」の行と、safety の分類の行は、Claude Code に同梱の Claude API スキル（Anthropic 製、`shared/model-migration.md` の「Migrating to Claude Haiku 5.5」）による。

| 違い | 今の呼び方への影響 |
|---|---|
| `budget_tokens`・temperature 等・assistant の prefill が 400 | 送っていない（3.2） |
| thinking は既定で有効、既定 effort は `medium` | Claude Code が effort を明示して送るので、API の既定は効かない（3.2） |
| thinking を `disabled` にできるのは effort `high` 以下 | thinking を切っていないので関係ない |
| 「JSON の出力形式と自前のツールを、thinking を切って併用すると、ツールの呼び出しを飛ばすことがある」 | thinking は有効、自前のツールも無い（`tools: []`） |
| 前のターンを書き換えると thinking ブロックが無効になる（2026-08-31 以降に作ったアカウントは 400） | Sonnet 5.5 にも同じ検査がある。今の query は追記だけで進むので、同じく問題ない見込み |
| 安全分類器が `stop_reason: "refusal"` を返すことがある（cyber・bio・frontier_llm・general_harms）。サーバー側のフォールバックは無い | Sonnet 5.5 にも分類器はある。今のコードは `result` が success 以外なら失敗として扱い、次の呼び出しで開き直す。会議の発言で起きる頻度は評価で見る |
| 同じ文が Haiku 4.5 より約 3 割多いトークンになる | Sonnet 5.5 と同じトークナイザなので、Sonnet 5.5 との比較では変わらない |

## 4. 速さ・日本語の性能について公表されていること

- **速さ。** トークン毎秒・最初のトークンまでの時間の数字は、どちらのモデルにも公表されていない。モデル一覧の「Comparative latency」は Haiku 5.5 が Fastest、Sonnet 5.5 が Fast で、注に「実際の遅れはプロンプトの長さ・出力の長さ・effort による」とある（[Models overview][overview]）。Haiku 5.5 の発表は「標準の速さでは、これまでで最も速いモデル（Opus の Fast Mode よりは遅い）」と書く（[発表][haikuann]）。Sonnet 5.5 の発表は「Sonnet 5 より 30% 以上速く出力する」と書く（[発表][sonnetann]）。
- **日本語。** 日本語単独のスコアは、発表にもシステムカードにも無い。Haiku 5.5 のシステムカード 8.12 節に多言語の平均がある（[System card][haikucard]、どのモデルも adaptive thinking・effort max）。
  - GMMLU（42 言語の MMLU）: Haiku 5.5 **87.8%**、Sonnet 5.5 92.1%、Opus 5.5 94.3%
  - MILU（インドの 10 言語と英語）: Haiku 5.5 87.6%、Sonnet 5.5 91.6%
- **ほかのベンチマーク（参考）。** Haiku 5.5 の発表の比較表（表が崩れていたので、列の並び順から読んだ）では、Haiku 5.5 と Sonnet 5.5 の差は、GDPval-AA v2.1 が 1620 と 1840、Humanity's Last Exam（ツールなし）が 45.9% と 56.9%、Terminal-Bench 4.0 が 39.2% と 70.6%。差分更新に近い「短い指示で JSON を返す」種類のベンチマークは公表されていない。品質の下限（Sonnet 5.5 から落ちないこと）は、公表値からは判断できず、`cli eval` で測るしかない。

## 5. `cli eval` を Haiku 5.5 で流す前に（「Haiku 5.5 で cli eval を流す」チケット向け）

止まる理由は見つからなかった。比較を正しくするために、次の 3 つが要る。

1. **effort を両方で固定する。** 何もしないと Sonnet 5.5 は `medium`、Haiku 5.5 は `high`（起動時のモデル一覧しだい）になりうる。`query()` の `options.effort` で明示するのが確実。少なくとも「Sonnet 5.5 medium」と「Haiku 5.5 medium」を比べ、Haiku 5.5 は `low`・`high` も見る価値がある（Claude API スキルの移行ガイドは「2〜3 段を自分の評価で試す」と勧めている）。
2. **モデルを差し替える口。** 今は `MODEL` が定数なので、評価で Haiku 5.5 を流すには差し替える口が要る。地図「差分更新をローカルの LLM でも動かす」で決めた `--model <名前>` に載せるか、評価用に一時的に差し替える。
3. **10 万トークンの境目を見る。** 各呼び出しの `usage` の input・cache_read・cache_creation の合計が 10 万を超える回があるかを数える。超える回は高い料金表になる。費用はトークン数 × 公表単価で出す。Sonnet 5.5 のキャッシュ読み出しは $0.10 で計算する。

そのほか、実際に送った effort を確かめたいときは、Claude Code のフックの入力（PreToolUse など、ツールの呼び出しの中で動くフック）に `effort` の欄がある（`sdk.d.ts` の hook input の `effort`）。

## 出典

- [Models overview][overview] / [Claude Haiku 5.5][haiku] / [Claude Sonnet 5.5][sonnet] / [What's new in Claude Haiku 5.5][haikunew] / [Haiku 5.5 migration guide][haikumig]
- Claude Code 2.1.295 に同梱の Claude API スキル（`claude-api`）の `shared/model-migration.md`（「Migrating to Claude Haiku 5.5」「Migrating to Claude Sonnet 5.5」）
- [Pricing][pricing] / [Prompt caching][caching] / [Structured outputs][so]
- [Claude Haiku 5.5 の発表][haikuann] / [Claude Sonnet 5.5 の発表][sonnetann] / [Claude Haiku 5.5 System Card][haikucard]
- `server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（0.3.288）
- `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.288/.../claude`（Claude Code 2.1.288 の本体。`strings` で取り出して読んだ）

[overview]: https://platform.claude.com/docs/en/about-claude/models/overview
[haiku]: https://platform.claude.com/docs/en/models/haiku-5-5/overview
[sonnet]: https://platform.claude.com/docs/en/models/sonnet-5-5/overview
[haikunew]: https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5
[haikumig]: https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
[pricing]: https://platform.claude.com/docs/en/about-claude/pricing
[caching]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[so]: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
[haikuann]: https://www.anthropic.com/claude-haiku-5-5
[sonnetann]: https://www.anthropic.com/claude-sonnet-5-5
[haikucard]: https://www.anthropic.com/document/claude-haiku-5-5-system-card
