# e2e（tester-army/e2e）で何ができるか

調べた日: 2026-10-08。issue [#466](https://github.com/daiki-beppu/live-mindmap/issues/466)（地図 [#459](https://github.com/daiki-beppu/live-mindmap/issues/459)）の調査。

根拠は一次情報だけにした。リポジトリ [tester-army/e2e](https://github.com/tester-army/e2e) のコミット `f1a1ac2`（2026-10-07）の README・`docs/`・ソース、npm の `e2e@0.18.0`（2026-10-06 公開、Apache-2.0）。公式ドキュメントのサイト [e2e.tester.army/docs](https://e2e.tester.army/docs) は、リポジトリの `docs/*.mdx` から作られている（npm パッケージにも `node_modules/e2e/docs` として同梱）。以下の「docs/…」はそのリポジトリ内のパス。

あわせて、リポジトリの外のスクラッチディレクトリに `e2e@0.18.0`・`@e2e-dev/web@0.13.0`・`ai@7` を入れ、localhost の静的ページで 3 本のテストを動かした（後述の「手元で試したこと」）。リポジトリの package.json には入れていない。

## 結論

- **Web の画面は動かせる。CLI は「エージェントに操作させる」形では動かせない**。用意されている engine は `@e2e-dev/web`（Playwright で Chromium・Firefox・WebKit）と `@e2e-dev/mobile`（iOS・Android）だけ。端末やプロセスを操作する engine は無い。CLI は、engine 無しの target でテストのコードから子プロセスを起こして `expect` で値を見る（モデル呼び出し無し）か、`defineEngine` で自前の engine を書くしかない。
- **モデルは AI SDK の provider なら何でもよく、既定は無い**。Claude は `@ai-sdk/anthropic`（`ANTHROPIC_API_KEY`）か Vercel AI Gateway 経由で使える。Claude のサブスクリプションでのログインは**非対応**と明記されている。ローカルのモデルは `@ai-sdk/openai-compatible` で localhost のエンドポイントを指せる。
- **1 回あたりの費用は固定ではなく、モデルとトークン数で決まる**。公式の例では Claude Sonnet 4.5 で `act` 1 回（3 呼び出し、約 9.4k/0.4k トークン）が $0.0198、`assert` 1 回が $0.0114、計 $0.031。上限は `act` が 25 呼び出し、`assert` が 2 呼び出し。
- **毎回同じ結果になる保証は無い。ぶれを減らす仕組みはある**。`agent.act` は「後続の検証が通った操作」を記録し、次回からモデルを呼ばずにリプレイする（replay cache、`.e2e/cache/` に JSON、コミット可）。ただし `agent.assert`・`waitFor`・`extract` の判定は**毎回モデルに聞く**ので、判定のぶれは残る。e2e は temperature を送らない（provider の既定のまま）。
- **GitHub Actions で回せる**。公式のワークフロー例があり、CI では自動で retries 1・workers 1・cache は読み取り専用になる。結果は `.e2e/report.json`（JSON Schema 付き）、JUnit XML、Markdown、テストごとの `trace.md`、PR コメント（`@e2e-dev/github`）で出る。
- **mock は挟める**。(1) モデルを使わない `StepExecutor` を agents に差す（公式の方法）、(2) AI SDK の `MockLanguageModelV4`（`ai/test`）を `model` に渡す。どちらも手元で通った。

## Web の画面を動かせるか

- `@e2e-dev/web` が Playwright（`playwright-core` 1.63.0 に固定、[packages/web/package.json](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/packages/web/package.json)）でブラウザを起動する。既定は Chromium、既定でヘッドレス、`--headed` で表示（[docs/debugging.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/debugging.mdx)）。`connect` で CDP 越しの外部ブラウザ、Kernel のホスト型ブラウザにもつなげる（[docs/reference/web.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/reference/web.mdx)）。
- **localhost を相手にできる**。`app.url` に `http://localhost:3000` などを書く。`app.command` を書くとランナーが開発サーバーを起動し、URL が応答するまで待ち、終わったら止める。`url: 'http://127.0.0.1:0'` にすると空きポートを選んで `{port}` を `args`・`env` に差し込む（[docs/web.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/web.mdx)）。
  - command はシェルを通さず、子に渡る環境変数は `PATH`・`HOME`・一時ディレクトリと `env` だけ。
  - 起動できるのは `app.command` の 1 プロセスだけで、DB や mock など依存プロセスは起動しない（「services API は後のリリース」）。必要ならスクリプト 1 本にまとめて起動する。
- モデルに渡るのは画面の HTML ではなく、**役割・名前・テキスト・状態を並べた赤塗り済みのテキストスナップショット**（アクセシビリティツリー相当）。見た目で判断させたいときは `vision: true`（スクショも渡す）か `vision: 'only'`（[docs/core-concepts.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/core-concepts.mdx)、[docs/agent-steps.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/agent-steps.mdx)）。
- ブラウザの起動引数（Playwright の `launchOptions`）を渡す項目は `WebOptions` に無い。マイクなどの権限やフェイクメディアの起動フラグを足す口は見当たらなかった（`viewport`・`headers`・`locale`・`timezoneId`・`initScripts` などはある）。

## CLI を動かせるか

- engine は `web` と `mobile` の 2 つだけ（[README](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/README.md)）。docs 全体を探しても、端末・PTY・プロセスの標準出力を操作対象にする engine の記述は無い。
- 使える道は 2 つ。
  1. **engine 無しの target**: `e2e init` で engine に **None** を選ぶと、ブラウザを開かない target になる。テストは `app` だけを受け取り、モデルを呼ばない。API テストの例（`fetch` ＋ `expect(...).toMatchSchema(...)`）と同じ形で、`node:child_process` で CLI を起こして出力を `expect` で比べることはできる（[docs/api-testing.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/api-testing.mdx)）。ただし `agent.act` で自然言語から CLI を操作させることはできない。
  2. **自前の engine**: `e2e/engine` の `defineEngine` で「デスクトップアプリ、TV、ほかのプラットフォーム」を足せる（[docs/writing-an-engine.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/writing-an-engine.mdx)）。ノードの意味ツリーと `tap`・`type` などの操作を実装する契約で、端末を相手にするなら画面を木として見せる層を自作することになる。
- 結論として、CLI のテストに e2e を使う利点は「同じランナー・同じレポートに並ぶ」ことくらいで、今の `node:test`／vitest でやるのと中身は変わらない。

## モデルと API キー

- [docs/models.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/models.mdx) より。
  - 既定のモデルも共通の API キー変数も**無い**。`e2e.config.ts` の `agents.default.model` に AI SDK のモデルのインスタンスを渡し、キーは provider が自分の環境変数から読む。e2e は `.env` を読まない（`process.loadEnvFile()` を config で呼ぶ）。
  - エージェントのステップを使うなら `ai` パッケージが要る（`ai@^7`、peer 依存）。ツール呼び出しと画像に対応したモデルが必要。
  - 経路は Vercel AI Gateway（`AI_GATEWAY_API_KEY` か Vercel OIDC）、OpenRouter、各 provider の直接（例: `@ai-sdk/anthropic`）、OpenAI 互換のローカル／自前サーバー（`createOpenAICompatible({ baseURL: 'http://127.0.0.1:11434/v1' })`）。
  - **Claude**: `@ai-sdk/anthropic` は optional peer に入っている（[packages/e2e/package.json](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/packages/e2e/package.json)）。Anthropic の Messages API をツール使用・プロンプトキャッシュ・画像・構造化出力で使う、と明記。docs の例は `gateway('anthropic/claude-sonnet-5')`。
  - 操作役と判定役に別のモデルを使える（`judge`）。agents に名前を付けて複数のモデルを持ち、`--agent careful` で切り替えられる。
- サブスクリプションでのログイン（`npx e2e login`）は ChatGPT・GitHub Copilot・OpenCode Console・SuperGrok だけ。**「Claude subscriptions are not supported」**。Copilot 経由で Claude のモデルを使う道はある（[docs/subscriptions.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/subscriptions.mdx)）。
- 送る中身: 赤塗り済みの画面、ステップの指示、エージェントが求めたスクショ。User-Agent に `e2e/<version>` が付く。

## 1 回あたりの費用

- 定額は無く、選んだモデルのトークン単価で決まる。`--debug` でステップごとの呼び出し回数・トークン・費用（provider が返すとき）が出る。docs の例（[docs/debugging.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/debugging.mdx)）:

  | ステップ | 呼び出し | 入力/出力トークン | 費用 |
  | --- | ---: | --- | ---: |
  | `act "add a todo named groceries"` | 3 | 9412 / 388 | $0.0198 |
  | `assert "the list shows groceries"` | 1 | 3120 / 41 | $0.0114 |
  | 計（anthropic/claude-sonnet-4.5） | | | $0.0312 |

- 上限（[docs/reference/agent.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/reference/agent.mdx) の Budgets）: `act` は 25 呼び出し・25 操作・120 秒、`waitFor` は 25 呼び出し・30 秒、`assert`・`extract` は 2 呼び出し（修復 1 回込み）・30 秒。超えると `STEP_BUDGET_EXHAUSTED`。
- 費用を下げる手段: replay cache（`act` を 0 呼び出しにする）、`waitFor` は画面が変わったときだけ呼ぶ、スクショは必要なときだけ、`--max-failures <n>` で壊れたデプロイに残りの呼び出しを使わない。公式のベンチマーク（web-benchmark）は「1 回あたり数セント」と書いている（[apps/web-benchmark/README.md](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/apps/web-benchmark/README.md)）。
- エージェントのステップが無いテスト（locator と `expect` だけ）はモデルを呼ばず、費用ゼロ。

## 同じシナリオで同じ結果になるか

- **replay cache**（[docs/cache.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/cache.mdx)）
  - `agent.act` の操作を、**後続の検証（locator の `expect`、`agent.assert`、`agent.waitFor`）が通ったときだけ**記録する。次の実行ではモデルを呼ばずに同じ操作をリプレイし、終わりの画面（ルート、現れた／消えた要素とその状態）が記録と合うか確かめる。合わなければ、その画面からエージェントが引き継ぐ（hand off）。
  - 記録は `.e2e/cache/` の JSON。プロンプト・会話・スクショ・シークレットの値は入らない。既定では `.gitignore` 済みで、コミットすれば CI で共有できる。
  - モード: ローカルは `read-write`、CI は `read-only`、`--no-cache` で `off`。`--strict-cache` にすると、記録があるのにリプレイできないステップを `REPLAY_STALE`（exit 2）で落とし、モデルを呼ばない。黙ってモデルに頼って通る状態を防げる。
  - キーはテスト名・target・指示・params・agent・agent の context。**モデルを変えてもキーは変わらない**。`Date.now()` のような毎回違う値は `unique()` で包む。
  - リトライは常に live（リプレイしない）。
- **判定はキャッシュされない**。`agent.assert`・`waitFor`・`extract` は毎回モデルに聞く（同上）。判定役のモデルは指示と今の画面だけを見て、それまでのステップは見ない。判定は `holds`／`fails`／`inconclusive` の 3 値で、構造化出力（JSON Schema `agent-judgment-2`）で返させる（手元で確認）。
- **temperature は送らない**。`packages/e2e/src` に `temperature` の指定は無く、手元で mock が受け取ったリクエストにも `temperature` は無かった（`maxOutputTokens`・`toolChoice`・`responseFormat`・`prompt` だけ）。provider の既定値で動くので、判定は呼ぶたびにぶれうる。docs の勧めは「正確な値は locator で見て、モデルには意味だけを判定させる」。
- **ぶれの扱い**: CI では既定で 1 回リトライし、リトライで通ったテストは flaky と報告する（[docs/ci.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/ci.mdx)）。同じシナリオを何回回すと何割通るかを測る機能は無い（リポジトリ内の `scripts/bench-ab.ts` は本体の A/B 計測用で、「同じビルドの 2 回で手順が違ったテスト」を時間計測から外す）。

## CI（GitHub Actions）で回せるか

- 回せる。公式のワークフロー例（[docs/ci/github-actions.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/ci/github-actions.mdx)）は `ubuntu-latest` で、`pnpm exec e2e-web install chromium --with-deps` → `npx e2e run --reporter list,junit`（`AI_GATEWAY_API_KEY` を secret から）→ `.e2e/report.json`・`junit.xml`・`.e2e/results` をアップロード、の順。
- `CI` が立っていると: retries 0→1、workers 半分のコア→1、cache 未指定なら `read-only`、`.only` は拒否、`reuseExisting` は無視（[docs/ci.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/ci.mdx)）。
- `--shard i/n` で行列に分けられる（report の統合は未実装）。`--last-failed` で落ちたものだけ再実行。
- モデルのキーは CI の secret で渡す。PR のコードがキーを読めるので、信頼できるブランチにだけ渡せ、と注意がある。フォークの PR には secret が渡らないので、エージェントのステップは落ちる（replay でまかなえる `act` は除く）。
- 終了コード: 1 テスト失敗、2 設定・収集・ポリシー（`REPLAY_STALE` も）、3 engine・アプリ・モデル provider の失敗、4 内部エラー、130 中断（[docs/debugging.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/debugging.mdx)）。
- **テレメトリが既定で有効**。CLI がコマンド・engine・失敗箇所などを送る（テスト内容・アプリの内容・資格情報は送らない）。`E2E_TELEMETRY_DISABLED=1` か `npx e2e telemetry disable` で止める（[README](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/README.md)、[docs/telemetry.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/telemetry.mdx)）。

## mock の provider を挟めるか

- **公式の方法: custom executor**（[docs/executors.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/executors.mdx)）。`StepExecutor` の `runStep(ctx)` を自分で書けば、モデルも `ai` パッケージも無しで `act`・`assert` を処理できる。`ctx.observe()` で赤塗り済みの画面テキスト、`ctx.actions.tap({ id })` などで検査付きの操作ができる。ただし `waitFor`・`extract` は executor に回らず、組み込みの判定（モデル必須）を使う。
- `createToolLoopExecutor` で組み込みのループ（予算・判定・記録）を残したまま、ツールとプロンプトだけ差し替えることもできる。
- **AI SDK の mock モデル**: `model` は AI SDK の LanguageModel（仕様 v2 以降）なら何でも受け付け、判定は構造的に行う。e2e 自身のテストも「本物の `LanguageModelV2` インスタンスを返す台本付きモデル」で本番の経路を通している（[packages/e2e/tests/helpers/fake-model.ts](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/packages/e2e/tests/helpers/fake-model.ts)、公開 API ではない）。`ai/test` の `MockLanguageModelV4` を渡すと、決まった JSON を返させられる（手元で確認）。ただし `act` を mock で通すには、e2e 内部のツール呼び出しの形を真似る必要があり、その形は公開の契約ではない。
- ローカルの OpenAI 互換サーバー（固定応答を返す自前のスタブでもよい）を `createOpenAICompatible` で指す手もある。

## シナリオの書き方

- ファイルは既定で `tests/**/*.e2e.ts`、設定は `e2e.config.ts`。ランナーは独自（vitest や Playwright Test ではない）。`test`・`describe`・`beforeEach`・`test.extend` は Playwright Test に近い形（[docs/core-concepts.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/core-concepts.mdx)）。
- 1 つのテストに 3 種類のステップを混ぜる。

  | ステップ | API | モデル呼び出し |
  | --- | --- | --- |
  | 目標 | `agent.act('…')` | する（replay cache が当たれば無し） |
  | 判定 | `agent.assert`・`agent.waitFor`・`agent.extract` | する |
  | locator | `screen.getByRole(…)`・`expect(…)` | しない |

  ```ts
  import { test, expect } from 'e2e';

  test('a member upgrades to Pro', async ({ app, agent, screen }) => {
    await app.open('/settings/billing');
    await agent.act('upgrade the workspace to the Pro plan');
    await agent.assert('the invoice preview shows a prorated amount');
    await expect(screen.getByRole('status')).toContainText('Pro');
  });
  ```

- 書き方の勧め: `act` 1 回に目標 1 つ、画面の言葉を使う、テストデータは `params`、パスワードは `Secret`（モデルには名前しか見せない）、毎回違う値は `unique()`。`act` の直後に locator の `expect` か `agent.assert` を置く（置かないと replay cache に記録されない）。
- `agent.extract` は Zod などの Standard Schema で画面から値を取り出す。
- ほかに `e2e explore`（エージェントが自由に触ってバグを探す）、`e2e mcp`（Claude Code などのコーディングエージェントが stdio の MCP でアプリを触る）がある。どちらも replay cache は使わない。

## 結果の出力の形

- 端末: `list` 報告（既定）。失敗時はエラーコード、失敗した行、URL、`trace.md` の場所を出す。
- `.e2e/report.json`: 実行ごとに必ず書く。`schemaVersion: "report-1"` で、JSON Schema が [packages/e2e/schema/report-v1.schema.json](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/packages/e2e/schema/report-v1.schema.json) にある。run の状態・終了コード・環境・target・テストごとの結果とステップ（replay cache の判断 `step.cache.*` を含む）。
- `--reporter junit` で `.e2e/junit.xml`、`markdown` で `.e2e/summary.md`。`@e2e-dev/github` で PR に 1 つのコメント（再実行で上書き）。
- `.e2e/results/<test>/trace.md`: 失敗・flaky のテストごとに、ステップの中身、アプリのログ（console・例外・失敗したリクエスト）、エージェントの最後のターン、失敗時の画面。スクショ・動画（`--video`）も同じ所。
- `--debug` でステップごとの時間・呼び出し・トークン・費用、`--ai-trace` で全モデル呼び出しを `.e2e/ai-trace.json` に。
- 自作の reporter は `onEvent`（進行のイベント列）と `onRunFinished`（最終 report）を持つオブジェクト（[docs/reference/reporters.mdx](https://github.com/tester-army/e2e/blob/f1a1ac241042c089ae773213c4e4f0da34f2f3d8/docs/reference/reporters.mdx)）。

## 手元で試したこと

スクラッチディレクトリ（リポジトリの外）に `npm install -D e2e@0.18.0 @e2e-dev/web ai` で入れ（`@e2e-dev/web` は 0.13.0、`ai` は 7.0.133）、Node 26.9.0 で `E2E_TELEMETRY_DISABLED=1 npx e2e run --reporter list,junit,markdown` を回した。相手は `app.command` で起こした 127.0.0.1 の空きポートの Node の静的サーバー（ボタンを押すと状態が `Idle` → `Ready` になるページ）。

| テスト | 中身 | 結果 |
| --- | --- | --- |
| locator だけ | `getByRole('button', 'Start').tap()` → `expect(status).toHaveText('Ready')` | 通過、1.1 秒、モデル 0 回 |
| 自作 `StepExecutor` | `agent.act('press Start')`・`agent.assert('the status says Ready')` を、画面テキストから `#id` を拾って `ctx.actions.tap` する台本で処理 | 通過、0.6 秒、API キー無し |
| `MockLanguageModelV4` | `agent.assert` に `{"protocolVersion":"agent-judgment-2","explanation":"…","verdict":"holds"}` を返させる | 通過（最初に `{}` を返したら `MODEL_OUTPUT_INVALID: unknown protocolVersion` で落ちた） |

- Chromium はヘッドレスで起動し、`.e2e/report.json`・`junit.xml`・`summary.md` が出た。
- mock が受け取ったリクエストは `maxOutputTokens`・`toolChoice`・`responseFormat`（JSON Schema 名 `agent-judgment-2`）・`prompt`・`headers` で、`temperature` は無かった。

## live-mindmap に当てはめると

- **Playwright の版が揃う**。`@e2e-dev/web@0.13.0` は `playwright-core` 1.63.0 固定、`server` の devDependencies は `playwright ^1.63.0`。Chromium のキャッシュも共有できる見込み。Node の条件（`^22.22.3 || >=24.8.0`）も満たす。
- **地図はアクセシビリティツリーで読める見込み**。`web/src/MapNode.tsx` などは HTML の要素で描いており、canvas ではない。配置の良し悪し（重なり、兄弟の数）のような見た目の判定には `vision: true` が要り、その分トークンが増える。
- **起動**: `app.command` は 1 プロセス、シェル無し、環境変数は明示したものだけ。`play` CLI で録音をリプレイしつつ server と web を出すスクリプトを 1 本用意し、それを `app.command` にする形になる。macOS の helper は CI（ubuntu）では動かないので、今のサーバーテストと同じく偽の helper を使う前提。
- **Claude で回すなら API キーが要る**。e2e は Claude のサブスクリプションでのログインを持たない。地図を作る側（Agent SDK）とは別に、e2e のエージェント用に `ANTHROPIC_API_KEY` か AI Gateway のキーを用意することになる。
- **判定のぶれ**: 地図の中身は Claude が毎回違う形で作るので、`act` の replay cache は「地図を開く・畳む・レビュー画面を操作する」のような UI 操作には効くが、`assert` で地図の意味を判定する部分は毎回モデルを呼び、ぶれが残る。CI のゲートにするなら、正確に決まる部分は locator、意味の判定は「リトライで通れば flaky 扱い」と割り切るか、mock（`StepExecutor` か固定応答のモデル）で決定的にするかを選ぶことになる。
- **CLI**（`play` など）は e2e の外で今のテストのまま持つのが自然。
- **注意**: 1.0 前で「マイナーリリースの間で API と設定が変わりうる」と README にある（0.15.0 から 0.18.0 まで 1 週間）。入れるなら版を固定する。テレメトリは既定で有効なので、CI と手元で `E2E_TELEMETRY_DISABLED=1` を付ける。

## 未確認のこと

- 実モデル（Claude）での `act`・`assert` の成功率と、同じシナリオを繰り返したときの判定の一致率。キーを使う実測はしていない。
- `act` を mock モデルで通すための応答の形（内部のツール呼び出しの契約）。
- Chromium の起動フラグを渡せないことで困る場面があるか（live-mindmap の Web UI がマイクなどの権限を要るかどうか次第）。
