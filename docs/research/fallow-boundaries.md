# 境界チェックで自前の check-*.ts を書けるか（fallow 3.33.1）

Issue #936（地図 #934）。2026-10-13 調査。

## 結論

- fallow で既存の規則を書くには、境界の設定（`boundaries`）だけでは足りない。次の 2 つを組み合わせる。
  - `boundaries.zones` と `boundaries.calls.forbidden`（禁止する呼び出し）
  - `rulePacks` の `banned-import`（import の禁止）
- `boundaries.rules`（zone 間の import 規則）が対象にできるのは、プロジェクト内のファイルどうしの import だけ。`node:fs` や `ws` のような npm・Node の組み込みモジュールは zone に入らないので、境界の import 規則では禁止できない。
- 書けるのは「どこで〜してはいけない」という禁止の規則だけ。次の規則は書けない。
  - 「この入口は必ず〜を呼ぶ」という、あることを求める規則
  - 「`runMain` に `teardown: exitNaturally` を渡す」という、呼び出しの引数を見る規則
  - `check-managed-lock.ts` が見る package.json と lock の版の一致。import を見る規則ではないので、境界のチェックの対象外。
- 報告は `path:line`（`--format compact` では `種類:path:line:…`）で出て、違反があれば exit 1。ただし次の 2 点で既存のスクリプトと違う。
  - `calls.forbidden` は 1 ファイルにつき同じ呼び出し先を 1 件しか報告しない。
  - `banned-import` は動的な `import()` を拾わない。
- `.test.ts` と `.it.test.ts`・`.heavy.test.ts` は区別できる。rule pack の `files`・`exclude` の glob を使う方法と、zone を先に一致したものが勝つ順に並べる方法の 2 通りがある。

## 規則と対応表

### `server/scripts/check-entrypoints.ts`（`src/**`・`bench/**` の `.ts` を正規表現で読む）

| # | 規則 | fallow | 使う設定 |
|---|------|--------|----------|
| E1 | `NodeRuntime.runMain(` を呼べるのは `src/server.ts`・`src/cli.ts`・bench の入口 7 本だけ | 書ける | `calls.forbidden` の `*.runMain`。許可するファイルを別の zone にする |
| E2 | 上の許可リストの各ファイルが、実際に `runMain` を呼んでいる | 書けない | あることを求める規則は無い |
| E3 | `Effect.runSync(`・`runSyncExit(` を呼べるのは `src/core/review.ts` だけ | 書ける | `*.runSync`・`*.runSyncExit` |
| E4 | `src/core/review.ts` が実際に `runSync` を呼んでいる | 書けない | E2 と同じ |
| E5 | `Effect.runPromise(`・`runPromiseExit(` はどこでも呼ばない | 書ける | `*.runPromise`・`*.runPromiseExit` |
| E6 | `src/server.ts` は `process.exit(` を呼ばない（改行をまたぐ呼び出しも拾う） | 書ける | `process.exit`。構文木で見るので改行は関係ない |
| E7 | `src/server.ts` は `onExit(` を呼ばない | 書ける | `onExit` と `*.onExit`（既存の正規表現 `\bonExit\s*\(` は `Effect.onExit(` にも当たるので、両方を並べる） |
| E8 | bench の入口は `process.exit(` を呼ばない | 書ける | `process.exit` |
| E9 | bench の入口の `runMain` に `teardown: exitNaturally` を渡す | 書けない | 呼び出しの引数は見ない |
| E10 | `//` で始まるコメント行は数えない | 書ける | 構文木で見るので、コメントは最初から数えない |

### `server/scripts/check-test-layers.ts`（server・web の `test/` を構文木で読む）

| # | 規則 | fallow | 使う設定 |
|---|------|--------|----------|
| T1 | 層をファイル名の接尾辞で決め、unit は `*.test.ts(x)` から `.it.test.`・`.heavy.test.` を除いたもの | 書ける | rule pack の `files` と `exclude`。または zone の順 |
| T2 | unit は `child_process`・`fs`・`fs/promises`・`http`・`net`・`ws`・`playwright`・`playwright-core`・`@anthropic-ai/claude-agent-sdk` を import しない。`node:` が付く書き方も同じ資源として扱う | 書ける | `banned-import`。指定は書かれたとおりの文字列との一致で、`node:` を外す処理は無い。そのため `fs` と `node:fs` を両方並べる。`fs` で `fs/promises` も覆える |
| T3 | `export … from "x"` の再エクスポートも対象 | 書ける | `banned-import` は再エクスポートも見る |
| T4 | `import type`、型の位置の `typeof import("x")`、`vi.mock("x")` は対象外 | 書ける | `"ignoreTypeOnly": true`。`typeof import` と `vi.mock` はもともと import として数えない |
| T5 | 動的な `await import("node:net")` も対象 | **書けない** | `banned-import` は静的な import と再エクスポートだけを見る |
| T6 | import の推移はたどらない | 同じ | `banned-import` も推移はたどらない |

まとめると「一部だけ」書ける。T5 の動的 import を見落とす。

### `server/scripts/check-managed-lock.ts`

| # | 規則 | fallow |
|---|------|--------|
| L1 | `package.json` の devDependencies の `playwright-core`・`@anthropic-ai/claude-agent-sdk` の版が、`managed-deps/<chromium\|claude>/package-lock.json` の固定版と一致する | 書けない（境界のチェックの対象外。import ではなく JSON の値を比べる） |

## 報告の形

- 人が読む形式では `src/core/session.ts:646 Effect.runPromise matches forbidden …`、`--format compact` では `boundary-call:src/core/session.ts:646:Effect.runPromise forbidden in zone effect-code (pattern *.runPromise)`。どちらにも `path:line` が出る。`banned-import` の違反は `policy-violation:test/agentSdk.test.ts:1:node:child_process banned by live-mindmap/unit-no-real-resource`。下の検証で確かめた。
- **呼び出しの報告は、1 ファイルにつき同じ呼び出し先を 1 件だけ**出す。既存のスクリプトは当たった行をすべて出すが、fallow は最初の 1 か所だけを出し、それを直すと次の回で次の箇所を出す。抽出の段階で、呼び出し先の文字列ごとに重複を除いている（[docs: Forbidden calls](https://fallow.tools/docs/configuration/boundaries.md) の「One finding per unique callee path per file」、[visit_impl.rs `record_callee_use`](https://github.com/fallow-rs/fallow/blob/v3.33.1/crates/extract/src/visitor/visit_impl.rs#L5474-L5490)）。検証用の小さなプロジェクトでも、`Effect.runSync` が 2 行あるファイルで 1 行しか出なかった。
- `banned-import` は import ごとに全件を出す（[policy/mod.rs `collect_banned_imports`](https://github.com/fallow-rs/fallow/blob/v3.33.1/crates/core/src/analyze/policy/mod.rs#L392)）。
- 重さ（severity）の既定値:
  - boundary の違反は `error`。
  - `policy-violation` は **既定で `warn`** で、warn だけなら exit 0 のまま終わる。落とすには、規則ごとに `"severity": "error"` を付けるか、`rules."policy-violation": "error"` にする（[docs: rulePacks](https://fallow.tools/docs/configuration/overview.md)、[docs: fallow architecture](https://fallow.tools/docs/cli/architecture.md)）。実際に試して、付けないと exit 0、付けると exit 1 になった。
- `fallow architecture` を範囲を絞らずに流すと、循環依存も `error` で出る。いまの server では `src/core/export.ts → src/core/session.ts → src/core/export.ts` が出る。境界と rule pack だけを見るなら、`fallow architecture --boundaries --policy` で範囲を絞る。

## 層をファイル名の接尾辞で分けられるか

2 通りの方法がある。どちらも試して、`.it.test.ts`・`.heavy.test.ts` が unit 扱いされないことを確かめた。

1. **rule pack の `files` と `exclude`**: `files: ["test/**/*.test.ts"]`、`exclude: ["test/**/*.it.test.ts", "test/**/*.heavy.test.ts"]`。`exclude` は `files` の後に当てられる（[rule-pack-schema.json](https://github.com/fallow-rs/fallow/blob/v3.33.1/rule-pack-schema.json)）。
2. **zone の順**: ファイルは、パターンに一致した最初の zone に入る（[docs: Boundaries](https://fallow.tools/docs/configuration/boundaries.md) の「first match wins」、[boundaries.rs `classify_zone`](https://github.com/fallow-rs/fallow/blob/v3.33.1/crates/config/src/config/boundaries.rs#L1445)）。`*.heavy.test.ts`、`*.it.test.ts`、`*.test.ts` の順に zone を並べれば分けられる。

注意: rule pack の規則が見るのは、エントリポイントから到達できるファイルとエントリポイントそのものだけ（[policy/mod.rs#L330](https://github.com/fallow-rs/fallow/blob/v3.33.1/crates/core/src/analyze/policy/mod.rs#L330)）。テストのファイルは vitest のプラグインがエントリポイントにするので、実際の server で対象になった。一方 `boundaries.calls.forbidden` は到達できるかどうかを問わず、zone に入ったファイルすべてを見る（docs の「also a file that no entry point reaches」）。入口の規則（E1〜E8）を `calls.forbidden` で書くのはこのため。

## 設定例（書ける規則）

server のパッケージを root として、`.fallowrc.json` を書く場合。

```jsonc
{
  "rulePacks": ["fallow-rules.json"],
  "boundaries": {
    "zones": [
      // 先に一致した zone が勝つ。狭いものを先に置く
      { "name": "entry-server", "patterns": ["src/server.ts"] },
      { "name": "entry-cli", "patterns": ["src/cli.ts"] },
      { "name": "entry-bench", "patterns": ["bench/sessionStats.ts", "bench/mapShape.ts", "bench/sttAccuracy.ts", "bench/sttLatency.ts", "bench/sttReplay.ts", "bench/edgeJudge.ts", "bench/siblingJudge.ts"] },
      { "name": "run-sync-boundary", "patterns": ["src/core/review.ts"] },
      { "name": "effect-code", "patterns": ["src/**/*.ts", "bench/**/*.ts"] }
    ],
    "calls": {
      "forbidden": [
        { "from": "effect-code", "callee": ["*.runMain", "*.runPromise", "*.runPromiseExit", "*.runSync", "*.runSyncExit"] },
        { "from": "run-sync-boundary", "callee": ["*.runMain", "*.runPromise", "*.runPromiseExit"] },
        { "from": "entry-cli", "callee": ["*.runPromise", "*.runPromiseExit", "*.runSync", "*.runSyncExit"] },
        { "from": "entry-server", "callee": ["process.exit", "onExit", "*.onExit", "*.runPromise", "*.runPromiseExit", "*.runSync", "*.runSyncExit"] },
        { "from": "entry-bench", "callee": ["process.exit", "*.runPromise", "*.runPromiseExit", "*.runSync", "*.runSyncExit"] }
      ]
    }
  }
}
```

`fallow-rules.json`:

```json
{
  "version": 1,
  "name": "live-mindmap",
  "rules": [
    {
      "id": "unit-no-real-resource",
      "kind": "banned-import",
      "specifiers": [
        "child_process", "node:child_process", "fs", "node:fs", "http", "node:http",
        "net", "node:net", "ws", "playwright", "playwright-core", "@anthropic-ai/claude-agent-sdk"
      ],
      "ignoreTypeOnly": true,
      "files": ["test/**/*.test.ts", "test/**/*.test.tsx"],
      "exclude": ["test/**/*.it.test.ts", "test/**/*.it.test.tsx", "test/**/*.heavy.test.ts", "test/**/*.heavy.test.tsx"],
      "severity": "error",
      "message": "unit が本物の資源を import している。.it.test.ts か .heavy.test.ts へ移す"
    }
  ]
}
```

web では、同じ rule pack を web のパッケージにも当てる必要がある。web にも設定を置くか、リポジトリのルートで glob を `web/test/**` にする。

## 検証

fallow 3.33.1（npm、darwin-arm64、署名検証あり）で 2 通りに試した。

1. **小さなプロジェクト**（scratchpad）: 次のことを確かめた。
   - 許可していない zone での `Effect.runSync`・`runPromise`・`NodeRuntime.runMain`、入口の `process.exit` を検出する。
   - `.test.ts` の `import … from "node:fs"` と `export … from "fs/promises"` を検出する。
   - `import type … from "ws"` と `typeof import("playwright")` は検出しない。
   - `.it.test.ts`・`.heavy.test.ts` の `node:fs`・`playwright` は検出しない。
   - **`await import("node:net")` は検出しない**。
   - 同じファイルの 2 つ目の `Effect.runSync` は報告しない。
2. **実際の server の写し**（node_modules は既存のチェックアウトのもの）: 上の設定で、境界と rule pack の違反は 0 件。既存のスクリプトも通っているので結果が一致する。わざと 2 つの違反を入れると、両方を `path:line` で検出した。
   - unit のテスト `test/agentSdk.test.ts` の 1 行目に `import { spawn } from "node:child_process"` を足した → `policy-violation:test/agentSdk.test.ts:1:…`
   - `src/core/session.ts` に `Effect.runPromise(...)` を足した → `boundary-call:src/core/session.ts:646:…`

## 出典

- fallow のドキュメント: [Boundaries の設定](https://fallow.tools/docs/configuration/boundaries.md)（zone の順、Forbidden calls の一致のしかたと制限）、[Configuration の rulePacks](https://fallow.tools/docs/configuration/overview.md)、[fallow architecture](https://fallow.tools/docs/cli/architecture.md)
- fallow のソース（タグ v3.33.1）:
  - [schema.json](https://github.com/fallow-rs/fallow/blob/v3.33.1/schema.json)（`BoundaryConfig`・`ForbiddenCallRule`）
  - [rule-pack-schema.json](https://github.com/fallow-rs/fallow/blob/v3.33.1/rule-pack-schema.json)
  - [boundary.rs](https://github.com/fallow-rs/fallow/blob/v3.33.1/crates/core/src/analyze/boundary.rs)（import 規則が見るのはグラフ内のファイル間の辺だけ。L103）
  - [boundary_calls/mod.rs](https://github.com/fallow-rs/fallow/blob/v3.33.1/crates/core/src/analyze/boundary_calls/mod.rs)（行と列の報告、`node:` を外して正規化する処理）
  - [policy/mod.rs](https://github.com/fallow-rs/fallow/blob/v3.33.1/crates/core/src/analyze/policy/mod.rs)（到達できるファイルに絞る処理、`specifier_matches` L683）
- 既存のスクリプト: `server/scripts/check-entrypoints.ts`、`server/scripts/check-test-layers.ts`、`server/scripts/check-managed-lock.ts`
