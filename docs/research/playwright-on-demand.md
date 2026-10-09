# Playwright と Chromium を使うときだけ入れる方法（issue #621）

地図 #619 の調査チケット。map.png を撮るための Playwright（本体と Chromium）を、通常の依存から外し、使うときだけ `~/.live-mindmap/` の下に入れられるかを調べた。2026-10-09 時点、Playwright 1.63.0、macOS 27（arm64）、Node 26.9.0 / npm 11.19.1 で確かめた。計測はすべて `$TMPDIR` の作業用ディレクトリで行い、リポジトリには入れていない。

## 結論

- **置き場所は `PLAYWRIGHT_BROWSERS_PATH` で管理ディレクトリに向けられる。** ただし、この値は `playwright-core` を読み込んだ時点で一度だけ読まれる。読み込む前に `process.env` に入れる必要がある（読み込んだ後に入れると既定の `~/Library/Caches/ms-playwright` を見る。実測）。
- **`--only-shell`（Chrome Headless Shell）だけで map.png に足りる。** `chromium.launch()` は `headless: true`（既定）なら headless shell を起動する。headless shell しか無いディレクトリを指して、`capture.heavy.test.ts` と `reviewBuild.heavy.test.ts` が 8 件とも通った。CI の heavy ジョブもすでに `--only-shell` で回っている。
- **容量（mac-arm64 の実測）:** `playwright-core` 13 MB ＋ headless shell 195 MB ＋ ffmpeg 2.5 MB ≒ **211 MB**（ダウンロードは 94.3 MiB ＋ 約 1 MiB ＋ npm の tarball）。`--only-shell` を付けない `install chromium` は、フルの Chrome for Testing（359 MB）も入れて **約 557 MB** になる（README の手順がこれ）。チケットの「約 150MB」は少なめだった。
- **本体も通常の依存から外し、管理ディレクトリから読み込める。** 要るのは `playwright` ではなく `playwright-core` だけ（`playwright` は `playwright-core` を再輸出するだけで、残りはテストランナー）。`playwright-core` は依存 0、install スクリプト無しなので、takt と同じ「同梱した package.json と lock に対して `npm ci --omit=dev --ignore-scripts`」→ `createRequire` ＋ `import(pathToFileURL(...))` でそのまま読める（実測）。ブラウザは管理ディレクトリの `playwright-core/cli.js install --only-shell chromium` で別に入れる。Claude Agent SDK と同じ方式で揃う。
- **版の結び付きは「`playwright-core` の版 → `browsers.json` のリビジョン → ディレクトリ名」で決まる。** 1.63.0 は `chromium-headless-shell` リビジョン 1243（Chrome 153.0.8010.12）で、`<BROWSERS_PATH>/chromium_headless_shell-1243/` に入る。版違いは、`playwright-core/package.json` の版を固定版と比べれば分かり、ブラウザの有無は `chromium_headless_shell-<rev>/INSTALLATION_COMPLETE` で分かる。
- **heavy IT と E2E は、いまは別々の Playwright で同じキャッシュを使っている。** どちらも CI では `pnpm --filter @live-mindmap/server exec playwright install chromium --only-shell` で既定のキャッシュに入れる。E2E（`@e2e-dev/web`）は `playwright-core` を `1.63.0` に固定しており、server の `playwright`（`^1.63.0`）と今はたまたま同じ版なので 1 回の導入で両方が動く。`@e2e-dev/web` は、足りなければ実行の前に自分で `--only-shell` を入れる。

## 1. 置き場所: `PLAYWRIGHT_BROWSERS_PATH`

- 公式: 「Managing browser binaries」で、`PLAYWRIGHT_BROWSERS_PATH` を導入時と実行時の両方に渡すと、既定のキャッシュ以外を使える。`PLAYWRIGHT_BROWSERS_PATH=0` なら `node_modules/playwright-core/.local-browsers` に入る（hermetic install）。ダウンロード元は `PLAYWRIGHT_DOWNLOAD_HOST` で変えられる。 — https://playwright.dev/docs/browsers#managing-browser-binaries
- ソース（`playwright-core@1.63.0` の `lib/coreBundle.js`、`registryDirectory`）: 値が `"0"` なら `<packageRoot>/.local-browsers`、それ以外は値そのもの、未設定なら OS の既定。相対パスは `INIT_CWD` か `cwd` から解決する。モジュールの初期化で一度だけ計算する。
- 実測: 同じプロセスで `import` の後に `process.env.PLAYWRIGHT_BROWSERS_PATH` を入れると、`chromium.executablePath()` は既定の `~/Library/Caches/ms-playwright/...` を返した。前に入れれば管理ディレクトリを返した。
  - 実装では、`capture.ts` の `playwright` を静的 import から、撮影の直前の動的 import に変え、その前に環境変数を入れる（または `launch({ executablePath })` に headless shell のパスを渡す）。どちらにしても、いまの静的 import（`sessionFiles.ts` → `capture.ts` → `playwright`）は外す必要がある。
- 空のディレクトリを指すと、`launch()` は `Executable doesn't exist at <dir>/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell` と「`npx playwright install` を打て」という箱を出して失敗する（実測）。いまの `CaptureFailed` に入り、map.png だけ除いて終わる流れはそのまま使える。ただし、案内のコマンドは Playwright 自身のもの（`npx playwright install`）なので、`cli install` へ置き換えて出す必要がある。

### 導入の記録と古い版の掃除（GC）

- 導入するたびに `<BROWSERS_PATH>/.links/<sha1(パッケージのパス)>` に、導入した `playwright-core` の場所を書く。続けて、`.links` から辿れる `browsers.json` のどれにも載っていないブラウザのディレクトリを消す。辿れないリンク（パッケージが消えた）は捨てる。`PLAYWRIGHT_SKIP_BROWSER_GC=1` か `--no-remove` で止められる。 — 公式: https://playwright.dev/docs/browsers#stale-browser-removal 、ソース: `Registry.install` / `_validateInstallationCache`
- 読み込み（`launch`）では `.links` に書かない。管理ディレクトリの `playwright-core` から `install` を打たずに他の場所の Playwright で入れたブラウザを使うと、別の版の `install` が走ったときに GC で消される。導入は必ず管理ディレクトリの `cli.js` で行うのがよい。
- この仕組みは「古い版の掃除」（#619 の Not yet specified）にそのまま使える。管理ディレクトリの `playwright-core` を新しい版に差し替え（旧版のディレクトリを消し）てから `install` を打てば、旧リビジョンのブラウザは消える。
- 同時に 2 つの `install` が走っても、`<BROWSERS_PATH>/__dirlock` のロックで直列になる（ソース）。

## 2. `--only-shell` で map.png に足りるか

- 公式: `channel` を付けない headless の実行は Chrome Headless Shell を使う。`--only-shell` でフルの Chromium を入れずに済む。新しい headless モード（`channel: 'chromium'`）を使うときは、逆に `--no-shell` を付ける。 — https://playwright.dev/docs/browsers#chromium-headless-shell / https://playwright.dev/docs/browsers#chromium-new-headless-mode
- ソース: `getExecutableName` が `options.headless ? "chromium-headless-shell" : "chromium"`。`capture.ts` と `reviewBuild.heavy.test.ts` は `chromium.launch()`（引数なし、`channel` なし）なので headless shell を使う。
- 実測: headless shell と ffmpeg しか無いディレクトリを `PLAYWRIGHT_BROWSERS_PATH` で指して、`pnpm exec vitest run test/capture.heavy.test.ts test/reviewBuild.heavy.test.ts` が 2 ファイル 8 件とも通った（5.7 秒）。空のディレクトリを指すと、同じテストが `CaptureFailed` で落ちたので、確かにその場所を見ていた。日本語の文字と SVG の線も描けた（作業用の別スクリプト）。
- `--only-shell` でも ffmpeg（2.5 MB）が付いてくる（`resolveBrowsers` がブラウザごとに ffmpeg を足す。動画の録画用で、撮影には使わない）。

### 容量（mac-arm64、`du -sh` の実測）

| もの | ダウンロード | 展開後 |
| --- | --- | --- |
| `playwright-core@1.63.0`（`npm ci --omit=dev --ignore-scripts`） | npm tarball | 13 MB |
| Chrome Headless Shell 153.0.8010.12（r1243） | 94.3 MiB | 195 MB |
| ffmpeg r1011 | 約 1 MiB | 2.5 MB |
| **`--only-shell` の合計** | 約 96 MiB ＋ tarball | **約 211 MB** |
| （参考）Chrome for Testing（フル、r1243） | 182.1 MiB | 359 MB |
| （参考）`install chromium`（フル＋shell＋ffmpeg） | 約 277 MiB | 約 557 MB |

`playwright`（テストランナー込みの本体）は 5.0 MB で、これは要らない。Linux の容量は測っていない。

## 3. 本体（`playwright-core`）を管理ディレクトリから読み込む

- `playwright` の `index.js` / `index.mjs` は `module.exports = require('playwright-core')` / `export * from 'playwright-core'` だけ（npm の tarball）。`chromium` などの API はすべて `playwright-core` にある。
- `playwright-core@1.63.0` の `package.json`: `dependencies` 無し、`scripts` 無し、`engines.node >=20`、`bin.playwright-core = cli.js`。`playwright` にも `scripts` は無い（どちらも npm の導入でブラウザを落とさない）。
- 実測（作業用ディレクトリ）:
  1. `package.json` に `"playwright-core": "1.63.0"` だけを書き、`npm install --package-lock-only --ignore-scripts` で lock を作る（実装では lock を同梱する）
  2. `npm ci --omit=dev --ignore-scripts` → `node_modules/playwright-core` だけが入る（13 MB）
  3. `PLAYWRIGHT_BROWSERS_PATH=<dir> node <managed>/node_modules/playwright-core/cli.js install --only-shell chromium`
  4. 別の場所のスクリプトから `createRequire(join(managed, "package.json")).resolve("playwright-core")` → `import(pathToFileURL(entry).href)` で読み、`chromium.launch()` → `browser.version()` が `153.0.8010.12`、スクリーンショットが撮れた
- takt の deepseek-harness と同じ手順（同梱の package.json と lock、`npm ci --omit=dev --ignore-scripts`、`createRequire` と `import(pathToFileURL(...))`）でそのまま通る。依存 0 なので、Claude Agent SDK より単純。
- 型: `import type { Page } from "playwright-core"` にして、`playwright-core` を server の devDependencies に固定版で残せば `tsc` と `effect-tsgo` は通るはず（型は実行時に読まれない）。devDependencies の版と同梱の lock の版を揃えておく検査が要る（未検証）。

## 4. 版の結び付きと見分け方

- 公式: 「Each version of Playwright needs specific versions of browser binaries to operate」。Playwright を上げたら `install` を打ち直す。 — https://playwright.dev/docs/browsers#managing-browser-binaries
- `playwright-core/browsers.json`（1.63.0）: `chromium` と `chromium-headless-shell` はリビジョン `1243`、`browserVersion` `153.0.8010.12`。`ffmpeg` は `1011`。ディレクトリ名はリビジョンで決まる（`chromium_headless_shell-1243`、ソース `readDescriptors`）。完了の印は `INSTALLATION_COMPLETE`。
- 見分け方の候補:
  - 本体の版違い: 管理ディレクトリの `node_modules/playwright-core/package.json` の `version` を、live-mindmap が固定する版と比べる（takt の manifest と同じ）。
  - ブラウザの有無: 読み込んだ `playwright-core` の `browsers.json` からリビジョンを取り、`<BROWSERS_PATH>/chromium_headless_shell-<rev>/INSTALLATION_COMPLETE` があるかを見る。`@e2e-dev/web` の `install.js`（`headlessShellInstalled`）が同じ見方をしている。公開 API の `chromium.executablePath()` はフルの Chromium のパスしか返さないので、headless shell の判定には使えない（実測: shell しか無いのにフルのパスを返した）。
  - 開始せずに確かめる: `cli.js install --dry-run --only-shell chromium` が、入れる場所とダウンロード元を出す（実測）。ただし入っているかは出さない。
  - 起動後: `browser.version()` が Chrome の版を返す。
- 同じ `playwright-core` の版から入れる限り、ブラウザとの版違いは起きない。版違いが起きるのは「本体を上げてブラウザを入れ直していない」ときだけで、そのとき `launch()` は `Executable doesn't exist` で落ちる（警告して動かす余地は無い。撮れずに map.png を除く）。

## 5. heavy IT と E2E がいま Chromium をどう得ているか

### いま

- heavy IT: `server/test/capture.heavy.test.ts`・`reviewBuild.heavy.test.ts` が server の devDependencies の `playwright`（`^1.63.0`、lock は 1.63.0）を import する。ブラウザは既定のキャッシュ。CI の `heavy` ジョブは `pnpm --filter @live-mindmap/server exec playwright install chromium --only-shell`（`.github/workflows/check.yml`）。ローカルは README / テストのコメントに従い `install chromium`（`--only-shell` なし）。
- unit / 軽い IT: `captureLifecycle.it.test.ts` は `vi.mock("playwright", ...)` で偽物にする。`server/scripts/check-test-layers.ts` は `playwright` を「実物の資源」として unit からの import を禁じている。
- E2E: `e2e/` は `@e2e-dev/web@0.13.0` を使い、これが `playwright-core` を **`1.63.0` に固定**して依存する（npm の `package.json`、`pnpm-lock.yaml`）。`browser-connection.js` は `launch({ headless: !headed })` で、headless なら headless shell を使う。`surface.js` の `prepare` が `ensureBrowsersInstalled` を呼び、足りなければ自分の `playwright-core/cli.js install --only-shell chromium` を `PLAYWRIGHT_SKIP_BROWSER_GC=1` 付きで走らせる（`install.js`）。CI の `e2e` ジョブは事前に server の `playwright install chromium --only-shell` を打つので、版が同じ今は自前の導入が走らない。
- E2E の中で server が撮る map.png は判定に使わない（`e2e/README.md`: 環境しだいで、警告を出して続ける）。

### 管理ディレクトリに寄せたときに変わること

- 本番（`start`・`resume`・`play` の書き出し）: `capture.ts` が管理ディレクトリから `playwright-core` を動的に読み、`PLAYWRIGHT_BROWSERS_PATH=~/.live-mindmap/<…>/browsers` を読み込む前に入れる。未導入なら今と同じく map.png だけ除き、警告の案内を `cli install <名前>` にする。
- server の `playwright` 依存: 実行時の依存からは外し、型と heavy IT のために `playwright-core` を devDependencies（固定版）に残すのが素直。`playwright`（テストランナー込み）は要らなくなる。`check-test-layers.ts` の禁止リストに `playwright-core` を足す必要がある。
- unit / 軽い IT: `vi.mock("playwright")` は、モジュール名でなく「読み込み口」（管理ディレクトリから読む関数・Layer）を差し替える形に変わる。
- heavy IT: 選択肢は 2 つ。(a) devDependencies の `playwright-core` と既定のキャッシュのまま（今と同じ。管理ディレクトリの読み込み口は通らない）。(b) heavy IT も管理ディレクトリの読み込み口を通し、CI では `cli install playwright` 相当で `~/.live-mindmap` 相当の一時ディレクトリに入れる（本番と同じ経路を確かめられる）。どちらにするかは #619 の「テストと CI への影響」で決める。
- E2E: `@e2e-dev/web` は自分の `playwright-core` と `PLAYWRIGHT_BROWSERS_PATH`（未設定なら既定のキャッシュ）でブラウザを探し、無ければ自分で入れるので、server 側を管理ディレクトリに寄せても E2E のブラウザは影響を受けない。CI の `e2e` ジョブの `playwright install` の行は、server の版から切り離せる。ただし `@e2e-dev/web` の `e2e-web install` は `--with-deps` 以外の option を受け付けず（`cli.js`）、`--only-shell` を付けられないのでフルの Chromium まで入れてしまう。行を消して `prepare` の自動導入（`--only-shell` を付ける）に任せるか、`@e2e-dev/web` が依存する `playwright-core` の `cli.js install --only-shell chromium` を直接打つのがよい。E2E の中の map.png は、管理ディレクトリが無ければ撮られないが、判定に使わないので通る。
- 版のずれの注意: 今は server の `^1.63.0` と `@e2e-dev/web` の固定 `1.63.0` がたまたま同じなので、CI は 1 回の導入で両方を満たしている。server 側を別の版に固定すると、リビジョンが分かれ、E2E は実行のたびに自前のダウンロードを始める（CI で見えにくい時間が増える）。CI では導入をそれぞれの持ち主の CLI で行うとよい。
- CI のキャッシュ: `PLAYWRIGHT_BROWSERS_PATH` を固定のパスにすれば `actions/cache` のキーを `browsers.json` のリビジョン（＝`playwright-core` の版）にできる（未検証）。

## 実装に向けたメモ（チケット外の気づき）

- README の初回手順 `playwright install chromium` は `--only-shell` が無いので、使わないフルの Chromium（359 MB）まで入れている。管理ディレクトリに移すまでの間も、`--only-shell` を付けるだけで約 360 MB 減る。`capture.ts` のエラーメッセージも同じ。
- `install` は `CI` 環境変数が無いとき、システムに入っている非 hermetic なブラウザ（branded の Chrome 等）に箱を出して止まることがあるが、`chromium-headless-shell` は hermetic なので該当しない（ソース `Registry.install`）。
- 導入はネットワークで `cdn.playwright.dev` に行く（`install --dry-run` の Download url）。サーバーが導入するという #619 の合意どおりなら、エージェントのサンドボックスの制限は受けない。

## 出典

- Playwright 公式「Browsers」: https://playwright.dev/docs/browsers （Managing browser binaries / Chromium headless shell / new headless mode / Stale browser removal / Hermetic install / Download host）
- npm `playwright-core@1.63.0`（`package.json`・`browsers.json`・`lib/coreBundle.js` の `registryDirectory`・`readDescriptors`・`Registry.install`・`_validateInstallationCache`・`resolveBrowsers`・`getExecutableName`・install コマンドの option）: https://www.npmjs.com/package/playwright-core/v/1.63.0 、ソース https://github.com/microsoft/playwright/tree/v1.63.0/packages/playwright-core
- npm `playwright@1.63.0`（`index.js` / `index.mjs` / `package.json`）: https://www.npmjs.com/package/playwright/v/1.63.0
- npm `@e2e-dev/web@0.13.0`（`package.json`・`dist/install.js`・`dist/browser-connection.js`・`dist/surface.js`・`dist/cli.js`）: https://github.com/tester-army/e2e/tree/main/packages/web
- このリポジトリ: `server/src/capture.ts`、`server/src/sessionFiles.ts`、`server/test/capture.heavy.test.ts`、`server/test/reviewBuild.heavy.test.ts`、`server/test/captureLifecycle.it.test.ts`、`server/scripts/check-test-layers.ts`、`.github/workflows/check.yml`、`e2e/package.json`、`e2e/README.md`、`pnpm-lock.yaml`
