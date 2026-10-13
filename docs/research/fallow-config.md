# fallow の設定と動き方（live-mindmap にかけるとき）

調査日: 2026-10-13 / issue #935（map #934 の子）/ 対象: npm `fallow` 3.33.1（2026-10-10 公開、リポジトリ `fallow-rs/fallow` の 2026-10-13 時点の main `16435c8`）

一次資料は公式ドキュメント（https://fallow.tools/docs/ 。各ページは `.md` を付けると Markdown 版が取れる）、リポジトリのソース（`crates/core/src/plugins/*.rs`、`schema.json`、`rule-pack-schema.json`、`npm/fallow/package.json`、`docs/backwards-compatibility.md`、`BENCHMARKS.md`、`CHANGELOG.md`）、npm レジストリ（`npm view fallow time`）。この環境では `npx fallow@3.33.1 --version`・`--help` だけ走らせた（`fallow 3.33.1`、署名検証 `verified: yes`）。live-mindmap に実際にかけるのは #937 の仕事。

## 結論

1. **ルートから一度に走らせる。** fallow は `pnpm-workspace.yaml` を読んで全 workspace を 1 つのグラフで解析する。web と e2e は server を相対パス（`../../server/src/core/index.ts` など）で import しているので、workspace ごとに `--root` を切ると server 側の export が「未使用」に見える。出力を絞るなら `-w`（`--workspace`）で、グラフは全体のまま報告だけを絞る。設定はルートの `.fallowrc.json`（JSONC）1 枚。`pnpm-workspace.yaml` に `helper` が入っているので helper も workspace として拾われる（TS は `scripts/checkTestLayers*.ts` だけ）。外すなら `ignorePatterns: ["helper/**"]`。
2. **エントリポイントの大半は自動で取れる。足りないのは bench と e2e。**
   - 自動: `package.json` の scripts と CI ファイル（`.github/workflows/*.yml`）の `node src/server.ts`・`node src/cli.ts`・`node scripts/*.ts` は、引数のファイルがエントリになる。server の `bin`（`./src/cli.ts`）もエントリ。web の `index.html` の `<script src="/src/main.ts">` も使用として数える。vitest プラグインは `**/*.test.{ts,tsx,js,jsx}` をエントリにするので、`*.it.test.ts`・`*.heavy.test.ts` も含まれる。`vite.config.ts`・`vitest.config.ts` は vite / vitest プラグインが拾う。
   - 組み込みプラグインに **Effect・Foldkit・`e2e`（tester-army）は無い**（`crates/core/src/plugins/` に該当ファイルが無い）。Effect と Foldkit はライブラリとして import されるだけなのでプラグインは要らない（Foldkit の Vite プラグインは `vite.config.ts` から import されるので依存は「使用」になる）。
   - 手で足すもの: `server/bench/*.ts`（README で `node bench/…` と書くだけで scripts にも CI にも無い）、e2e の `tests/**/*.e2e.ts`・`e2e.config.ts`・`scripts/serve.ts`（`e2e.config.ts` が文字列で渡すだけ）。`entry` に globs で書くか、`fallow-plugin-e2e.jsonc`（`enablers: ["e2e"]`、`entryPoints`、`configPatterns`、`toolingDependencies`）を置く。
3. **既存分を許して新規分だけ落とす仕組みは 3 つある。** (a) `fallow audit`: PR の merge-base と比べ、PR が持ち込んだ指摘だけで落とす（`gate: "new-only"` が既定）。baseline ファイルは要らない。(b) `--save-baseline` / `--baseline`: dead-code・dupes・health ごとの baseline ファイルを commit し、それに無い指摘だけで落とす。`--fail-on-stale-baseline`（直ったのに残る行で落とす）と `--fail-on-baseline-growth`（baseline への追加で落とす＝減る一方にする）がある。(c) `--fail-on-regression`: 件数だけを比べる（`--tolerance` 付き）。
4. **CI 出力**: 終了コード 0（error 級なし・audit が pass/warn）、1（error 級あり・audit が fail）、2（設定や実行のエラー。JSON 形式なら stdout に `{"error": true, …}`）。形式は `json`・`sarif`・`github-annotations`・`github-summary`・`markdown`・`compact`・`codeclimate` ほか。**落とし穴**: 素の `fallow`（全解析）を JSON・SARIF・GitHub 系の形式で出すと、指摘があっても 0 で終わる。落とすには `--fail-on-issues`（または `--ci` = `--format sarif --fail-on-issues --quiet`）を付けるか、サブコマンド（`dead-code` など）を使う。時間は、公式ベンチで fastify（286 ファイル）が dead-code 64ms・dupes 90ms、vite（1,420 ファイル）が 595ms・174ms（M5、キャッシュなし）。live-mindmap の TS は約 400 ファイルなので 1 秒前後と見込む。audit は base 側も解析するので約 2 倍、health の churn は git 履歴を読む。
5. **4 機能の設定**（詳細は下の「根拠」）: 未使用は `rules`（`unused-files`・`unused-exports`・`unused-types`・`unused-dependencies` などを `error`/`warn`/`off`）と `entry`・`ignoreDependencies`・`ignoreExports`・`ignoreFindings`。重複は `duplicates`（`minTokens` 50・`minLines` 5・`minOccurrences` 2・`mode` `mild`・`threshold` 0＝上限なし）。複雑度は `health`（`maxCyclomatic` 20・`maxCognitive` 15・`maxCrap` 30・`maxUnitSize` 60・`thresholdOverrides`）と 0〜100 の健全性スコア。境界は `boundaries`（`zones`・`rules`・`coverage`・`calls.forbidden`）と、import や呼び出しを禁じる `rulePacks`。例外は `// fallow-ignore-next-line <種類> -- 理由`・`// fallow-ignore-file <種類>`・`/** @expected-unused */`、設定側の `overrides`・`ignore*`、重複の `ignoredClones`。
6. **配り方**: npm `fallow` は Node の薄い起動スクリプト（`bin/fallow`）で、本体は Rust のネイティブバイナリを `optionalDependencies`（`@fallow-cli/darwin-arm64`・`@fallow-cli/linux-x64-gnu` など 8 種）で配る。postinstall は無く、初回実行時に Ed25519 署名と SHA-256 を検証する。`fallow-type-aware`（TypeScript 7.0.2 に依存）も optional で入る。版の上がり方は速い: 2026-03-17 の 0.1.0 から 2026-10-10 の 3.33.1 まで 231 版、メジャーは 1.0（3/20）・2.0（3/25）・3.0（7/04）。3.x は約 3 か月で 33 マイナー、ほぼ週 1〜2 回出る。semver は守るが、**マイナーで検出規則が増え、精度も変わる**と明記しているので、マイナーを上げると指摘が増えうる。effect と同じく exact-pin し、上げるときは差分を見る。

## 根拠

### 1. pnpm workspace の扱い

- 自動検出: "Workspace detection is automatic. Fallow finds and analyzes all packages if your repo has one of these: … A `pnpm-workspace.yaml` file." "Fallow analyzes a monorepo as one project graph. When only a sibling package uses an export, fallow does not report it as unused."
  — https://fallow.tools/docs/configuration/workspaces.md
- `-w` は報告だけを絞る: "Fallow still analyzes the full monorepo graph and filters only the reported issues." `--changed-workspaces <REF>` は git の差分から workspace を選ぶ（`-w` と併用不可）。
  — 同上、https://fallow.tools/docs/cli/global-flags.md
- 設定ファイルは `.fallowrc.json` → `.fallowrc.jsonc` → `fallow.toml` → `.fallow.toml` の順に探し、"Fallow checks each directory up to the workspace root, and the first match wins." サブディレクトリから走らせると親の設定を読む（"A run from a package subdirectory loads the parent config"）。
  — https://fallow.tools/docs/configuration/overview.md 、workspaces.md
- この repo では web が `../../server/src/core/index.ts` を、e2e が `../../server/src/server.ts` などを相対パスで import している（`grep` で確認）。workspace をまたぐ相対 import なので、ルートを 1 つにして全体を 1 グラフにしないと server の export の使用が見えない。
- `pnpm-workspace.yaml` の `packages` に `helper` があり、`helper/package.json` もあるので helper も workspace になる。helper の TS は `scripts/checkTestLayers.ts` とそのテストだけ。

### 2. エントリポイント

**fallow が自分で見つけるもの**

- `package.json` の `main`・`module`・`types`・`source`・`browser`・`bin`・`exports`。
  — https://fallow.tools/docs/configuration/overview.md#entry-point-auto-detection
- scripts と CI の命令: "Fallow reads commands in package.json scripts (root and workspace packages), CI files (GitHub Actions and GitLab CI), Dockerfiles, Procfiles, and fly.toml files, and a file that a command names (such as `node scripts/seed.ts`) normally becomes an entry point." oxlint などの linter の引数はエントリにしない。
  — `schema.json` の `ignoreCommandEntries`、configuration/overview.md#ignorecommandentries
  - この repo で効くもの: server の `dev`・`cli`（`node src/server.ts`・`node src/cli.ts`）、`deps:install`（`node scripts/install-managed-deps.ts`）、`typecheck` 内の `node scripts/check-*.ts`、web の `typecheck` 内の `node ../server/scripts/check-test-layers.ts`、helper の `node scripts/checkTestLayers.ts`。server の `"bin": {"live-mindmap": "./src/cli.ts"}` も。
- HTML: "Files that only HTML, Vue, Svelte, Astro, MDX, GraphQL, or CSS reference still count as used." web の `index.html` は `/src/main.ts` を参照する。
  — https://fallow.tools/docs/analysis/file-types.md （llms.txt の要約）
- vitest プラグイン（`crates/core/src/plugins/vitest.rs`）:
  - `ENTRY_PATTERNS`: `**/*.test.{ts,tsx,js,jsx}`、`**/*.spec.…`、`**/__tests__/**`、`**/*.bench.…`。`foo.it.test.ts`・`foo.heavy.test.ts` もこれに当たる。
  - 有効化: `vitest` が依存にあるか、`vitest.config.*` / `vite.config.*` がその workspace のルートにあるとき。
  - 設定を読む: `test.include` があれば既定の entry を置き換え（`replace_entry_patterns`）、`test.projects[].test.include` は足す。`setupFiles` も参照として拾う。server・web の設定は root の `test.include` を持たず、`projects` の `include` に `**/*.it.test.?(c|m)[jt]s?(x)` のような extglob を書いている。既定の `**/*.test.ts` で全部拾えるので実害は無い見込みだが、extglob が glob として解釈できず警告が出るかは #937 で確かめる。
- vite プラグイン: "Entry points, `resolve.alias` mappings, plugin imports from `vite.config.ts`"。
  — https://fallow.tools/docs/frameworks/built-in.md
- 設定ファイルの解析の限界: "Conditional expressions … Nested factory functions" は扱えない。web の `vite.config.ts` は `defineConfig(({ mode }) => ({ plugins: [...(mode === "test" ? [] : [tailwindcss(), foldkit()])], … }))` という関数の形なので、中身の `test.projects` などは読めない可能性がある。ただし `foldkit`・`tailwindcss` は同じファイルの `import` で使用と数えられ、テストは既定パターンで拾えるので、影響は小さいと見込む。
  — https://fallow.tools/docs/analysis/limitations.md#config-parsing-ceiling

**組み込みプラグインに無いもの**

- 組み込みプラグインの一覧（`crates/core/src/plugins/` の 130 余のファイル。vite・vitest・playwright・oxlint・tailwind・typescript・pnpm などがある）に、Effect・Foldkit・`e2e`（tester-army）は無い。
- Effect と Foldkit は普通の import で使うライブラリなので、プラグインが無くても依存と export の使用は追える。Foldkit の Vite プラグイン（`@foldkit/vite-plugin`）は `vite.config.ts` から import されるので依存は「使用」になる。
- `e2e`（`e2e run tests/smoke …`）は fallow が知らない命令。`tests/smoke` はディレクトリなのでエントリにならない。`*.e2e.ts` は vitest のパターンにも当たらない。

**手で足す書き方**（ルートの `.fallowrc.json`、パスはプロジェクトルートからの相対）

```jsonc
{
  "$schema": "./node_modules/fallow/schema.json",
  "entry": [
    // README で `node bench/<名前>.ts` と書くだけで、scripts にも CI にも無い
    "server/bench/*.ts",
    // tester-army の e2e は組み込みプラグインが無い
    "e2e/e2e.config.ts",
    "e2e/tests/**/*.e2e.ts",
    // e2e.config.ts が文字列で渡すだけ（import ではない）
    "e2e/scripts/serve.ts"
  ],
  "ignorePatterns": ["helper/**"]
}
```

`entry` の説明: "Set it … when a file is a real runtime root that no plugin or manifest declares"（`schema.json`）。代わりに custom plugin（ルートの `fallow-plugin-<名前>.jsonc` は自動で読まれる）にすると、`enablers: ["e2e"]` で e2e がある workspace だけで効き、`toolingDependencies: ["e2e"]` で CLI 経由の依存も「使用」にできる。
— https://fallow.tools/docs/frameworks/custom-plugins.md

`fallow list`（エントリ・プラグイン・workspace の一覧）、`fallow list --plugins`、`fallow plugin-check`、`fallow dead-code --trace <file>:<export>` で、拾えているかを #937 で確かめられる。

**ほかに気になる点**（#937 で見るもの）

- 隠しディレクトリは辿らない（`.e2e/`・`.claude/`・`.takt/` は解析されない）。`.github` は既定で辿る。
  — https://fallow.tools/docs/analysis/limitations.md#hidden-directories-are-not-traversed
- server の `src/review.ts` は `vite`・`vite-plugin-singlefile` を実行時に import するが、どちらも server の `devDependencies` にある。`dev-dependencies-in-production`（既定 `warn`）に出るはず。
- e2e の `dependencies` の `ai`・`@ai-sdk/openai` は e2e のソースから import されていない（`@e2e-dev/web`・`e2e` の peer として要るなら）`unused-dependencies` に出る。`ignoreDependencies` で外す。
- `server/test/fixtures/**` は vitest プラグインの fixture パターン（`**/fixtures/**`）に当たる。

### 3. 既存分を許して新規分だけ落とす仕組み

**(a) `fallow audit`（PR の差分だけを見る。baseline ファイル不要）**

- "By default, only issues that the current PR or commit introduces fail the gate. Inherited findings in touched files show as context."
- base の決め方: `--base` → `FALLOW_AUDIT_BASE` → `@{upstream}` か `origin/HEAD`→`origin/main` との `git merge-base`。変更ファイルは `git diff --name-only <base>...HEAD`。`new-only` のときは base の時点でも同じ解析を走らせ、構造的なキー（dead-code は行番号を含まない規則・パス・名前、複雑度はパスと関数名）で照合する。
- `--gate all` は変更ファイル内の既存指摘でも落とす（base 側の解析を省くので速い）。
- 依存の指摘（unused dependencies など）は、その `package.json` を変えたときだけ audit に出る。
- 判定: pass（0）・warn（0）・fail（1）・error（2）。重複は `--threshold` を設定しない限り warn。
  — https://fallow.tools/docs/cli/audit.md
- CI では merge-base を取るため履歴が要る（GitHub Action の例は `fetch-depth: 0`）。この repo の `check.yml` は変更パス判定に `fetch-depth: 2` を使う形（docs/research/ci-path-filter.md）なので、audit を入れるなら base を取る checkout が別に要る。

**(b) baseline ファイル（全体を走らせて、既知の指摘を許す）**

- "save a baseline once with `npx fallow --save-baseline fallow-baseline.json`. Pass `--baseline fallow-baseline.json` on each later run, so that only new findings fail."
  — README.md の "Adopt fallow on an existing codebase"
- `--baseline`・`--save-baseline` は素の `fallow`・`dead-code`・`dupes`・`health` で使える。audit は種類ごとの `--dead-code-baseline`・`--health-baseline`・`--dupes-baseline`（または設定の `audit.deadCodeBaseline` など）。baseline は `.fallow/`（gitignore されるキャッシュ）の外に置く。
- `--fail-on-stale-baseline`: baseline の行で今回どれにも当たらないものがあると 1。直したら baseline も消させる。
- `--fail-on-baseline-growth`（`--baseline-base origin/main`）: base の同じファイルに無いキーが増えたら 1。「新しい指摘を baseline に足して黙らせる」を防ぎ、baseline を減る一方にする。shallow clone では base が解決できず 2 になる。
- `fallow baselines prune` で直った行を削る。
- health の baseline は既定で「ファイルと種類ごとの件数」で照合する（`--baseline-mode identity` で関数ごと）。
  — https://fallow.tools/docs/cli/global-flags.md 、https://fallow.tools/docs/cli/audit.md#baselines

**(c) 件数の回帰（`--fail-on-regression`）**

- "Fail if the issue count grows by more than the tolerance, compared with a regression baseline." `--tolerance "2%"` か `"5"`。件数は `--save-regression-baseline` で設定ファイルの `regression.baseline` か別ファイルに保存する。
  — global-flags.md、`schema.json` の `regression`

**(d) パッケージごとの基準**

- `workspaces.changedSince` で workspace ごとに git ref を決め、その ref 以降に変わったファイルだけを報告する（`check`・`dead-code`・`dupes` のみ。audit・health は読まない）。
  — workspaces.md#per-package-change-baselines

### 4. CI 向けの出力と時間

- 終了コード: 0 = error 級の指摘なし、または audit が pass/warn。1 = error 級あり、または audit が fail。2 = 入力・設定・実行のエラー（`--format json` なら stdout に `{"error": true, "message": "...", "exit_code": 2}`）。3 = 要求した資源が無い。8 = security ゲート。4〜7・10〜13 は runtime coverage・ネットワーク・アップロード。"must not hide exit code 2 with `|| true`"。
  — README.md "In pull requests"、https://fallow.tools/docs/integrations/ci.md#exit-codes
- 形式による差: "The bare `fallow` run in a machine format (JSON, SARIF, CodeClimate, the GitHub formats, and the comment and review formats) exits 0 on findings. The human, `compact` and `markdown` formats exit 1. With `--fail-on-issues` or `--ci`, the bare run exits 1 on error-severity findings in every format. When the run analyzes duplication, it also exits 1 when at least one clone group remains. `fallow dupes` without a gate flag exits 0."
  — ci.md#exit-codes
- `--fail-on-issues` は `warn` の dead-code 指摘を `error` に上げる。`dupes` と素の `fallow` では、重複が 1 群でも残れば落とす。
  — global-flags.md
- 形式: `human`・`json`・`sarif`・`compact`・`markdown`・`codeclimate`・`gitlab-codequality`・`pr-comment-github`・`review-github`・`github-annotations`・`github-summary`・`badge`。`--ci` = `--format sarif --fail-on-issues --quiet`。`-o` でファイルに、`--sarif-file` で SARIF を追加で出す。CI 形式での severity: `error` → `::error`、`warn` → `::warning`。JSON は `kind` を持ち、型は `fallow/types`、スキーマは `docs/output-schema.json`。
  — global-flags.md、https://fallow.tools/docs/configuration/rules.md#levels-in-ci-formats
- GitHub Action `fallow-rs/fallow@v3`: `command`（`dead-code`・`architecture`・`dupes`・`health`・`audit` など）、`annotations`（既定 true、workflow command で注釈）、`fail-on-issues`、PR コメント、SARIF のアップロード。"The Action installs the fallow version that the project's `package.json` names." PR では既定で変更ファイルに絞る（`auto-changed-since`）。Action を使わずに `pnpm exec fallow …` を走らせる形でも同じ CLI。
  — ci.md、README.md
- 時間（`BENCHMARKS.md` "Reference Results (2026-06-19)"、Apple M5・fallow 2.100.0・キャッシュなし・5 回の中央値）:

  | プロジェクト | ファイル数 | dead-code | dupes |
  |---|---:|---:|---:|
  | zod | 174 | 47ms | 54ms |
  | preact | 244 | 74ms | 58ms |
  | fastify | 286 | 64ms | 90ms |
  | vue/core | 522 | 138ms | 109ms |
  | vite | 1,420 | 595ms | 174ms |

  live-mindmap の git 管理下の `.ts`/`.js` は server 277・web 121・e2e 4・helper 2（計約 400）。dead-code・dupes は 1 秒未満の見込み。キャッシュは `.fallow/cache.bin`。GitHub の Linux ランナーは M5 より遅いが、秒の単位に収まると見込む。実測は #937 で `--performance` を付けて取る。

### 5. 4 機能の設定項目と例外

**未使用（コード・export・ファイル・依存）**

- `rules`（既定の重さ）: `unused-files` error、`unused-exports` error、`unused-types` error、`unused-dependencies` error、`unused-dev-dependencies` warn、`unused-optional-dependencies` warn、`unused-enum-members` error、`unused-class-members` error、`unresolved-imports` error、`unlisted-dependencies` error、`duplicate-exports` error、`circular-dependencies` error、`type-only-dependencies` warn、`test-only-dependencies` warn、`dev-dependencies-in-production` warn、`stale-suppressions` warn など。値は `error`（落とす）・`warn`（報告だけ）・`off`（検出しない）。
  — https://fallow.tools/docs/configuration/rules.md
- `overrides`: パスの globs ごとに `rules` を上書き（例: 生成物の下は `unused-exports: warn`）。後の項目が勝つ。
- そのほか: `entry`、`ignorePatterns`（解析から外す）、`ignoreFindings`（解析はして報告だけ隠す）、`ignoreDependencies`、`ignoreExports`（`{ file, exports }`）、`ignoreExportsUsedInFile`、`includeEntryExports`（エントリの export も検査する）、`publicPackages`、`dynamicallyLoaded`、`production`（テスト・開発用ファイルを外す）。
  — `schema.json`、configuration/overview.md
- `fallow fix --dry-run` → `fallow fix` で未使用の export・依存などを自動で消せる。

**重複**

- `duplicates`: `mode`（`strict`・`mild` 既定・`weak` 文字列を無視・`semantic` 識別子と値を無視）、`minTokens` 50、`minLines` 5、`minOccurrences` 2（2 未満は設定エラー）、`threshold` 0（重複率の上限 %、0 は無効）、`near`（関数単位の近似一致、既定 false）、`skipLocal`（ディレクトリをまたぐものだけ）、`ignoreImports` true、`ignore` globs、`ignoreDefaults` true、`ignoredClones`（`dup:<指紋>:<個数>`。中身か個数が変わるとまた出る）、`crossLanguage`、`normalization`。
  — configuration/overview.md#duplicates
- 判定: 素の `fallow` や audit では warn 扱い。`--fail-on-issues` か `threshold` を付けると落ちる（上の 4 を参照）。

**複雑度・健全性**

- `health`: `maxCyclomatic` 20、`maxCognitive` 15、`maxCrap` 30、`maxUnitSize` 60（行）、`crapRefactorBand` 5、`ignore` globs（指摘とスコアの両方から外す）、`thresholdOverrides`（`files`・`functions`・各 max・`reason`。例: テストは `maxUnitSize: 500`）、`coverage`（Istanbul か V8 のカバレッジで CRAP を正確に）。
  — configuration/overview.md#health
- 規則: `complexity-cyclomatic`・`complexity-cognitive`・`complexity-crap` は既定 `error`。`warn` にすると `fallow health` は 0 で終わり、audit は warn。
  — rules.md#complexity-rules
- スコア: `fallow health --score` で 0〜100、A（85 以上）〜F（40 未満）。死んだファイル・export、複雑度、保守性、ホットスポット（git churn）、未使用依存、循環、関数の長さ、結合、重複（5% を超えた分）から減点。`max*` の閾値はスコアを動かさない（スコアの重みは固定）。GitHub Action の `min-score` で下限を落とす条件にできる。
  — https://fallow.tools/docs/explanations/health.md#health-score
- live-mindmap では `describe` が長いテストが多いので、テストに `thresholdOverrides` で `maxUnitSize` を上げるか、`health.ignore` で外すかを決めることになる。

**アーキテクチャの境界**

- `boundaries.zones`: `{ name, patterns, autoDiscover?, root? }`。1 ファイルは最初に当たった zone に属し、どの zone にも当たらないファイルは制限なし。
- `boundaries.rules`: `{ from, allow, allowTypeOnly? }`。規則の無い zone は制限なし、`allow: []` は孤立。同じ zone 内は常に可。
- `boundaries.coverage`: `requireAllFiles`（どの zone にも当たらないファイルを報告）、`allowUnmatched`。
- `boundaries.calls.forbidden`: `{ from: <zone>, callee: "child_process.*" | [...] }`。呼び出しを import 解決込みで照合する。
- `preset`: `layered`・`hexagonal`・`feature-sliced`・`bulletproof`。live-mindmap の構成（server/src/core と周辺、web、e2e）にはどれも合わないので、カスタム zone で書くことになる。
- 報告は `fallow architecture`（循環・再 export の循環・パッケージ間の循環・境界違反・rule pack 違反）。`boundary-violation` は既定 error。
  — https://fallow.tools/docs/configuration/boundaries.md
- **rule pack**（`rulePacks: ["./rule-packs/x.jsonc"]`）: `banned-import`（import 指定子を禁止。`files`・`exclude` globs、`ignoreTypeOnly`）、`banned-call`（呼び出しを禁止）、`banned-export`。結果は `policy-violation`（既定 warn、規則ごとに `severity` で上書き可）。
  — configuration/overview.md#rulepacks、`rule-pack-schema.json`
  - 自前の `check-test-layers.ts`（unit テストが `fs`・`net`・`ws`・`playwright` などを直接 import しない）は、`banned-import` で `files: ["**/*.test.ts"]`、`exclude: ["**/*.it.test.ts", "**/*.heavy.test.ts"]`、`ignoreTypeOnly: true` と書ける形に近い。ただし今のスクリプトは `typeof import("x")` を型として外し、`vi.mock("x")` を数えない、などの細かい扱いをしているので、置き換えられるかは #937 で突き合わせる。
  - `check-entrypoints.ts`（`runMain` は `src/server.ts`・`src/cli.ts`・bench だけ、`runSync` は `src/core/review.ts` だけ、`process.exit` 禁止など）は `banned-call` に `files`/`exclude` を付けた形に近い。ただし callee の照合は import 解決込みのパス（`NodeRuntime.runMain` など）なので、`.pipe(...)` の後ろでメソッドとして呼ぶ形を拾えるかは確かめる必要がある。`check-managed-lock.ts` は lock ファイルの検査で、fallow の範囲外。

**例外（無視）の書き方**

- 行・ファイル単位のコメント: `// fallow-ignore-next-line`（その行の全部）、`// fallow-ignore-next-line unused-export`、`// fallow-ignore-next-line unused-export, complexity`、`// fallow-ignore-file`、`// fallow-ignore-file complexity`。末尾に `-- 理由` を書ける。`require-suppression-reason`（既定 off）で理由を必須にできる。
- 主なトークン: `unused-file`（ファイル単位のみ）、`unused-export`、`unused-type`、`unused-class-member`、`unused-enum-member`、`unresolved-import`、`code-duplication`、`circular-dependency`、`complexity`（循環的・認知的の両方）、`boundary-violation`、`policy-violation:<pack>/<rule-id>`。
- 依存の指摘はソースのコメントでは消せない（`ignoreDependencies` を使う）。
- JSDoc: `/** @public */`・`@internal`・`@beta`・`@alpha` は未使用として報告しない。`/** @expected-unused */` は、後で使われると `stale-suppressions` で知らせる。
- 一覧: `fallow suppressions`。古くなった抑制は `stale-suppressions`（warn）で出る。
  — https://fallow.tools/docs/configuration/suppression.md

### 6. 配り方とバージョンの上がり方

- `npm/fallow/package.json`（3.33.1）: `bin` は `fallow`・`fallow-lsp`・`fallow-mcp`（Node の起動スクリプト）。`dependencies` は `detect-libc` だけ。`optionalDependencies` に `@fallow-cli/darwin-arm64`・`darwin-x64`・`linux-x64-gnu`・`linux-arm64-gnu`・`linux-x64-musl`・`linux-arm64-musl`・`win32-arm64-msvc`・`win32-x64-msvc` と `fallow-type-aware`（すべて 3.33.1 の exact）。`engines.node` は `>=22`。
- `fallow-type-aware` は `typescript@7.0.2` に依存する（`tools/type-aware-sidecar/package.json`）。`--type-aware` を使わないなら、pnpm の `ignoredOptionalDependencies` に足して入れない選択もある。
- postinstall は無い。"The npm wrapper used to run verification during `postinstall`. Fallow removed that hook before npm RFC 868 …" 初回実行時に Ed25519 署名と SHA-256 を検証し、結果を sentinel ファイルに残す（`npm/fallow/scripts/lazy-verify.js`）。pnpm の build スクリプトの許可は要らない。
  — ci.md#binary-verification
- 他の入れ方: `cargo install fallow-cli`、GitHub Releases のバイナリ、Docker。
  — https://fallow.tools/docs/installation.md
- 版の数（`npm view fallow time`、2026-10-13 時点）: 全 231 版。0.x 6 版（3/17〜3/18）、1.x 14 版（3/20〜3/25）、2.x 172 版（3/25〜7/01、最終 2.104.0）、3.x 39 版（7/04〜10/10）。直近は 3.21.0（8/31）から 3.33.1（10/10）まで 15 版で、週 1〜2 回出る。
- 互換の方針（`docs/backwards-compatibility.md`）: v1.0 から semver。設定ファイル名・文書化された設定項目・規則名と重さの値・`extends`/`overrides` の意味・JSON 出力などは安定で、壊すときはメジャーを上げ、前のメジャーで非推奨の警告を出す。一方 "What may change in minor/patch versions" に "New issue types may be added"・"New plugins may be added"・"Detection accuracy: false positive/negative rates may improve"・"Human-readable output"・"SARIF output details" がある。マイナーを上げると、新しい規則や検出の変化で指摘が増減しうる。
- 2.0.0 の破壊的変更は、素の `fallow` が全解析を走らせるようになったこと、`check` → `dead-code` の改名、JSON の形の変更。3.0.0 は機能追加が中心で、"CLI wire contracts, config, and output formats are unchanged" と書いている。3.x の中でも "Notable behavior changes within v3"（health の churn キャッシュ、未使用ファイル内の export 指摘を隠す、など）が並ぶ。
- 設定の `minimumVersion` で「この設定はこの版以上向け」と宣言でき、古いバイナリは両方の版を示して止まる。
  — `schema.json` の `minimumVersion`
- まとめ: effect と同じく `fallow` を exact で固定する（GitHub Action を使う場合も `package.json` の版を読む）。上げるときは、新しい版で `fallow` を全体に走らせて指摘の差分を見て、baseline も取り直す、という手順になる。

## #937（試し走らせ）に向けた注意

- ルートで `pnpm add -Dw fallow@3.33.1`（exact）。`.fallow/` を `.gitignore` に足す。
- まず `fallow list --workspaces`・`fallow list --plugins`・`fallow list`（エントリ）で、server・web・e2e（と helper）が workspace として出るか、vitest・vite・oxlint・tailwind・typescript のプラグインが有効か、`node src/server.ts` などの scripts がエントリになっているかを見る。
- `server/bench/*.ts` と e2e のエントリを `entry` に足さないと、bench のスクリプトと e2e のテスト・`serve.ts` が unused file になり、そこからしか使われない server の export も未使用に見える。
- 素の `fallow --format json` は指摘があっても 0 で終わる。件数を数えるなら JSON、落ちるかを見るならサブコマンドか `--fail-on-issues`。
- 予想される指摘: server の `vite`・`vite-plugin-singlefile` の `dev-dependencies-in-production`、e2e の `ai`・`@ai-sdk/openai` の `unused-dependencies`、長いテストの large function（`maxUnitSize` 60）。
- web の `vite.config.ts` は関数の形と条件式なので、設定の中身が読めない旨の警告が出るか見る。server・web の vitest の extglob の `include` も同様。
- 時間は `--performance` で取る。audit を試すなら merge-base が要るので、浅い clone ではなく履歴のある checkout で。
- 境界（`boundaries`・`rulePacks`）は、自前の `check-test-layers.ts`・`check-entrypoints.ts` と同じ違反を拾えるかを、わざと違反を 1 件入れて比べる。
