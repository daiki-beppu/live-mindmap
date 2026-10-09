# Claude Agent SDK と node-llama-cpp を管理ディレクトリから読み込む方法（Issue #620）

地図 #619 の調査チケット。Claude Agent SDK（CLI バイナリ込み）と node-llama-cpp を server の通常の依存から外し、`~/.live-mindmap/` の下の管理ディレクトリに固定版で入れて実行時に読み込めるかを、takt の deepseek-harness の作りを手本に、一次資料（npm のパッケージの中身・ソース・公式ドキュメント）と手元の実測で確かめた。結論は次のとおり。

- **どちらも、同梱した `package.json` と `package-lock.json` に対して管理ディレクトリで `npm ci --omit=dev --omit=peer --ignore-scripts` を走らせ、`createRequire(<dir>/package.json)` で解決したエントリを `import(pathToFileURL(...))` で読めば動く。** Claude は管理ディレクトリのバイナリ（Claude Code 2.1.288）が起動して API まで届き、node-llama-cpp は build なしの prebuilt で Metal を使って GGUF を読み、生成した。`sdk -> sdk-<uuid>` のシンボリックリンク経由でも同じ。
- **Claude Agent SDK はバイナリを「SDK 自身の位置から」探す。** `pathToClaudeCodeExecutable` を渡さなければ、`createRequire(fileURLToPath(import.meta.url))` で `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` を解決する。管理ディレクトリから SDK を読めば、バイナリも管理ディレクトリの中から見つかる。SDK とバイナリのパッケージは同じ版に完全一致で固定されている（0.3.288 ↔ 0.3.288、中身は Claude Code 2.1.288）。
- **node-llama-cpp のビルド済みバイナリはプラットフォーム別パッケージ（`@node-llama-cpp/mac-arm64-metal`）で配られ、`postinstall` は「prebuilt が使えるかの確認と、だめなら source から build」をするだけ。** `--ignore-scripts` で入れても prebuilt の Metal で動く。prebuilt は本体と版が完全一致のときだけ使われる。
- **固定版の lock は npm の `package-lock.json` を同梱して `npm ci` で入れるのがよい。** npm は Node に同梱されていて、takt の npm 探し（`process.execPath` の隣）がこの Mac の Homebrew の Node でも通る。pnpm で済ませる案は、利用者の手元に pnpm を要し、得るものがない。
- **型は devDependencies に残し、pnpm の `ignoredOptionalDependencies` でバイナリだけを落とせば、`tsc` は今のまま通る。** clone の形では `pnpm install` が devDependencies も入れるので、devDependencies に移すだけでは容量は減らない。
- **容量（darwin-arm64、`du -sk`）: Claude Agent SDK は約 224 MiB（235 MB。うちバイナリ 218.6 MiB）、node-llama-cpp は約 68 MiB（72 MB）。** Linux x64 では node-llama-cpp の CUDA・Vulkan 版まで入り、プラットフォーム別パッケージだけで 670 MB を超える。

## 調べ方

- takt: `nrslib/takt` を浅く clone した（`6a96d22`）。`managed/deepseek-harness/`、`src/infra/deepseek-harness/managed-package.ts`・`npm-command.ts`・`constants.ts`、`scripts/verify-deepseek-sdk-lock.mjs`、`package.json` を読んだ。#1738 は OPEN で、実装 PR はまだ無い（`gh pr list --search` で見つからない）。
- Claude Agent SDK: npm の `@anthropic-ai/claude-agent-sdk@0.3.288`（いまの `pnpm-lock.yaml` の版。latest は 0.3.295）を scratch に入れ、`sdk.mjs`・`sdk.d.ts`・`manifest.json` を読んだ。
- node-llama-cpp: npm の `node-llama-cpp@3.22.1`（latest）を scratch に入れ、`dist/cli/commands/OnPostInstallCommand.js`・`dist/bindings/utils/compileLLamaCpp.js`・`@node-llama-cpp/mac-arm64-metal/dist/index.js` と、公式ドキュメントの [troubleshooting#postinstall-behavior](https://node-llama-cpp.withcat.ai/guide/troubleshooting#postinstall-behavior) を読んだ。
- 実測の環境: macOS（Apple Silicon）、Node 26.9.0（Homebrew）、npm 11.19.1、pnpm 12.9.1。すべて `$TMPDIR` の下の scratch で行い、リポジトリには入れていない。

```sh
# 管理ディレクトリ相当に、固定版の package.json だけを置いて lock を作り、takt と同じ形で入れる
echo '{"name":"lm-claude-managed","private":true,"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.288"}}' > package.json
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
```

## 1. takt の deepseek-harness の作り

出典: [`managed-package.ts`](https://github.com/nrslib/takt/blob/6a96d22cd816676ea9c81c4d230396cc45e7a7a1/src/infra/deepseek-harness/managed-package.ts)、[`npm-command.ts`](https://github.com/nrslib/takt/blob/6a96d22cd816676ea9c81c4d230396cc45e7a7a1/src/infra/deepseek-harness/npm-command.ts)、[`managed/deepseek-harness/package.json`](https://github.com/nrslib/takt/blob/6a96d22cd816676ea9c81c4d230396cc45e7a7a1/managed/deepseek-harness/package.json)、[`scripts/verify-deepseek-sdk-lock.mjs`](https://github.com/nrslib/takt/blob/6a96d22cd816676ea9c81c4d230396cc45e7a7a1/scripts/verify-deepseek-sdk-lock.mjs)、[takt #1738](https://github.com/nrslib/takt/issues/1738)。

- **同梱する資産**: `managed/deepseek-harness/package.json`（`private`、依存は全部完全一致の版、`overrides` も持つ）と `package-lock.json`。本体の `package.json` の `files` に `managed/deepseek-harness/` を入れて npm パッケージに含める。資産の場所は `new URL('../../../managed/deepseek-harness/', import.meta.url)` で、本体のコードからの相対で引く。
- **置き場所**: `~/.takt/deepseek-harness/`（`TAKT_CONFIG_DIR` で上書き可）。中は `sdk`（現在版を指すシンボリックリンク）・`sdk-<uuid>/`（実体）・`install.lock`・`.ready.json`（各 `sdk-<uuid>` の中）。
- **入れ方**（`installDeepSeekHarness`）:
  1. 同梱の `package.json` と lock を読み、中の版が `constants.ts` の固定版と一致するか、lock の `packages["node_modules/<name>"].version` が `dependencies` と一致するかを確かめる（ずれていたら「TAKT を入れ直せ」で止める）。
  2. `install.lock` を排他で取る（待ちは 5 分まで）。
  3. `mkdtemp(<root>/.sdk-stage-)` に 2 つを複写し、そこで `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` を走らせる（タイムアウト 10 分、`AbortSignal` 対応）。
  4. 入った SDK のエントリ・ネイティブ部品の sha256 と、同梱 `package.json` / lock の sha256 を `.ready.json` に書き、もう一度検査する。
  5. stage を `sdk-<uuid>` に rename し、一時リンク `.sdk-link-<uuid> -> sdk-<uuid>` を作って `sdk` に rename する（リンクの差し替えを原子的にする）。古い版のディレクトリは消さない。途中で落ちたときの戻しにジャーナル（`.sdk-recovery.json`）を使う。
- **読み込み方**（`loadManagedDeepSeekHarnessModules`）: `sdk` を `lstat`/`readlink` で辿って `sdk-<uuid>` を得る（名前が `^sdk-[a-f0-9-]+$` でなければ拒否）→ `.ready.json` と同梱資産の sha256 を比べる → `createRequire(join(dir, 'package.json'))` で `require.resolve('<pkg>/package.json')` し、版を固定版と比べ、解決先が `dir/node_modules` の中にあるかを `realpath` で確かめる → `import(pathToFileURL(require.resolve('<pkg>')).href)`。
- **版の比較**: 「同梱 `package.json` の `dependencies` の版」と「入っている各パッケージの `package.json` の `version`」を 1 つずつ比べる。加えて同梱資産の sha256 が `.ready.json` と一致することを見る。いまの deepseek-harness は、ずれも未導入も同じ `DeepSeekHarnessInstallRequiredError` で止める（#1738 の要件 10 で「版違いは警告して動かす」に揃える予定）。
- **npm の探し方**（`resolveManagedNpmCommand`）: 明示の `npmPath` → `dirname(process.execPath)/../lib/node_modules/npm/bin/npm-cli.js`（公式の tar 配布の形）を `node` で実行 → `process.execPath` の隣の `npm` がシンボリックリンクで `npm-cli.js` を指していればそれを `node` で実行 → `PATH` の絶対パスの項目だけを順に見る（相対の項目は作業ディレクトリ次第なので飛ばす）。
- **型**: 本体の `package.json` では `@deepseek-ai/dsh*` を **devDependencies に完全一致の版で** 置き、コードは `typeof import('@deepseek-ai/dsh-sdk-client')` で型を付ける。`scripts/verify-deepseek-sdk-lock.mjs` が「本体の `dependencies` に `@deepseek-ai/*` が無い」「管理用 `package.json`・本体 devDependencies・`constants.ts` の版が一致する」「lock の版が一致する」「SDK の peer が管理用 `package.json` に明示で固定されている」を検査する。
- 補足: takt は lock を書く npm の版を固定し始めた（[takt #1749](https://github.com/nrslib/takt/pull/1749)、npm 11 で lock を書くと `npm ci` に要るエントリが消えた例があり、`npx npm@10.9.4` で書く）。

## 2. Claude Agent SDK

### バイナリの見つけ方

出典: npm の `@anthropic-ai/claude-agent-sdk@0.3.288` の `sdk.mjs`（bundle 済み。下は該当部分の抜き書き）と `sdk.d.ts`。

```js
// sdk.mjs（抜き書き。名前は minify のまま）
var Gl = "@anthropic-ai/claude-agent-sdk";
function i2(resolve, t = {}) {
  // linux は glibc/musl を判定して両方を候補に、それ以外は `${Gl}-${platform}-${arch}`
  // 候補ごとに resolve(`${pkg}/claude${win32 ? ".exe" : ""}`) し、存在すれば返す
}
let ny = d.pathToClaudeCodeExecutable;
if (!ny) {
  let Kt = fileURLToPath(import.meta.url), gn = createRequire(Kt), Cr = i2((Zi) => gn.resolve(Zi));
  if (!Cr) throw Error(`Native CLI binary for ${process.platform}-${process.arch} not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`);
  ny = Cr;
}
```

- `pathToClaudeCodeExecutable`（`sdk.d.ts`: "Path to the Claude Code executable. Uses the built-in executable if not specified."）を渡せばそれを使い、渡さなければ **SDK の `sdk.mjs` の位置を起点に** `createRequire` でプラットフォーム別パッケージの `claude` を解決する。
- したがって、管理ディレクトリの `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` を `import()` すれば、バイナリも同じ `node_modules` の `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` から見つかる。`pathToClaudeCodeExecutable` は要らない。
- `sdk.mjs` が import するのは Node の組み込みモジュールだけ（zod などは bundle 済み）。peer の `@anthropic-ai/sdk`・`@modelcontextprotocol/sdk`・`zod` は `query()` には要らない。

### 実測: 管理ディレクトリからの読み込み

`createRequire(<dir>/package.json).resolve("@anthropic-ai/claude-agent-sdk")` → `import(pathToFileURL(...))` → `query({ prompt: "hi", options: { tools: [], settingSources: [], persistSession: false, maxTurns: 1, env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-invalid" } } })`。

| 条件 | 結果 |
|---|---|
| 管理ディレクトリを直接 | `system/init` で `claude_code_version` = 2.1.288。結果は `Invalid API key`（バイナリが起動し API まで届いた） |
| `sdk -> 実体` のシンボリックリンク経由 | 同じ（`require.resolve` は実体のパスを返す） |
| `--omit=peer` で peer を入れない | 同じ |

### SDK の版とバイナリの版

- `@anthropic-ai/claude-agent-sdk@0.3.288` の `optionalDependencies` は 8 つのプラットフォーム別パッケージ（`-darwin-arm64`・`-darwin-x64`・`-linux-{x64,arm64}`・`-linux-{x64,arm64}-musl`・`-win32-{x64,arm64}`）を **すべて `0.3.288` の完全一致** で持つ。SDK の `package.json` の `claudeCodeVersion` は `2.1.288`。
- SDK の `manifest.json` は `version: "2.1.288"` と、プラットフォームごとのバイナリの `checksum`（sha256）と `size` を持つ。実測で `claude` の sha256 は manifest の `darwin-arm64.checksum`（`bbe93063…`）と一致し、`claude --version` は `2.1.288 (Claude Code)`。
- SDK は起動時に `CLAUDE_AGENT_SDK_VERSION=0.3.288` を子の環境に入れる。バイナリの版を SDK が照合する処理は見当たらなかった。版の一致は「SDK の版を 1 つ固定すれば、npm がバイナリの版も決める」ことで保たれる。
- live-mindmap 側での版の確かめ方の候補: 管理ディレクトリの `@anthropic-ai/claude-agent-sdk/package.json` の `version` と、プラットフォーム別パッケージの `package.json` の `version` を固定版と比べる。壊れの検査には `manifest.json` の checksum が使える（ハッシュ計算は 219 MiB を読むので、毎回の `start` で行うかは別に決める）。
- lock は 8 つすべてを `os`・`cpu`・`libc` 付きで持つ（`linux-*` は `libc: ["glibc"]` / `["musl"]`）。`npm ci` は手元に合うものだけを入れる（darwin-arm64 では `-darwin-arm64` だけ）。1 つの lock で各プラットフォームに使える。

## 3. node-llama-cpp

### ビルド済みバイナリの配り方

出典: npm の `node-llama-cpp@3.22.1` の `package.json`・`dist/cli/commands/OnPostInstallCommand.js`・`dist/bindings/utils/compileLLamaCpp.js`、`@node-llama-cpp/mac-arm64-metal@3.22.1`、公式 [troubleshooting#postinstall-behavior](https://node-llama-cpp.withcat.ai/guide/troubleshooting#postinstall-behavior)。

- **プラットフォーム別パッケージ**: `optionalDependencies` に 14 個（`mac-arm64-metal`・`mac-x64`・`linux-{x64,arm64,armv7l,riscv64}`・`linux-x64-{cuda,cuda-ext,vulkan}`・`win-*`）を **本体と同じ `3.22.1` の完全一致** で持つ。`mac-arm64-metal` の `bins/mac-arm64-metal/` に `llama-addon.node`・`libggml-metal.so`・`libllama.metal.v0.5.0.dylib` などが入っている。初回のダウンロードではない。
- **`postinstall`**（`node ./dist/cli/cli.js postinstall`）: `getLlamaForOptions(...)` を呼んで「prebuilt が手元で使えるか」を確かめ、使えなければ source から build する。公式ドキュメントも「prebuilt binaries が互換かを確かめ、だめなら build を試みる」と書き、`skip` にしたときは「互換でなければ、初めて `getLlama` を呼んだときに build を試みる」とある。つまり `postinstall` はバイナリを持ってくる処理ではない。
- **prebuilt の版の照合**: `getBinariesPathFromModules` は、プラットフォーム別パッケージの `getBinsDir()` が返す `packageVersion` が本体の版と一致しないと、その prebuilt を使わない。プラットフォーム別パッケージは bare specifier の `import()` で、本体の位置から解決される。
- 本体の `llama/`（34 MiB）は source から build するときの llama.cpp の source。prebuilt を使う限り使わない。

### 実測: `--ignore-scripts` で入れて、管理ディレクトリから Metal で動くか

`createRequire(<dir>/package.json).resolve("node-llama-cpp")` → `import(pathToFileURL(...))` → `getLlama({ build: "never", gpu: "auto", skipDownload: true, progressLogs: false })`。

| 項目 | 結果 |
|---|---|
| `llama.gpu` / `buildType` | `metal` / `prebuilt`（llama.cpp `v0.5.0` 相当の release） |
| `getLlama` までの時間 | 初回 17.3 秒、2 回目 0.25 秒（初回だけ遅い。原因は切り分けていない） |
| GGUF（`Qwen3.5-4B-Q4_K_M.gguf`）を読み、`LlamaChatSession.prompt`（`maxTokens: 8`） | 例外なく完了（出力は空文字。思考で 8 トークンを使い切ったとみられ、読み込みと生成が動くことの確認にとどめる） |
| 実行後に `node_modules` の下で書き換わったファイル | 無し |

- `build: "never"` を渡すと、prebuilt が使えない手元で source の build（cmake・Xcode が要る）に落ちず、失敗として返る。導入は `cli install` で、会議中は導入で止めない方針（#619）に合う。

## 4. lock の持ち方と npm の見つけ方

- **npm の `package-lock.json` を同梱して `npm ci` で入れるのがよい。** 理由:
  - npm は Node の公式配布と Homebrew の Node に同梱されている。pnpm は corepack か別の導入が要り、利用者の手元にあるとは限らない（clone の形では開発者に pnpm があるが、配る形が変わると崩れる）。
  - `npm ci` は lock と `package.json` が合わなければ失敗し、`node_modules` を作り直す。管理ディレクトリでの「固定版をそのまま再現」に合う。takt の手本もこれ。
  - 1 つの lock が全プラットフォームのパッケージを `os`/`cpu`/`libc` 付きで持つ（2・3 節）。
- **pnpm workspace との関係**: 管理用の `package.json` は、例えば `server/managed/claude/` に置いても、`pnpm-workspace.yaml` の `packages`（`web`・`server`・`helper`・`e2e` を列挙）に入らないので workspace の一員にならない。リポジトリの root の `package.json` に `workspaces` が無いので、そのディレクトリで npm を走らせても workspace としては扱われない（lock を書くのは開発者の手元・CI で、利用者の手元では `npm ci` だけ）。
- **lock を書く npm の版を固定する**: takt #1749 の例のとおり、npm のメジャーで lock の出力が変わりうる。`npx --yes npm@<版> install --package-lock-only` のように、書く版をスクリプトで決めておくとよい。
- **`--omit=peer` を足す**: Claude Agent SDK の peer（`@anthropic-ai/sdk` 19 MiB・`@modelcontextprotocol/sdk` 6 MiB・`zod` 8 MiB など 101 個）は `query()` に要らない。npm 7 以降は peer を既定で入れるので、`--omit=peer` で落とす（実測 285 MiB → 224 MiB、動作は同じ）。lock を書くときにも peer の entry は残るが、`npm ci --omit=peer` で入らない。
- **Node 24 以上で npm を確実に見つける**: takt の `resolveManagedNpmCommand` の順（明示 → `process.execPath` の `../lib/node_modules/npm/bin/npm-cli.js` → 隣の `npm` リンクの実体 → `PATH` の絶対パスの項目）がそのまま使える。この Mac の Homebrew の Node では、`process.execPath` = `/opt/homebrew/Cellar/node/26.9.0/bin/node` で 1 段目は無く、2 段目（`Cellar/node/26.9.0/bin/npm -> /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js`）で見つかった。npm を `node <npm-cli.js>` で実行すれば、どの `node` で入れるかも `process.execPath` に揃う（ネイティブの `.node` が別の Node 向けにならない）。公式の tar 配布の形（1 段目）は takt のコード上の前提で、ここでは実物を確かめていない。
- **`npm_execpath` は使わない**: `pnpm` のスクリプトから起動すると pnpm を指すので、npm を探す手掛かりにならない。

## 5. 型の解決

- 通常の `dependencies` から外し、**devDependencies に完全一致の版で残す**（takt と同じ）。コードは `import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"` と `typeof import("@anthropic-ai/claude-agent-sdk")` だけを使い、値の読み込みは管理ディレクトリからの `import()` にする。server の `tsconfig.json` は `verbatimModuleSyntax: true` なので、`import type` は出力に残らない。
- いまの `server/src/claude.ts` は `AgentSdk` サービス（`{ query: typeof query }`）の `Layer.succeed(AgentSdk, AgentSdk.of({ query }))` に静的 import の `query` を渡している。この `layer` を「管理ディレクトリから読み込んで `query` を渡す」ものに替えれば、他は変えずに済む見込み。
- **clone の形では devDependencies も入る**ので、移すだけではバイナリ（219 MiB）が開発者・利用者の手元に残る。`pnpm-workspace.yaml` に次を書くと、JS と型（SDK 5.3 MiB）は入り、バイナリは入らない。

  ```yaml
  ignoredOptionalDependencies:
    - "@anthropic-ai/claude-agent-sdk-*"
    - "@node-llama-cpp/*"
  ```

  実測（pnpm 12.9.1、scratch）: 上の設定で `@anthropic-ai/claude-agent-sdk@0.3.288` と `node-llama-cpp@3.22.1` を devDependencies に入れると、`node_modules/.pnpm` にプラットフォーム別パッケージが入らず、`import type` と `typeof import(...)` を使うファイルが `tsc`（TypeScript 7.0.2、`module`/`moduleResolution: nodenext`、`verbatimModuleSyntax`）で通った。`effect-tsgo diagnostics` は同じ型の解決に乗るので変わらない見込みだが、scratch では走らせていない。設定の出典は pnpm の [`ignoredOptionalDependencies`](https://pnpm.io/settings/dependency-resolution#ignoredoptionaldependencies)。
- ただし、いま本物の SDK を呼ぶテスト（heavy IT・E2E の記録）は `pnpm install` で入ったバイナリに頼っている可能性がある。どこから SDK を得るかは #619 の「テストと CI への影響」で扱う。
- takt と同じく、「管理用 `package.json` の版」「server の devDependencies の版」「コード中の固定版の定数」が一致することを検査するスクリプト（`server/scripts/check-*.ts` の並び）を置くと、ずれを防げる。

## 6. 容量

darwin-arm64、`npm ci --omit=dev --omit=peer --ignore-scripts` のあとの `du -sk`（1 KiB = 1024 B。MB は 10^6 B に換算）。

| もの | 中身 | 容量 |
|---|---|---|
| Claude Agent SDK 0.3.288 | `node_modules` 全体（2 パッケージ） | 229,260 KiB ≈ 224 MiB ≈ 235 MB |
|  | うち `claude`（バイナリ） | 229,255,312 B ≈ 218.6 MiB |
|  | うち SDK の JS・型 | 約 5.3 MiB |
|  | （参考）peer も入れたとき | 285 MiB |
| node-llama-cpp 3.22.1 | `node_modules` 全体（119 パッケージ） | 70,108 KiB ≈ 68 MiB ≈ 72 MB |
|  | うち `node-llama-cpp` 本体 | 40 MiB（うち source の `llama/` 34 MiB） |
|  | うち `@node-llama-cpp/mac-arm64-metal` | 14 MiB |
|  | うちその他の JS 依存 | 約 14 MiB |
| lock の大きさ | `package-lock.json` | Claude 52 KiB |

他のプラットフォーム（実測ではなく、`manifest.json` の `size` と npm の `dist.unpackedSize`）:

- Claude のバイナリ: darwin-x64 237.7 MB、linux-x64 245.7 MB、linux-arm64 245.1 MB、linux-x64-musl 239.5 MB、win32-x64 249.1 MB。
- node-llama-cpp: **Linux x64 glibc で `npm ci` すると、`os`/`cpu`/`libc` が合う `linux-x64`（30.4 MB）・`linux-x64-cuda`（189.4 MB）・`linux-x64-cuda-ext`（374.5 MB）・`linux-x64-vulkan`（73.8 MB）に加え、`cpu` に `x64` を含む `linux-arm64`・`linux-armv7l` まで入る**（`npm ci --os=linux --cpu=x64 --libc=glibc --dry-run` で確認）。Linux の CI で入れるなら、要らない版を落とす手立てが要る。macOS の `mac-arm64-metal` は 14.9 MB。

## 残る問い

- Linux（CI）で node-llama-cpp の CUDA・Vulkan 版まで入るのをどう避けるか（`npm ci` に `--omit=optional` を付けると prebuilt も消える。管理用 `package.json` を OS ごとに分けるか、`overrides` で潰すか）。
- バイナリの checksum（`manifest.json`）を、導入の直後だけ見るか、`start` のたびにも見るか（219 MiB の sha256 の時間は未計測）。
- node-llama-cpp の初回 `getLlama` が 17 秒かかった原因（Metal・dylib の初回読み込みか）と、それを `cli install` の中で済ませるか。
