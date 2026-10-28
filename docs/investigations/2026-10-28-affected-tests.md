# 影響のあるテストだけを選んで走らせる方法（Issue #1696）

map #1694（CI を PR・main・Nightly・Weekly の段に分ける）の調査。pnpm workspace（server・web・e2e・helper）の vitest で、変更に影響するテストだけを選ぶ方法と、この repo に合うものを、一次情報（公式ドキュメント・入っている版のソース）と手元の試行で確かめた。結論は次のとおり。

- **vitest の `--changed` / `related` が第一候補。** 入っている vitest 5.0.3 は、テストファイルから Vite の SSR 変換の import（静的・動的）を辿って逆向きのグラフを作り、変わったファイルを推移的に import しているテストを選ぶ。web のテストが `../../server/src/...` を import する workspace 越しの依存も辿れる（試行で確認）。追加の道具は要らない。
- **ただし取りこぼしがある。** import にならない依存（`fs` で読む fixture、子プロセスで起動するスクリプト、`pnpm-lock.yaml`・`tsconfig.json`）は選ばれない。この repo では server の IT・heavy の多くが `node src/cli.ts` や `test/fixtures/fake-helper.ts` を子プロセスで起動し、fixture をパスで読むので、この穴は大きい。安全側の規則（下記）と、main への push・定期段での全件実行を組み合わせる前提でのみ使える。
- **fallow は選択器には向かない。** 影響を受けるテストの一覧を返すコマンドは無い。`fallow inspect --file` の `impact_closure` が 1 ファイルずつ逆向きの到達範囲を返すが、静的な構文解析で、vitest と同じ穴（子プロセス・`fs`）を持つ。
- **Turborepo・Nx の affected は費用に見合わない。** どちらも既定はパッケージ単位で、この repo は server と web の 2 パッケージが同時に変わることが多く、現在の `changes` ジョブのパスの絞り込みとほぼ同じ粒度にしかならない。web → server の相対 import は package.json の依存として宣言されていないので、宣言を足さないと取りこぼす。
- **CI の shallow checkout では、`--changed` に基準を渡す形が要る。** `--changed <ref>` は `git diff --name-only <ref>...HEAD`（3 点）を使うので merge-base が要る。`actions/checkout` の既定 `fetch-depth: 1` では失敗する。pull_request のマージコミットなら `fetch-depth: 2` で `--changed HEAD^1` が使える。あるいは `changes` ジョブが API で取っている変更ファイルの一覧を `vitest related` に渡せば git の履歴は要らない。

## 前提（この repo）

- vitest は server・web とも `^5.0.3`、lockfile で **5.0.3**（`pnpm-lock.yaml`）。`--changed` / `related` は入っている版の `node_modules/vitest/dist/chunks/index.DpLw24bj.js` を読んで確かめた（行番号は 5.0.3 のビルド成果物のもの）。
- vitest を使うのは server（`server/vitest.config.ts`）と web（`web/vite.config.ts`）だけ。どちらも `projects` で `unit`・`it`・`heavy` をファイル名の接尾辞で分ける。e2e は vitest ではない（`e2e run`、tester-army/e2e）、helper は Swift（`swift test`）。
- web の src・test は server のソースを相対パスで import する（例: `web/src/main.ts` → `../../server/src/core/capture.ts`、`web/test/review.mount.heavy.test.ts` → `../../server/test/fixtures/reviewTemplate.ts`）。`web/package.json` は `@live-mindmap/server` に依存していない。
- CI（`.github/workflows/check.yml`）は、`changes` ジョブが PR の変更ファイルを `gh api .../pulls/$PR/files` で取り、`ts`・`swift` の出力でジョブ単位に絞っている（checkout しない）。main への push は全部走る。
- test の数（`vitest list --filesOnly`）: server unit 117・it 66・heavy 25、web unit 53。

## vitest の `--changed`・`related` の仕組み

### 選び方（ソース）

`filterTestsBySource`（5.0.3 の `index.DpLw24bj.js` 18584 行付近）:

1. `--changed` のとき、VCS（既定は git）から変わったファイルの一覧を取り、`config.related` に入れる。`vitest related <files>` は一覧を直接 `config.related` に入れる。
2. 一覧のどれかが `forceRerunTriggers` に当たれば、**全テスト**を返す。
3. 一覧が空なら（watch でなければ）何も走らせない。`--changed` のときは `passWithNoTests` が既定で true になり（14650 行）、`vitest related` コマンドも `passWithNoTests ??= true`（`cac.DfDGTQ9W.js` 2326・2336 行）なので、0 件で成功終了する。
4. project ごとに `getAffectedModules` で逆向きのグラフを作る。各テストファイルを Vite の SSR 環境で `transformRequest` し、変換結果の `deps` と `dynamicDeps` を辿る。`node_modules` を含むパスと、存在しないパスは辿らない。変わったファイルから逆向きに辿って届いたテストファイルを選ぶ。

`--changed` の git コマンド（`GitVCSProvider`、20181 行付近）:

- `--changed`（引数なし）: `git diff --cached --name-only` と `git ls-files --other --modified --exclude-standard`（staged・unstaged・未追跡）。
- `--changed <ref>`: 上に加えて `git diff --name-only <ref>...HEAD`。
- パスは `git rev-parse --show-cdup` で求めた **repo のルート**から解決される。つまり server の vitest を走らせても、web や e2e の変更ファイルも一覧に入る。
- `experimental.vcsProvider` で git 以外の取り方に差し替えられる（`findChangedFiles` を持つ module）。

ドキュメント:

- CLI: `vitest related` は「Run only tests that cover a list of source files. Works with static imports, but not the dynamic ones」「All files should be relative to root folder」、`--changed [since]` は「Run tests that are affected by the changed files」。https://vitest.dev/guide/cli
  - 注: ドキュメントは「動的 import は対象外」と書くが、5.0.3 のソースは `dynamicDeps` も辿る。ただしパスが式で決まる動的 import は変換時に解決できないので辿れない（推論）。
- `forceRerunTriggers`: 既定 `['**/package.json', '**/vitest.config.*', '**/vite.config.*']`、「will run the whole test suite if the trigger is found in the git diff」。CLI から呼ぶスクリプトのように Vite が module graph を作れない依存は、トリガーに足すよう案内している。https://vitest.dev/config/forcereruntriggers
- 5.0.3 のソースでは、既定に加えて設定ファイル自身、`setupFiles`、`snapshotSerializers` もトリガーに足される（14550〜14595 行）。server の `test/setup.ts` を変えると server の全テストが走る。

### workspace をまたぐ import

辿れる。web で `server/src/core/capture.ts` に 1 行足して `vitest list --project unit --filesOnly --changed` を流すと、web の unit 53 本中 `test/capture.scene.test.ts`・`test/capture.story.test.ts` の 2 本が選ばれた。同じ変更で server は unit 5/117・it 42/66・heavy 5/25 を選んだ。グラフの構築は server で約 1 秒（手元、`vitest list --changed`）。

ただし変換後の import を辿るので、`import type` だけの依存（例: `web/src/kinds.ts` → server の `SnapshotNode`）は変換で消え、選ばれない（推論）。型の破れは全件の `tsc` が拾うので、テストの選択としては問題にならない。

### 設定ファイル・fixture・lockfile の変更（試行）

| 変えたファイル | server で選ばれたテスト | 理由 |
|---|---|---|
| `server/src/core/capture.ts` | 52 本（unit 5・it 42・heavy 5） | import グラフで届く |
| `server/test/fixtures/fake-helper.ts` | **0 本** | 子プロセスとして `join(import.meta.dirname, "fixtures/fake-helper.ts")` で起動するので import ではない。参照する 5 本（`audioMix.heavy`・`http.it`・`managedCaptureStop.it`・`managedDeps.heavy`・`server.heavy`）を取りこぼす |
| `pnpm-lock.yaml` + `server/tsconfig.json` | **0 本** | 既定のトリガーに無く、`node_modules` は辿らない |
| `e2e/package.json`（CI のパス） | 全件 | `**/package.json` に当たる。トリガーは repo 全体の変更に当たるので、別パッケージの package.json でも全件 |

server のテストで、子プロセスで `src/cli.ts`・`src/server.ts` を起動するものは 20 本、`fs` 読み・子プロセス・`new URL` などパスで別ファイルを使うものは server・web で 90 ファイルある（`grep`）。`src/cli.ts` が別の import 経路で届くテストは選ばれるが、子プロセス側だけが使うファイルの変更は選ばれない。

**落とし穴: `.` で始まるディレクトリの下では既定のトリガーが効かない。** トリガーは picomatch で絶対パスに当てるが、`**` は `.` で始まる段に当たらない。`/Users/.../.claude/worktrees/<name>/e2e/package.json` では `**/package.json` が false になる（picomatch で確認。`/home/runner/work/...` では true）。エージェントの worktree（`.claude/worktrees/`）で `--changed` を使うと、package.json や vite 設定の変更でも全件にならない。CI のランナーでは起きない。

### CI の shallow checkout での使い方

- `actions/checkout` は既定で `fetch-depth: 1`（その ref の 1 コミットだけ）、`0` で全履歴。pull_request ではマージコミットを checkout する（README の「Checkout pull request HEAD commit instead of merge commit」）。https://github.com/actions/checkout
- `--changed origin/main` は `git diff origin/main...HEAD`（merge-base が要る）なので、depth 1 では失敗する。
- 方法は 2 つ:
  1. `fetch-depth: 2` にして `vitest run --changed HEAD^1`。マージコミットの第 1 親は base の先端なので、`HEAD^1...HEAD` は「最新の main に PR を重ねた差分」になる。
  2. `changes` ジョブが API で取った変更ファイルを出力に渡し、`vitest related --run <files...>` に渡す。git の履歴が要らず、パス判定と選択が同じ一覧に基づく。パスは各パッケージの root からの相対（または絶対）で渡す。
- heavy ジョブは既に `vitest list --project heavy --json` で一覧を取ってから runner に配っている。`vitest list` も `--changed` を受け付ける（試行で確認）ので、一覧を取る段で絞れば分配の仕組みはそのまま使える。

### 新しい版の仕組み（参考）

`experimental.recordDependencies`（**5.0.4 で追加**、入っている 5.0.3 には無い）は、前回の実行で各テストファイルが実際に読み込んだ module を `cacheDir` の `dependencies.json` に記録し、静的グラフの代わりに使う。記録の無いテストは必ず走る。`vi.mock` の factory 内の import、呼ばれなかった動的 import、`fs` で読むファイル、外部化された module は記録されない。グローバル setup・設定ファイル・`.env` の変更はその project の全テストを走らせる。https://vitest.dev/config/experimental

CI で効かせるには記録を runner 間で持ち回る（`actions/cache`）必要があり、子プロセス・`fs` の穴は残る。今は採らず、静的グラフで足りないと分かったときの候補に留める。

## fallow の依存グラフ

- fallow 3.33.1 に「影響を受けるテストを選ぶ」コマンドは無い。`--changed-since <ref>` は「Only report issues in files changed since this git ref」で、指摘の範囲を絞るだけ。`--changed-workspaces <ref>` も解析の範囲の絞り込み（`fallow --help`）。
- `fallow inspect --file <path> --format json` の `evidence.impact_closure.data.affected_not_shown` が、そのファイルに逆向きに届くファイル（テストを含む、workspace をまたぐ）を返す。`server/src/core/capture.ts` で 79 ファイル（うち web 6）。ただし 1 回 1 ファイルで、出力に「syntactic attention pointer, not a correctness proof」とあるとおり構文的な追跡。`.fallowrc.json` の `entry` に挙げた `server/test/fixtures/fake-helper.ts` などは入口扱いで、それを子プロセスで起動するテストには届かない（vitest と同じ穴）。
- vitest が実際に走らせる module 解決（Vite の resolve・プラグイン）と別の解析なので、選択器にすると「vitest では届くのに fallow では届かない」ずれも抱える。選択には vitest 自身のグラフを使い、fallow は使わない。
- 出典: fallow の CLI ヘルプ（3.33.1）、https://github.com/fallow-rs/fallow

## Turborepo・Nx の affected

### Turborepo

- `turbo run <task> --affected` は「packages that are affected by changes on the current branch」。既定は**パッケージ単位**で「if any file in a package changed, all of its tasks are selected」。`futureFlags.affectedUsingTaskInputs` で task の `inputs` の glob 単位にできる。
- 既定は `--filter=...[main...HEAD]` 相当、`TURBO_SCM_BASE`・`TURBO_SCM_HEAD` で変えられる。「If the checkout is too shallow, then all packages will be considered changed」。
- https://turborepo.dev/docs/reference/run

### Nx

- `nx affected` は既定で task の inputs に触れたら選ぶ（Nx 23 以前はプロジェクト単位）。「By default, a change to your package manager's lock file affects every task」（`projectsAffectedByDependencyUpdates: "auto"` で絞れる）。
- GitHub では `nrwl/nx-set-shas` で base を main の最後の成功に合わせ、「`fetch-depth: 0` is required」。
- 既存の workspace へは `nx init` で `nx.json` と `nx` の devDependency を足す。Nx Cloud は必須ではない。
- https://nx.dev/docs/features/ci-features/affected 、https://nx.dev/docs/getting-started/start-with-existing-project

### この repo に入れたときの費用

- 粒度がパッケージ（または task の inputs の glob）で、**テストファイル単位では選ばない**。vitest の中で絞るにはどのみち `--changed` / `related` を併用する。
- この repo の TS のパッケージは server・web・e2e の 3 つで、server を変えると web と e2e も走らせる必要がある（web・e2e が server のソースを import する）。パッケージ単位の選択は、今の `changes` ジョブの `ts`/`swift` の絞り込みからほとんど減らない。
- web → server・e2e → server の依存は相対パスの import で、package.json の依存に無い。Turborepo・Nx に依存を教えるには package.json に workspace 依存を足すか、設定に暗黙の依存を書く必要がある。
- 新しい道具・設定（`turbo.json` / `nx.json`）・CI の履歴の取り方（Nx は全履歴）が増え、fallow の未使用依存・設定の扱いにも手が入る。得るもの（パッケージ単位の skip とキャッシュ）に対して見合わない。

## 取りこぼしを防ぐ安全側の規則

選択は「速くする」ための近似で、取りこぼしは main への push と定期段の全件実行で拾う前提にする。そのうえで PR 段では次を守る。

1. **全件に倒すファイル**（`forceRerunTriggers` に足す。既定を消さないよう `configDefaults.forceRerunTriggers` に足す形にする）:
   - `pnpm-lock.yaml`・`pnpm-workspace.yaml`（依存の版が変わる。既定に無い）
   - `**/package.json`・`**/{vite,vitest}.config.*`（既定）、`setupFiles`（自動）
   - `**/tsconfig*.json`（変換・解決の設定。既定に無い）
   - `**/test/fixtures/**`（`fs` で読む・子プロセスで起動する。fake-helper・transcript・jsonl など）
   - `server/src/cli.ts`・`server/src/server.ts`（子プロセスで起動される入口。そこから import されるファイルも子プロセス経由でしか届かないテストがあるので、厳密には `server/src/**` を IT・heavy では全件に倒すかを決める必要がある）
   - `server/scripts/**`・`server/managed-deps/**`・`scripts/**`・`helper/package.json`・`helper/Tests/HelperCoreTests/Fixtures/**`（テストがパスで読む・起動する。`checkWorkflow.it`・`helperScripts.it` など）
   - `.github/workflows/**`（`checkWorkflow` の IT がワークフローを読む）
2. **層で使い分ける。** unit はほぼ import で閉じる（`check-test-layers.ts` が unit からの実リソースの import を禁じている）ので選択の効きが良い。子プロセスを跨ぐ IT・heavy は穴が大きいので、IT・heavy は「全件に倒すファイル」を広めに取るか、選択しない。
3. **トリガーの glob を `.` で始まるディレクトリの下でも効かせる。** CI では問題ないが、エージェントの worktree（`.claude/worktrees/`）で手元選択をするなら、トリガーを絶対パスで書くか、ラッパーで判定する。
4. **0 件は成功にする（既定どおり）が、ログに選んだ本数と全体の本数を出す。** heavy ジョブの「runner N: x of y tests」と同じ形にする。
5. **main への push・Nightly は全件。** 選択は PR 段だけに使う（map #1694 の段の分け方と合わせる）。PR 段の取りこぼしは main の赤として現れるので、「When main goes red」の手順（`docs/agents/checks.md`）で拾える頻度かを、導入後に見る。
6. **typecheck・fallow は全件のまま。** 型だけの依存は選択に入らないので、全件の `tsc` が前提になる。

## この repo への推奨

- PR 段だけで、vitest 自身の静的グラフを使う。変更ファイルは `changes` ジョブの API の一覧を流用し、`vitest related --run`（または `vitest list` で一覧を取ってから `vitest run`）に渡す。git の履歴を増やさずに済む。
- 上の安全側の規則を `forceRerunTriggers`（server・web の設定）と `changes` ジョブの判定の両方で持つかは、仕様で決める（vitest の設定に置けば手元の `--changed` でも効くが、`.claude/worktrees/` の下では glob が効かない）。
- 効果の目安: `server/src/core/capture.ts` の変更で、server は 208 本中 52 本、web は 53 本中 2 本。`server/src/core/index.ts` のように多くが import する所を変えると大半が選ばれるので、効果は変更の場所次第。PR の実データで、選ばれた本数と時間を測ってから段に入れるかを決める。
- Turborepo・Nx・fallow は選択には使わない。
