# ChatGPT のサブスクで差分更新を呼べる経路

調べた日: 2026-10-09。問い: [#634](https://github.com/daiki-beppu/live-mindmap/issues/634)（地図 [#374](https://github.com/daiki-beppu/live-mindmap/issues/374)）。

一次情報だけを根拠にした。OpenAI の開発者向け文書（`developers.openai.com`。各ページは末尾に `.md` を付けると原文の Markdown が取れる）、Codex の利用者向け文書（`learn.chatgpt.com/docs/…`。旧 `developers.openai.com/codex/…` から転送される）、`openai/codex` のソース（`2351d9e`、2026-10-09）、`openai/sign-in-with-chatgpt-devkit`（`0a36fef`、2026-10-07）、手元の `codex-cli 0.159.1` の `--help`、npm の公開メタデータを読んだ。ログインと課金は一度もしていないので、実際に呼んだ時間や上限の消え方は測っていない。

## 結論

- 公式の経路は 2 つある。
  1. **Sign in with ChatGPT の「ChatGPT プラン利用」**（2026-09-29 の DevDay で出た）。オープンソースのアプリやローカルで動くアプリが、利用者の ChatGPT サインインで OAuth のトークンを受け取り、公開の Responses API（`https://api.openai.com/v1/responses`）を利用者のプランの範囲で呼ぶ。live-mindmap のような形のアプリ向けに用意された経路で、**OpenAI は明示的に認めている**
  2. **Codex（`@openai/codex-sdk`・`codex exec`・`codex app-server`）**。利用者が `codex login` で ChatGPT にサインインすると、Codex のエージェントがプランの範囲で動く。禁じる文言は見当たらないが、文書が自動化に勧めるのは API キーで、ChatGPT のログインは「上級の選択肢」の扱い。しかもコーディング用のエージェントなので、モデルだけを使う目的には重い
- 差分更新に合うのは 1 の経路を、`effect/http` で Responses API に直接つなぐ形。ただしプレビューの制約で `previous_response_id` が使えず、会話を続けるには毎回全履歴を送ることになる。#426 の「Claude 以外はローカル向けの形（毎回 1 から呼ぶ）」にそのまま収まる
- Anthropic とは向きが逆。Anthropic は Agent SDK で作る第三者アプリにサブスクの認証を使わせないが、OpenAI は第三者のオープンソースアプリにサブスクの利用を開いた

## 1. 自作のアプリから ChatGPT のサブスクで呼んでよいか

### Sign in with ChatGPT（ChatGPT プラン利用）: 認められている

- 開発者向けクックブックの文言: "**At launch**, ChatGPT plan usage is available to open-source projects, personal projects that run locally, and selected private apps."。さらに "The ChatGPT plan usage integration described here is available for open-source tools and personal projects that run locally. If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users." "Review OpenAI's terms and policies before distributing your integration."（[Integrating Sign in with ChatGPT in your Opensource App](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)）
- 概要ページ: "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form."（[Overview](https://developers.openai.com/siwc/token-sharing-open-source)）
- クイックスタート: "**For open-source developers:** Let users run AI workloads in your tools with their ChatGPT plan, without requiring them to provide an API key. The open-source sign-in flow registers your client and issues OAuth credentials for eligible Responses API requests, without a client secret or partner API key." "ChatGPT plan usage is available to all open-source partners and selected private clients."（[Quickstart](https://developers.openai.com/siwc/quickstart)）
- DevDay 2026（2026-09-29）: "ChatGPT plan usage is available to open-source partners and selected private clients."（[DevDay 2026](https://learn.chatgpt.com/docs/whats-new/devday-2026)）

live-mindmap は MIT のオープンソースで、利用者が自分の Mac で動かし、有料でもホスト型でもない（ADR 0004）。クックブックが挙げる "open-source projects, personal projects that run locally" にそのまま当たる。登録は動的で、`client_id=dynamic_agent_client` から始めれば審査や事前の申請は要らない（"This direct flow needs neither a client secret nor a partner API key."、[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)）。

一方で、クイックスタートと DevDay のページは "open-source **partners**" と書く。この「partners」に申請や審査が要るのかは、どの文書にも書かれていない。動的登録に申請の手順が無いので、オープンソースのアプリなら誰でも当たると読める。ただし、運用が変わる余地は残る（プレビュー扱い）。

利用者の側の条件:

- 使えるのは Plus と Pro だけ: "In supported apps, eligible ChatGPT Plus and Pro subscribers can also choose to use their ChatGPT plan for AI requests."（[Sign in with ChatGPT（利用者向け）](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)）。Free・Go・Business・Enterprise・Edu は挙がっていない。資格が無ければ `subscription_sharing_user_not_eligible`（403）が返る（[Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)）
- サインインとプラン利用は別の同意。プラン利用は ChatGPT の会話や記憶を見せない: "Using your plan does not give the app access to your ChatGPT conversations or memories."（同上）

アプリの側の義務（[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)）:

- 認可はシステムのブラウザで OpenAI の画面を開き、`127.0.0.1` のループバックに戻す（PKCE、`state`・`nonce`）。アプリがパスワードを受け取ることは無い
- インストールごとに不透明な `ext_agent_host_id`（`urn:uuid:…` など）を最初のサインインの前に作って保存する
- スコープは `openid profile email` に加えて `offline_access resource.invoke chatgpt.tokens.use.direct`
- トークンはローカルのファイルに所有者だけの権限（`0600`）で原子的に書く。ログ・ブラウザのストレージ・ソース管理に出さない
- アクセストークンは 1 時間、リフレッシュトークンは 30 日で、更新のたびに入れ替わる。同じセッションの更新は直列にする（[Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)）
- ボタンは "Continue with ChatGPT" と書き、OpenAI のブランドの指針に従う（[UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)）

### Codex に ChatGPT でログインして使う: 禁じられてはいないが、勧められてもいない

- Codex の認証の文書は 2 つの方式を並べる。"Sign in with ChatGPT for subscription access" と "Sign in with an API key for usage-based access"。自動化については "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs." "API keys are still the recommended default for automation." と書く（[Authentication](https://learn.chatgpt.com/docs/auth)）
- `codex exec` の文書は "`codex exec` reuses saved CLI authentication by default." と書く。ChatGPT で管理する認証は、自分の Codex のアカウントとして動かしたいランナー向けの上級の選択肢で、"Do not use this workflow for public or open-source repositories." と注意している（[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)）。これは CI のランナーで他人のコードを動かす場面への注意で、利用者が自分の Mac で自分のログインを使う live-mindmap の場面とは違う
- Codex SDK の文書は用途に「アプリへの組み込み」を挙げ、認証方式を限っていない（[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)）。TypeScript SDK は `codex` CLI を子プロセスで起動するだけで、API キーを渡さなければ CLI の保存済みのログインがそのまま使われる（`sdk/typescript/src/exec.ts`）
- Sign in with ChatGPT の文書は、Codex を使うオープンソースのアプリにも ChatGPT プラン利用のトークンを `codex app-server` に渡す形を示し、"No separate Codex sign-in is required." と書く（[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)）。オープンソースのアプリが Codex を介してプランを使うときも、正規の入口はこちらだと読める

利用者が自分で `codex login` したうえで公式の SDK に呼ばせることを、禁じる一次情報は見当たらなかった。ただし文書の推しは「自動化は API キー、第三者アプリのプラン利用は Sign in with ChatGPT」で、Codex のログインを第三者アプリから使うことをはっきり認める文言も無い。グレーではないが、正面の経路でもない。なお `~/.codex/auth.json` のトークンを live-mindmap が読んで直接 API を叩くのは、Codex の文書が "Treat `~/.codex/auth.json` like a password" と書くとおり資格情報の流用になり、採らない。

### OpenAI の利用規約との関係

OpenAI の Terms of Use の「What you cannot do」には "Automatically or programmatically extract data or Output." と "You may not share your account credentials or make your account available to anyone else" がある（[Terms of use](https://openai.com/policies/terms-of-use/)。openai.com は取得を拒んだ（403）ので、文言は 2024-12-11 版の写しで確かめた）。前者は一般の禁止条項で、OpenAI 自身が上の文書で公開の API とプラン利用の OAuth をオープンソースのアプリに開いているので、その経路で呼ぶことは妨げないと読む。後者は、各利用者が自分のアカウントでサインインする形なので当たらない。

### Claude の Agent SDK との違い（2026-10-09 時点の文言を取り直した）

[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) の "Authentication and credential use":

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

ADR 0004（2026-10-02）と docs/knowledge/2026-10-02.md が要約した中身（Agent SDK で作る開発者は API キー、第三者がサブスクの認証で要求を送ることは認めない）は変わっていない。今のページには次の文もある。ADR を書いた時点からあったかは、Internet Archive が止まっていて確かめられなかった。

- "developers may not collect, store, or intermediate Claude.ai credentials or session tokens"
- "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code"（Claude Code を自社製品に入れる場合の節 "Can customers offer Claude Code in their products?" への言及。Agent SDK でプロダクトを作る開発者についての前の段落は、API キーを求めたまま）
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."

|  | Anthropic（Claude） | OpenAI（ChatGPT） |
| --- | --- | --- |
| 第三者のアプリがサブスクで呼ぶこと | 認めない（Agent SDK で作るなら API キー） | オープンソース・ローカルで動くアプリには認める（Sign in with ChatGPT のプラン利用） |
| 認証の流れ | Anthropic 自身の画面で完結。資格情報を集め・保存し・仲介してはならない | OpenAI の画面で認可し、アプリはループバックで受けた OAuth トークンを自分で保存・更新する |
| 呼ぶ先 | — | 公開の Responses API |
| 対象のプラン | — | Plus・Pro |

## 2. 構造化出力（JSON Schema）

- **Codex**: `codex exec --output-schema <FILE>`（"Path to a JSON Schema file describing the model's final response shape"、手元の `--help`）。SDK では `thread.run(input, { outputSchema })`。ソースでは Responses API の `text.format` に `type: json_schema`・`strict: true`・`name: "codex_output_schema"` で渡している（`codex-rs/codex-api/src/common.rs`、`core/src/client_common.rs`）。縛られるのは最後の応答だけで、途中でツールを呼ぶことは止めない
- **Responses API を直接（プラン利用）**: プレビューの制約ページは、使えない項目として `background`・`conversation`・`max_output_tokens`・`max_tool_calls`・`metadata`・`moderation`・`multi_agent`・`prompt`・`prompt_cache_retention`・`safety_identifier`・`temperature`・`top_logprobs`・`top_p`・`truncation`・`user` を挙げる（[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)）。`text.format`（JSON Schema）は挙がっていない。また同じ経路の `codex app-server` は動くと書かれており、Codex は出力スキーマを `text.format` で送るので、使えると読める。ただし文書が「使える」と明言しているわけではなく、実際に送って確かめてはいない
- `max_output_tokens` が使えないので、出力の長さはスキーマと指示で抑えるしかない。`temperature` も渡せない

## 3. ツールやファイル操作を切って、モデルだけを使えるか

- **Responses API を直接**: `tools` を送らなければ、モデルだけになる。Agent SDK の `tools: []` にそのまま当たる
- **Codex**: 一度に全部を切るスイッチは無い。シェル（`--disable shell_tool`、`unified_exec`）、Web 検索（`web_search="disabled"`）、画像を見る（`view_image`）、プラグイン・アプリ・メモリ・スキル・複数エージェントなどを、機能フラグと設定で一つずつ切ることになる（`codex features list`、`codex-rs/core/src/tools/spec_plan.rs`）。`apply_patch` はモデルの情報と実行環境で決まる。`codex exec` の既定は読み取りだけのサンドボックス（[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)）だが、読み取りのシェルは動く。システムプロンプトはコーディングエージェント用で、差し替える `model_instructions_file` は "Users are STRONGLY DISCOURAGED from using this field" とされる（`codex-rs/core/config.schema.json`）。作業ディレクトリの `AGENTS.md` も読む。モデルだけを使う目的には合わない

## 4. 会話を続けるか、毎回 1 から呼ぶか

- **Responses API を直接（プラン利用）**: "Set `store: false` and `stream: true`. Send `input` as an array containing the context needed for each request." "Omit `previous_response_id` over HTTP and send the required history in `input`. WebSocket continuation can reference only responses from the same authenticated connection; it does not provide persistent conversation storage."（[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)）。会話を続けるなら毎回全履歴を送る。`system` ロールのメッセージは拒まれ、`instructions` か developer のメッセージを使う
- **プレフィックスキャッシュ**: `prompt_cache_retention` は使えない。`prompt_cache_key` は禁止の一覧に無い（Codex はスレッドの id を `prompt_cache_key` に入れて送る。`core/src/client.rs`）。キャッシュが当たったときにプランの消費が減るかは、どの文書にも無い。Codex の料金ページは "Model choice, context, reasoning, tool use, retrieval, and caching all affect usage." とだけ書く（[Pricing](https://learn.chatgpt.com/docs/pricing)）
- **Codex**: SDK は `run()` のたびに `codex exec --experimental-json` を新しい子プロセスで起動し、2 回目からは `resume <thread id>` を付ける（`sdk/typescript/src/exec.ts`）。スレッドは `~/.codex/sessions` に保存される（`--ephemeral` で保存しない）。`codex app-server` なら 1 つのプロセスで続けられ、`store: false` でもローカルの履歴で `thread/resume` が効く
- **どちらの形が合うか**: 毎回 1 から呼ぶ形（#426・#487 のローカル向けの形）。サーバー側に会話を持てず、会話を続ける形にしても毎回全履歴を送るだけで、ADR 0006 の「変更だけ送って安くする」効果がプランの消費で得られるかは分からない。#426 は互換の口のモデルをすべてローカル向けの形で呼ぶと決めており、ChatGPT もそこに並べれば、プロンプトは Claude 用とそれ以外の 2 つのまま済む。ただし、ローカル向けの形（文ごとの分類、id を列挙型に縛る）は弱いモデル向けに作ったもので、GPT で Claude と並ぶ品質が出るかは Evals で測るまで分からない

## 5. 選べるモデル・1 回の時間・サブスクの上限

- **モデル**: アカウントごとの一覧を `GET https://api.openai.com/v1/models` で同じトークンで取る（`visibility: "list"` のものを出す。[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)）。Codex のモデルのページが挙げるのは `gpt-6-astra`（最上位）、`gpt-6.1-sol`（推奨。"Repeated, long-running work"）、`gpt-6-sol`、`gpt-6-luna`（"Our most efficient model for focused, high-volume tasks, including summarization, extraction"）。`gpt-5.5` は 2026-10-14 に ChatGPT と Codex から外れる（[Models](https://learn.chatgpt.com/docs/models)）。差分更新に近いのは Luna か Sol
- **1 回の時間**: 一次情報に数字は無く、ログインせずには測れない。Codex 経由では、呼ぶたびの子プロセスの起動、コーディングエージェントのシステムプロンプトとツールの定義、推論が上乗せされる。直接呼べばその分が無い。Standard と Fast のモードがあり、Fast は上限を速く消費する（[Pricing](https://learn.chatgpt.com/docs/pricing)）
- **上限**:
  - Plus は 5 時間ごとの上限があり、プランを使うすべてのアプリで共有する: "For ChatGPT Plus users, the five-hour usage limit is shared across all apps where they use their ChatGPT plan, including private and open-source clients. … The five-hour usage limit does not apply for Pro users."（[Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)）。週の上限もありうる（"Weekly limits may also apply."）
  - 利用者はアプリごとに週の上限（プラン全体の 10〜100%）を ChatGPT の設定で決められる。上限を超えたあとクレジットを使わせるかも選べる
  - Codex の料金ページの目安（Plus、5 時間あたりのローカルのメッセージ数）: GPT-6 Luna 350〜3,000、GPT-6.1 Sol 15〜160、GPT-6 Sol 15〜150、GPT-6 Astra 5〜45。"These estimates are not fixed message limits."（[Pricing](https://learn.chatgpt.com/docs/pricing)）。Codex の「メッセージ」は 1 回で多くの要求とツールを動かすエージェントの一往復で、差分更新の 1 回の要求とは重さが違う。プラン利用の要求がこの枠をどれだけ減らすかは書かれていない
  - 見積もり: 1〜3 分に 1 回なら 3 時間の会議で 60〜180 回。Luna の目安の下限（350）には収まる。Sol は目安の下限（15）が会議 1 本に届かない幅で、Plus では尽きうる。Pro には 5 時間の上限が無い
  - 尽きると、ストリームの途中でも `response.failed` に `subscription_sharing_usage_limit_exceeded`（429）が来る。文書は新しい要求を止め、ChatGPT の設定の「使用量」へ案内するよう求め、"Do not assume the entire plan is empty or infer a reset time from this code alone; an app-specific limit can also apply." と書く（[Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)）。会議の途中で更新が止まる扱いを決める必要がある

## 6. Node（Effect）からの呼び方と依存の重さ

- **Responses API を直接**: `effect/http` で `POST /v1/responses` を SSE で読み、`response.completed` までを成功とする。OAuth（ループバックの受け口、PKCE、トークンの交換と更新、ID トークンの署名の検証）は自前で書く。ID トークンの検証に JWKS を読むので `jose` 程度が要るかもしれない。npm の `openai` SDK は要らない。#378 で互換の口を `effect/http` で直接呼ぶと決めた作りと揃う。ただし互換の口は Chat Completions、こちらは Responses API で、配線は別になる
- **公式の DevKit**: `openai/sign-in-with-chatgpt-devkit` の `@siwc/local`（`jose`・`openai`・`proper-lockfile` に依存、Node 22 以上）。npm には出ておらず（`"private": true`）、ライセンスは "Sign-in with ChatGPT DevKit Noncommercial License v1.0" で "solely for Noncommercial Purposes"。live-mindmap は MIT で、受け取った人の商用利用を妨げないので、DevKit のコードを取り込んだり同梱したりはできない。文書を読んで自分で書く（同ライセンスは "Independently authored software does not become a Modified Work merely by calling, linking to, or communicating with the Work through an interface." と書く）
- **Codex SDK**: `@openai/codex-sdk@0.162.0` は 80KB だが、`@openai/codex` に依存し、そのプラットフォーム別パッケージ（`@openai/codex-darwin-arm64`）は展開して 338MB（npm の `dist.unpackedSize`）。呼ぶたびに子プロセスを起動し、JSONL を読む。Node 18 以上

## 他の経路

- `codex mcp-server` は削除された（"have been removed"、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)）。代わりは `codex app-server`（stdio の JSON-RPC）
- Python の Codex SDK もあるが、Node のサーバーには関係しない
- ChatGPT の `backend-api` を直接呼ぶのは禁じられている: "do not point it at ChatGPT's `backend-api` endpoints."（[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)）

## 確かめていないこと

- プラン利用の Responses API で `text.format` の JSON Schema が通るか（禁止の一覧に無いことからの推定）
- 1 回の時間、1 回の要求が Plus の 5 時間の枠をどれだけ減らすか、キャッシュが消費を減らすか
- 「open-source partners」に何かの申請が要るか（動的登録には無い）
- GPT で、ローカル向けの形のプロンプトが Claude にどこまで迫るか（Evals の `cli eval` で測る）
