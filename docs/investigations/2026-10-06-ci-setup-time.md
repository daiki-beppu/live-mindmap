# CI の各ジョブのセットアップを短くする方法（Issue #222）

map #217（CI を並列化して 1 分未満で green にする）の調査。今の `check.yml` は 1 ジョブで、テストの前のセットアップに 40〜60 秒かかる。どこに時間がかかっていて、ジョブごとにどこまで縮むかを、一次情報と実測で確かめた。

## 結論

- **TS ジョブ（server / web の型検査・テスト）のセットアップは、ubuntu で約 8 秒、macOS で約 11 秒まで縮む**（Set up job・checkout・pnpm と Node・`pnpm install` の合計、ステップ時間の中央値）。今の並びは macOS で約 27 秒、check.yml 全体のセットアップは直近 3 回で 35〜45 秒。playwright が要るジョブはここに +4 秒（ubuntu）/ +6 秒（macOS）。
- **pnpm と Node は `pnpm/setup@v3` の 1 ステップにし、依存のキャッシュはやめる。** 今の `pnpm/action-setup@v6`（npm で pnpm v11 を入れてから v12 に切り替える、7〜9 秒）と `actions/setup-node@v7` の `cache: pnpm`（286 MB の store を戻す、8〜15 秒）が一番の重さだった。キャッシュを戻すより、レジストリから取り直すほうが速い（`pnpm install` は ubuntu 2 秒・macOS 4〜6 秒）。
- **playwright は `--only-shell` で headless shell だけ入れる。** 撮影は `chromium.launch()`（既定の headless）なので headless shell しか使わない。full の Chromium も落とす今の形の半分以下（ubuntu 9→4 秒、macOS 14→6 秒）。入れるのは server のテストのうち `capture.test.ts` と `server.test.ts` の 1 件を走らせるジョブだけ。
- **ubuntu で `--with-deps`（`install-deps`）は要らない。** ubuntu-latest（24.04）の画像のままで headless shell が起動した。`install-deps` は 12〜24 秒かかるので入れない。ただし ubuntu-latest は 2026-10-19 から Ubuntu 26 に移るので、ランナーを `ubuntu-24.04` に固定するか、移行後に起動を確かめ直す。
- **uv は webrtc-apm のキャッシュが外れたときだけ入れる。** 入れるときも `enable-cache: false` にする（既定の `auto` は node_modules を含むリポジトリ全体を glob で探して 4〜6 秒かかる。`false` なら 1 秒）。helper のジョブは Node も pnpm も要らない（`swift build` / `swift test` を直接呼べる）。
- **playwright のブラウザのキャッシュは任意。** 当たれば 1〜3 秒で、`--only-shell` の取得（3〜9 秒）より 2〜4 秒速い。Playwright の公式ドキュメントは「キャッシュを戻す時間は取得とほぼ同じ」として勧めていない。playwright を使うジョブが一番遅いジョブになったときだけ足せばよい。
- **ubuntu と macOS の起動の違い**: Set up job は両方 0〜3 秒で差がない。違いは割り当て待ちと、同じステップの遅さ（macOS は 1.5〜2 倍）。macOS は Free プランで同時 5 ジョブまでで、5 本を超えると並ぶ（実測で 167〜267 秒待った回がある）。

## 測り方

- 一時ワークフロー `.github/workflows/setup-measure.yml` を `research/ci-setup` ブランチに置いて push し、`gh run view <id> --json jobs` のステップの開始・終了時刻から秒数を出した（ワークフローはコミット `57cdc86` にある。この調査のコミットで消した）。
- ランナー: `ubuntu-latest`（Ubuntu 24.04、x64、4 CPU / 16 GB）と `macos-26`（arm64、M1 3 CPU / 7 GB）。[GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- 1 回目（キャッシュが空）は除き、キャッシュが温まった後の 5 回（後から足した 3 変種は 3 回）。値は中央値（最小〜最大）、単位は秒。ステップの秒数は GitHub の記録が 1 秒単位なので ±1 秒の誤差がある。
- 比べたもの（すべて `actions/checkout@v7` の後）:
  - `current`: 今の check.yml の並び（`pnpm/action-setup@v6` → `setup-node@v7` + `cache: pnpm` → `pnpm install --frozen-lockfile` → `playwright install chromium`）
  - `no-cache`: 同じ並びで、setup-node のキャッシュを切る（`package-manager-cache: false`）
  - `action-setup-cache`: キャッシュを `pnpm/action-setup` の `cache: true` で取る
  - `pnpm-setup`: `pnpm/setup@v3`（`runtime: node@24`、`cache: true`）
  - `pnpm-setup-nocache`: `pnpm/setup@v3`（`runtime: node@24`、キャッシュなし）
  - `pnpm-setup-noruntime`（macOS だけ）: `pnpm/setup@v3`、Node は入れずランナーの Node 24 を使う
  - `npm-global`: `setup-node@v7`（キャッシュなし）+ `npm install -g pnpm@12.9.1`
  - `playwright`: `--only-shell` での取得、ubuntu で依存なしの起動、`install-deps` の時間
  - `playwright-cache`: `actions/cache@v6` で `ms-playwright` を戻す
  - `uv`: `setup-uv` の `enable-cache` が `auto`（既定）と `false`
- 起動の確認は `node -e "import('playwright').then(m=>m.chromium.launch()).then(b=>b.close())"`（server のディレクトリで）。

## 結果

### 今の check.yml（main の push、直近 3 回、macOS）

| ステップ | 秒 |
|---|---|
| Set up job | 2〜3 |
| checkout | 2 |
| pnpm/action-setup | 5〜7 |
| setup-node（cache: pnpm） | 7〜10 |
| pnpm install | 2〜3 |
| playwright install chromium | 10〜12 |
| setup-uv | 4〜7 |
| actions/cache（webrtc-apm） | 1〜2 |
| build-webrtc-apm.sh（キャッシュ当たり） | 0〜1 |
| 合計 | 35〜45 |

setup-node のキャッシュは 286 MB（`node-cache-macOS-arm64-pnpm-…`）を 60〜77 MB/s で取って展開していた。

### pnpm・Node・依存（pnpm と Node のステップ + `pnpm install`）

| 変種 | ubuntu | macOS |
|---|---|---|
| current（action-setup + setup-node cache） | 6 + 4 + 1 = **11** | 9 + 12 + 2 = **23** |
| no-cache（action-setup + setup-node） | 5 + 1 + 2 = **8** | 7 + 1 + 6 = **14** |
| action-setup-cache（setup-node + action-setup cache） | 1 + 9 + 1 = **11** | 1 + 15 + 2 = **18** |
| pnpm-setup（cache: true） | 4 + 1 = **5**（後処理の保存 +3） | 10 + 3 = **13**（後処理の保存 +10） |
| pnpm-setup-nocache | 4 + 2 = **6** | 3 + 5 = **8** |
| pnpm-setup-noruntime | — | 2 + 4 = **6** |
| npm-global | 1 + 2 + 2 = **5** | 1 + 2 + 5 = **8** |

ばらつき（最小〜最大）:

| ステップ | ubuntu | macOS |
|---|---|---|
| pnpm/action-setup（キャッシュなし） | 3〜7 | 5〜9 |
| setup-node（cache: pnpm） | 2〜6 | 8〜15 |
| setup-node（キャッシュなし） | 0〜1 | 0〜3 |
| pnpm install（キャッシュなし） | 2〜3 | 5〜9（npm-global・pnpm-setup では 3〜6） |
| pnpm/setup@v3（runtime node@24、キャッシュなし） | 3〜9 | 3〜5 |
| pnpm/setup@v3（runtime なし） | — | 2 |
| npm install -g pnpm | 2〜5 | 2〜3 |

- `pnpm/action-setup@v6` は、npm で pnpm v11 の自己インストーラーを入れてから、`packageManager` の v12.9.1 に切り替える（ログに「Switching pnpm from v11.19.0 to v12.9.1」）。2 段で入れるので遅い。README も pnpm v11 以降は `pnpm/setup` を案内している。[pnpm/action-setup](https://github.com/pnpm/action-setup)
- `pnpm/setup@v3` は pnpm の単体バイナリを npm レジストリから取って検証し、`pnpm runtime set` で Node を入れる（1 ステップ）。v11 以降専用。[pnpm/setup](https://github.com/pnpm/setup)
- キャッシュは逆効果だった。setup-node のキャッシュは 286 MB を戻す（取得だけで約 4 秒、展開に約 3.5 秒）。キャッシュなしの `pnpm install` が実際に落とすのは、この環境の分（例: `@anthropic-ai/claude-agent-sdk-darwin-arm64` 100 MB、`@typescript/typescript-darwin-arm64` 9 MB）だけで、ubuntu 2 秒・macOS 4〜6 秒で終わる。`pnpm/setup` の `cache: true` は後処理で保存を走らせ、macOS では 7〜51 秒かかった。
- ランナーに最初から入っているもの: macOS は Node v24.20.0（Homebrew）と Python 3.14、ubuntu は Node v22.23.3 と Python 3.12。pnpm と uv はどちらにも無い。Node 24 を揃えるなら、ubuntu では `runtime: node@24` が要る（macOS では省けて 1 秒縮むが、版はランナー画像任せになる）。

### playwright

| | ubuntu | macOS |
|---|---|---|
| `install chromium`（full + headless shell、今の形） | 9（8〜10） | 14（10〜18） |
| `install chromium --only-shell` | 4（3〜5） | 6（4〜9） |
| `actions/cache` で戻す（当たり） | 2（1〜2） | 2（2〜3） |
| `install-deps chromium`（ubuntu の OS 依存） | 15（12〜24） | — |
| 起動（依存を入れずに） | 成功（5/5 回） | 成功（5/5 回） |

- 今の `install chromium` は Chrome for Testing（182 MB）、FFmpeg、Chrome Headless Shell（94 MB）の 3 つを落としている。Playwright は headless では headless shell を使い、headless だけなら `--only-shell` で full のブラウザを省ける。[Browsers](https://playwright.dev/docs/browsers)
- `server/src/capture.ts` は `chromium.launch()` を `channel` なしで呼ぶので headless shell を使う。`--only-shell` で足りる（両 OS で起動を確認）。
- playwright を使うテストは `server/test/capture.test.ts` と、`server/test/server.test.ts` の「ブラウザを 1 つも開いていなくても、stop で map.png が書き出される」の 1 件（実物の `captureMap` を渡す）。web のテスト・型検査・helper は使わない。server のテストを分割するなら、この 2 ファイルを含む分だけに入れればよい。
- Playwright の CI のドキュメントは、ブラウザのキャッシュを勧めていない（「キャッシュを戻す時間は取得とほぼ同じ」、Linux では OS 依存はキャッシュできない）。GitHub Actions の例は `npx playwright install --with-deps`。[Continuous Integration](https://playwright.dev/docs/ci) 実測では当たれば 2〜4 秒速いが、キー（playwright の版）の管理が増える。
- ubuntu-24.04 の画像には headless shell の起動に要るライブラリが揃っていた。撮影結果の中身（日本語のフォントなど）が Linux で同じになるかは、#218（Linux で動くか）で確かめる。

### uv

| `enable-cache` | ubuntu | macOS |
|---|---|---|
| `auto`（既定） | 4（4〜5） | 6（5〜7） |
| `false` | 1（1〜2） | 1 |

- 既定の `auto` は GitHub のランナーでキャッシュを有効にし、`cache-dependency-glob`（`**/pyproject.toml`、`**/uv.lock` など）でリポジトリ全体を探す。[setup-uv](https://github.com/astral-sh/setup-uv) node_modules があると探すのに 3 秒前後かかり、このリポジトリでは一致が無いので警告も出る（「No file matched … The cache will never get invalidated」）。
- uv は `helper/scripts/build-webrtc-apm.sh` が meson と ninja を `uvx` で使うためだけに要る。スクリプトはビルド済みなら何もしないので、webrtc-apm のキャッシュが当たれば uv は要らない。

### ランナーの起動と割り当て待ち

| | ubuntu | macOS |
|---|---|---|
| 空のジョブの稼働時間 | 3〜4 | 3〜5 |
| Set up job | 0〜2 | 0〜3 |
| checkout | 0〜2 | 1〜5 |
| 割り当て待ち（run 作成からジョブ開始、同時 9〜12 ジョブ） | 3〜9 | 8〜54、別の run と重なった回は 167〜267 |

- 起動そのもの（Set up job）に差はない。macOS は同じステップが 1.5〜2 倍遅い（`no-cache` のジョブ全体で ubuntu 10〜18 秒、macOS 21〜27 秒）。
- Free プランは同時 20 ジョブ、そのうち macOS は 5 ジョブまで。[Actions limits](https://docs.github.com/en/actions/reference/limits) macOS のジョブには「capacity constraints により待ちが長くなることがある」という注記も出た。macOS のジョブを増やすほど待ちが伸びる（1 分の目標は稼働時間で測るが、Linux に移すかの判断材料になる）。

## 試作で使う形

TS ジョブ（server / web）:

```yaml
runs-on: ubuntu-24.04
steps:
  - uses: actions/checkout@v7
  - uses: pnpm/setup@v3
    with:
      runtime: node@24
      install: false
  - run: pnpm install --frozen-lockfile
  # playwright を使うテスト（capture.test.ts / server.test.ts）を走らせるジョブだけ
  - run: pnpm --filter @live-mindmap/server exec playwright install chromium --only-shell
```

playwright のキャッシュを足すなら（任意、2〜4 秒）:

```yaml
  - id: pwver
    run: echo "v=$(node -p "require('./server/node_modules/playwright/package.json').version")" >> "$GITHUB_OUTPUT"
  - id: pwcache
    uses: actions/cache@v6
    with:
      path: ${{ runner.os == 'macOS' && '~/Library/Caches/ms-playwright' || '~/.cache/ms-playwright' }}
      key: pw-shell-${{ runner.os }}-${{ runner.arch }}-${{ steps.pwver.outputs.v }}
  - if: steps.pwcache.outputs.cache-hit != 'true'
    run: pnpm --filter @live-mindmap/server exec playwright install chromium --only-shell
```

helper のジョブ（Node・pnpm は入れない）:

```yaml
runs-on: macos-26
steps:
  - uses: actions/checkout@v7
  - id: apm
    uses: actions/cache@v6
    with:
      path: helper/.deps/webrtc-apm
      key: webrtc-apm-${{ runner.os }}-${{ hashFiles('helper/scripts/build-webrtc-apm.sh') }}
  - if: steps.apm.outputs.cache-hit != 'true'
    uses: astral-sh/setup-uv@v10.2.0
    with:
      enable-cache: false
  - if: steps.apm.outputs.cache-hit != 'true'
    run: bash helper/scripts/build-webrtc-apm.sh
  - run: swift build
    working-directory: helper
```

型検査は `pnpm typecheck`（`pnpm -r`）だと helper の `swift build` まで走るので、TS ジョブでは `pnpm --filter @live-mindmap/server --filter @live-mindmap/web typecheck` のように絞る。

## 見込み

| ジョブ | セットアップ（中央値の合計） |
|---|---|
| TS（ubuntu）、playwright なし | 1 + 1 + 4 + 2 = 約 8 秒 |
| TS（ubuntu）、playwright あり | 約 12 秒（キャッシュ当たりなら約 10 秒） |
| TS（macOS）、playwright なし | 1 + 2 + 3 + 5 = 約 11 秒（runtime を省けば約 9 秒） |
| TS（macOS）、playwright あり | 約 17 秒 |
| helper（macOS、webrtc-apm 当たり） | 1 + 2 + 2 = 約 5 秒 |

ステップの間の隙間と後処理で、ジョブの稼働時間はこれに 2〜4 秒足される（例: `pnpm-setup-nocache` のジョブ全体は ubuntu 11〜17 秒、macOS 15〜17 秒）。

## 出典

- [pnpm/action-setup](https://github.com/pnpm/action-setup) — 入力（`cache`、`standalone` は v12 以降で効かない）と、v11 以降は `pnpm/setup` を案内していること
- [pnpm/setup](https://github.com/pnpm/setup) — pnpm と Node を 1 ステップで入れる、`runtime`・`cache`・`install` の入力、v11 以降専用
- [actions/setup-node](https://github.com/actions/setup-node) — `cache` と `package-manager-cache`、node_modules はキャッシュしないこと
- [actions/cache](https://github.com/actions/cache) — `cache-hit` の意味、リポジトリ 10 GB・7 日で消える、既定ブランチのキャッシュを他のブランチから読めること
- [astral-sh/setup-uv](https://github.com/astral-sh/setup-uv) — `enable-cache` の既定（auto）と `cache-dependency-glob`
- [Playwright: Browsers](https://playwright.dev/docs/browsers) — headless shell と `--only-shell`、保存場所
- [Playwright: Continuous Integration](https://playwright.dev/docs/ci) — ブラウザのキャッシュを勧めない理由、`--with-deps`
- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) — ランナーの性能
- [Actions limits](https://docs.github.com/en/actions/reference/limits) — 同時ジョブ数（Free は 20、macOS は 5）
- 実測の run: [37444014301](https://github.com/daiki-beppu/live-mindmap/actions/runs/37444014301)、[37444308176](https://github.com/daiki-beppu/live-mindmap/actions/runs/37444308176)（それぞれ再実行を含む）。今の check.yml は [37439277597](https://github.com/daiki-beppu/live-mindmap/actions/runs/37439277597) ほか 2 回
