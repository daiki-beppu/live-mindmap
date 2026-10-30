# Managed Claude

## 固定版を更新する

コマンドはリポジトリルートで実行する。この package は pnpm workspace の外にあり、同梱 lock の生成には package.json の `packageManager` に指定した npm（現在は `npm@11.19.1`）を使う。実行時の導入は、発見した npm でこの lock で `npm ci` を実行する。

開始前に、常駐サーバー（`pnpm dev`）へ `pnpm cli install claude` と `pnpm cli check` を実行し、旧版の `claude` が `state: "ready"` であることを確認する。以下の更新前後で同じ管理ルートを使う。

1. `server/managed-deps/claude/package.json` の `dependencies["@anthropic-ai/claude-agent-sdk"]` を更新先の完全固定版（`^`・`~` なし）に変更する。
2. 指定版の npm で隣の `package-lock.json` を再生成する。npm の版が異なる場合は、指定版を用意してから実行する。

```sh
test "$(npm --version)" = 11.19.1 && npm install --prefix server/managed-deps/claude --package-lock-only --ignore-scripts
```

3. `server/package.json` の型用 `devDependencies["@anthropic-ai/claude-agent-sdk"]` を同じ完全固定版にし、`pnpm-lock.yaml` と開発環境も更新する。`<更新先の固定版>` は手順1と同じ版に置き換える。`server/test/checkManagedLock.it.test.ts` の SDK 固定版期待値・fixture と、`server/test/managedClaudeLoad.it.test.ts` の `sdkVersion` も手順1と同じ完全固定版に合わせる。

```sh
pnpm --filter @live-mindmap/server add --save-dev --save-exact @anthropic-ai/claude-agent-sdk@<更新先の固定版>
pnpm install --frozen-lockfile
bash helper/scripts/build-webrtc-apm.sh
pnpm typecheck
```

管理 manifest・同梱 npm lock・型用 devDependencies・pnpm lock を同じ版に揃える。typecheck で版ずれが出た場合はこれらを確認する。

4. 旧版が導入済みの管理ルートをそのまま使い、常駐サーバーを停止して再起動する（`pnpm dev`）。固定版はモジュール読込時に取得される。`LIVE_MINDMAP_DEPS` を設定している場合は、更新前後のサーバーで同じ値を使う。

```sh
pnpm cli check
pnpm cli install claude
pnpm cli check
```

再起動後の最初の check では JSON の `items` にある `claude` が `state: "outdated"`、再導入後は `state: "ready"` になる。`missing` は旧版導入の確認にならない。CLI 本体（`node server/src/cli.ts check`）の終了コードは必須依存が不足すると3、任意依存だけの不足なら0。`pnpm cli check` は本体の3をラッパーの1として返すことがあるため、対象 item の状態を読む。Claude は選択モデルが Claude 経路のとき必須になる。更新確認にモデル呼出しや API キーは不要。

5. リポジトリルートで `pnpm test:external` を実行する。`server/test/managedClaude.external.test.ts` を含む2本の実導入テストが走る。server ディレクトリでも `pnpm test:external` で実行できる。

更新差分には管理 manifest・npm lock・server の devDependencies・pnpm lock・固定版を合わせたテストを含め、[Checks](../../../AGENTS.md#checks) の検証を実行する。
