# Linux のコンテナで通る検証コマンド（Issue #1787）

map #1784（Cursor と Claude cloud の開発環境）の research。Linux のコンテナ（macOS でない、Swift なし、API キーなし）で、ルートの `pnpm install`・`pnpm typecheck`・`pnpm test`・`pnpm test:it` のどれが、何を足せば通るかを調べた。

**確かめ方の限界:** この Mac には Docker などのコンテナ実行環境が無かった（`docker`・`podman`・`colima`・`orb`・`container`・`lima` のどれも無い）。そのため、コンテナで実際には流していない。答えは repo のコードと設定を読み、同じコマンドを ubuntu で流している CI の結果と照らして出した。CI の ubuntu runner は root でない `runner` ユーザーで動き、道具も多く入っている。この 2 点がクラウドのコンテナとの差として残る（下の「root で走らせると落ちるテスト」と「コンテナの前提」）。

## 結論

| コマンド（ルート） | Linux で | 理由 | 代わりに流すもの |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | そのまま通る | postinstall が無く、取得先は npm registry だけ。必要なネイティブ部品は linux-x64・arm64 の glibc 版が lock にある | そのまま |
| `pnpm typecheck` | 落ちる | `pnpm -r typecheck` が helper の `typecheck`（`build-apm` → `swift build`）まで走る | `pnpm --filter @live-mindmap/server --filter @live-mindmap/web --filter @live-mindmap/e2e typecheck && pnpm fallow` |
| `pnpm test` | 落ちる | `pnpm -r test` が helper の `test`（先頭で helper の `typecheck`、最後に `swift test`）まで走る | `pnpm --filter @live-mindmap/server --filter @live-mindmap/web test` |
| `pnpm test:it` | 落ちる | 同じく helper の `test:it` まで走る | `pnpm --filter @live-mindmap/server --filter @live-mindmap/web test:it` |

代わりのコマンドは、CI の `tests.yml` の ubuntu の job（`ts`・`unit`・`light`）が流しているものと同じ。2026-10-31 の main の push の run（[41165192818](https://github.com/daiki-beppu/live-mindmap/actions/runs/41165192818)、`1468f11`）で、`ts`・`unit`・`light (0)`・`light (1)` はどれも success（ubuntu-24.04・Node 24）。

足すものは、helper を外す `--filter` だけ。API キー・managed-deps・Chromium・Swift・uv はどれも要らない。ただし、root で走らせると light IT の 1 件が落ちる見込み（下記）。

## helper の巻き込み方と、既存の外し方

- ルートの `package.json` の scripts は `"typecheck": "pnpm -r typecheck && pnpm fallow"`、`"test": "pnpm -r test"`、`"test:it": "pnpm -r run test:it"`。`pnpm-workspace.yaml` の packages は `web`・`server`・`helper`・`e2e` の 4 つなので、`-r` は helper も含む。
- `helper/package.json`:
  - `typecheck` = `pnpm build-apm && node scripts/checkTestLayers.ts && swift build --build-tests -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/...`。`build-apm` は `helper/scripts/build-webrtc-apm.sh`（uv が要る）を走らせ、`swift build` は Swift と macOS 26 の SDK（SpeechAnalyzer）が要る。
  - `test`・`test:it`・`test:it:heavy` は、どれも先頭で `pnpm typecheck` を呼び、その後に `swift test --skip-build ...` を流す。
  - Linux のコンテナでは、どれも `swift`（または `uv`）が無くて落ちる。仮に Swift for Linux を入れても、macOS の SDK と CommandLineTools のパスに依存するので通らない。
- `e2e/package.json` には `test`・`test:it` が無いので、`pnpm -r test` からは外れる。`typecheck`（`tsc --noEmit`）はあり、CI の `ts` job が流している。
- 外し方の手本は `.github/workflows/tests.yml`。
  - `ts` job: `pnpm --filter @live-mindmap/server --filter @live-mindmap/web --filter @live-mindmap/e2e typecheck` の後に `pnpm fallow --format github-annotations --fail-on-issues`。コメントに「ルートの pnpm typecheck は helper の swift build まで走るので、TS のパッケージに絞る」とある。
  - `unit` job: `pnpm --filter @live-mindmap/server --filter @live-mindmap/web test`。
  - `light` job: `bash scripts/run-ci-tests.sh server it <shard> 2 files run` と `... web it 0 1 files run`。これは runner に分けるための形で、中身は `vitest run --project it`。1 台で全部を流すなら `pnpm --filter @live-mindmap/server --filter @live-mindmap/web test:it` と同じ集合になる（`run-ci-tests.sh` は `jq` も要る）。
  - helper は `runs-on: macos-26` の別 job。
- fallow は `.fallowrc.json` の `ignorePatterns: ["helper/**"]` で helper をもとから見ていないので、そのまま Linux で通る（CI の `ts` job が ubuntu で流している）。
- ルートの `pnpm fallow` は `--fail-on-issues` を自分で足すので、手元と同じ判定になる。

## install の時に走るもの・取得先

- postinstall・prepare は無い。ルートと 4 つの package の `package.json` に `preinstall`・`postinstall`・`prepare` は無く、`pnpm-lock.yaml` に `requiresBuild` の印も無い。
- `pnpm-workspace.yaml` の `ignoredOptionalDependencies: ['@anthropic-ai/claude-agent-sdk-*']` で、Claude SDK のネイティブの実行ファイルは通常の install に入らない（server の devDependency の `@anthropic-ai/claude-agent-sdk` は JS 部分だけ）。
- pnpm の版: `packageManager: pnpm@12.11.2`。lock の `importers['.'].packageManagerDependencies` にも `pnpm 12.11.2` があり、その実体の `@pnpm/exe.linux-x64`・`linux-arm64`（と musl 版）も lock に入っている。Node 24 に同梱の corepack（`corepack enable`）か、`npm i -g pnpm@12.11.2` で用意する。CI は `pnpm/setup@v3`（`packageManager` を読む）。
- 取得先は npm registry（`registry.npmjs.org`）だけ。git 依存や独自の tarball URL は無い。
- ネイティブ部品は、lock にあるものがすべて linux-x64・linux-arm64 の glibc 版を持つ。`@effect/tsgo-linux-*`、`@fallow-cli/linux-*-gnu`、`@typescript/typescript-linux-*`（TypeScript 7）、`@oxc-parser`・`@oxc-transform`・`@oxlint`・`@rolldown`・`@tailwindcss/oxide`・`lightningcss` の各 linux 版。`@effect/tsgo` には musl 版が無いので、Alpine ではなく Debian・Ubuntu 系（`node:24`・`node:24-slim` など）の image を使う。
- `verifyDepsBeforeRun: false` なので、install 済みかどうかの確認でスクリプトが止まることは無い。
- CI 以外では `CI` 環境変数が無く、pnpm が lockfile を更新しうる。クラウドの setup では `--frozen-lockfile` を付ける。

### managed-deps（install では取らない）

`server/managed-deps/` の Chromium と Claude SDK は install では取らず、`pnpm --filter @live-mindmap/server deps:install chromium|claude`（`server/scripts/install-managed-deps.ts` → `server/src/managedDeps.ts`）で、`LIVE_MINDMAP_DEPS`（既定 `~/.live-mindmap/deps`）に入れる。

- Claude: `server/managed-deps/claude/package-lock.json` で `npm ci --omit=dev --omit=peer --ignore-scripts`。取得先は `registry.npmjs.org`。`@anthropic-ai/claude-agent-sdk-linux-x64`・`linux-arm64`（と musl 版）も lock にある。
- Chromium: `server/managed-deps/chromium/package-lock.json` で `playwright-core 1.63.0` を `npm ci` し、`playwright-core/cli.js install --only-shell chromium` で headless shell を取る（Playwright の配布元）。Linux では `chrome-headless-shell-linux64` か `linux-arm64` を選ぶ。動かすには Chromium の共有ライブラリが要る（ubuntu runner には入っている）。
- cloudflared: GitHub の Releases から `/usr/bin/curl` で取り、`/usr/bin/tar` で展開する（`src/cloudflaredArtifact.ts`）。
- これらが要るのは heavy IT（`test:it:heavy`）と external（`test:external`）だけで、`typecheck`・`test`・`test:it` は要らない。

## unit・light IT の前提

`server`・`web` の unit と light IT（184 + 73 ファイル）を読んだ。

- macOS への依存: 無い。`/Library/...` の文字列は `helperScripts.it.test.ts` が helper の `package.json` の文字列として読むだけで、ファイルを開かない。`process.platform` は Linux で `linux`・musl を見分けるように書かれている（`managedSessionDeps.it.test.ts` など）。helper の実行ファイルや `helper/.build` も使わない（`helperPath.test.ts` はパスの組み立てだけ）。
- API キー: 要らない。`TYPESAFE_AI_API_KEY`・`ANTHROPIC_API_KEY` は `vi.stubEnv` や偽の値（`synthetic-key`）を入れて、鍵が有る・無い・渡さないの振る舞いを確かめるだけ。
- 外部ネットワーク: 使わない。URL は `*.invalid` やループバックだけ。unit は `server/scripts/check-test-layers.ts` が `node:fs`・`node:net`・`ws`・`playwright` の import を禁じている。
- 子プロセスと道具（light IT）: `bash`（`checkWorkflow.it`・`checkManagedLock.it` が CI の `run:` を偽の `pnpm`・`gh` で流す）、`node` に同梱の `npm`（`npmCommand.it`）。どちらも Debian 系の `node:24` 系 image にある。`git`・`jq`・`swift`・`uv`・Python は使わない。
- `server/vitest.config.ts` は `LIVE_MINDMAP_PORT=0` を渡し、`setupFiles` は `vi.waitFor` の既定の待ち時間を延ばすだけ。`web/vite.config.ts` は test の mode でプラグインを外す。どちらもブラウザや外部の準備を呼ばない。

### root で走らせると落ちるテスト

- `server/test/cliPublish.it.test.ts` の「一部を消せた後に記録の書き換えに失敗しても、残る物があれば「まだ置き場にある」を出す」は、`~/.live-mindmap/publish` を `chmod 0o500` にして書き込みを失敗させる。root は書き込み権限を無視するので、root のプロセスでは失敗が起きず、このテストは落ちる見込み。
- CI の ubuntu runner は root でない `runner` ユーザーなので、CI では表に出ない。
- クラウドのコンテナが root で動くなら、root でないユーザーで流すか、このテストを権限に頼らない形に直す必要がある。どちらにするかは仕様で決める。権限に頼るテストは、このテスト以外に見つからなかった（`chmod` で `0o[0-5]xx` にするのはこの 1 か所）。

## コンテナの前提

- Node 24 と、pnpm 12.11.2（corepack か `npm i -g`）。
- glibc の Linux（x64 か arm64）。Alpine は `@effect/tsgo` に musl 版が無いので外す。
- `bash`・`npm`（light IT）。`jq` は `scripts/run-ci-tests.sh` で runner に分けるときだけ要る。
- install に要るのは `registry.npmjs.org` への出口だけ。typecheck・test・test:it はネットワークを使わない。
- root でないユーザー（上記の 1 件のため）。

## 範囲外（今回の map の外）

- `pnpm test:it:heavy`: managed の Chromium と Claude SDK、Chromium の共有ライブラリ、子プロセスが要る。CI の `heavy` job は ubuntu で通しているので Linux でも動くが、`deps:install` のネットワーク取得と OS の部品を足す必要がある。
- `pnpm test:external`: 本物の取得をする。map の Out of scope。
- e2e（`pnpm --filter @live-mindmap/e2e test:e2e`）: Playwright のブラウザが要る。
- helper（Swift）のビルドとテスト: macOS 26 の SDK が要る。CI の macOS job に任せる。

## 出典

- `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`（`packageManagerDependencies`、各ネイティブ部品の linux 版）
- `server/package.json`、`web/package.json`、`helper/package.json`、`e2e/package.json`
- `.github/workflows/tests.yml`（`ts`・`unit`・`light`・`heavy`・`external`・`helper` job）、`.github/workflows/check.yml`
- `scripts/run-ci-tests.sh`、`.fallowrc.json`、`docs/agents/checks.md`
- `server/scripts/install-managed-deps.ts`、`server/src/managedDeps.ts`、`server/managed-deps/{claude,chromium}/package-lock.json`
- `server/vitest.config.ts`、`server/test/setup.ts`、`web/vite.config.ts`、`server/test/*.test.ts`・`web/test/*.test.ts`（heavy・external を除く）
- CI の run [41165192818](https://github.com/daiki-beppu/live-mindmap/actions/runs/41165192818)（main `1468f11`、2026-10-31）
