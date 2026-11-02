# Node のサーバーを署名・公証した .app に同梱する方法

調べた日: 2026-11-03。対象: [#1866](https://github.com/daiki-beppu/live-mindmap/issues/1866)（map [#1865](https://github.com/daiki-beppu/live-mindmap/issues/1865)）。

## 結論

- **Node の公式バイナリをそのまま同梱する案を選ぶ**。置き場所は `Contents/Resources` ではなく `Contents/Helpers/`（または `Contents/MacOS/`）にする。サーバーは 1 本の `.mjs` に束ね、npm（JS）と一緒に `Contents/Resources/` に置く。署名は自分の Developer ID で掛け直し、Hardened Runtime と JIT 用の entitlements を付け、`get-task-allow` は外す。
- SEA にしても、サイズと起動時間はほぼ変わらない。そのうえ、SEA では `process.execPath` が埋め込んだ main を起動してしまう。今の導入の流れ（導入ランナー・`npm ci`・Playwright の `cli.js`）は、`process.execPath` で別のスクリプトを走らせているので、そのままでは動かない。Bun と Deno の compile は、実行系の乗り換えになる。ADR 0017 の `npm ci` も置き換えることになるので、今は選ばない。
- **ADR 0017 の管理ディレクトリへの導入は、.app からでも成り立つ見込みが高い**。後から取ってくる実行ファイルには `com.apple.quarantine` が付かないので、Gatekeeper の初回確認には掛からない。ただし、署名・公証した .app から取ってきた ad-hoc 署名の Chromium を起動できるかは、実機で 1 回確かめる必要がある。
- **どの同梱方法を選んでも、実行時に Vite を呼んでいる 2 か所は作り直しが要る**（書き出しの `map.html`、map.png の撮影）。web と map.html のひな形は .app のビルド時に作っておき、`Contents/Resources/` に置く。

## 1. 同梱方法の比較

手元の計測は、M シリーズの Mac（Node v26.13.0、Bun 1.4.2）で行った。各値は 15 回の中央値。

| 方法 | 実行系のサイズ（非圧縮） | 起動時間（`cli --help`） | 公証 | 今のコードとの相性 | 更新の手間 |
|---|---|---|---|---|---|
| Node 公式バイナリ + `.ts` のまま | node 147MB + npm 16MB + server の node_modules | 393ms | 掛け直しの署名で通る（下記） | そのまま動く。`process.execPath` で子を起動する箇所もそのまま | Node の版上げのたびにバイナリを差し替える |
| Node 公式バイナリ + 1 本の `.mjs` に束ねる | node 147MB + npm 16MB + bundle 2.9MB | 99ms | 同上 | Vite を外せば動く | 同上と、束ねる工程 |
| Node SEA | 149MB（1 ファイル）+ npm は別に要る | 94ms | 同上（自分で注入して署名する） | `process.execPath` の起動が壊れる | 注入の工程が増える。SEA は Stability 1.1 |
| Bun `--compile` | 62MB（hello）/ 64MB（server） | hello で 7ms。server は試した版が起動しなかった | JIT の entitlements で署名する | 実行系が変わる。npm が無い | Bun の版上げと互換の確認 |
| Deno `compile` | 未計測（手元に Deno が無い） | 未計測 | 既定は ad-hoc 署名。掛け直しが要る | 実行系が変わる。npm 互換層を通す | 同上 |

参考: 中身が `console.log` 1 行のスクリプトでは、node 29ms・SEA 23ms・Bun 7ms だった。配布物の大きさは圧縮後で効く。Node 公式の `darwin-arm64` は、`.tar.xz` で 31MB、`.tar.gz` で 58MB ある。

### 1.1 Node 公式バイナリを同梱する

- **置き場所**: Apple の「Placing content in a bundle」の表は、helper tool の場所を `Contents/MacOS/` か `Contents/Helpers/` としている。ここでの code は Mach-O を指す。スクリプトは署名を持てないので、resource として `Contents/Resources/` に置く。同じ文書は、置き場所を誤ると公証で問題になると警告している。だから node は `Contents/Helpers/node` に置き、サーバーの JS・npm の JS・web の静的ファイルは `Contents/Resources/` に置く。Kanary も CLI を `Contents/Helpers/` に置いている（#1865 の Notes）。チケットの候補にあった「`Contents/Resources` に置く」は、Mach-O の置き場所として正しくない。[Apple: Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)
- **署名**: 公式の node は、Node.js Foundation の Developer ID（`HX7739G8FX`）と Hardened Runtime（`flags=0x10000(runtime)`）で署名されている。付いている entitlements は `allow-jit`・`allow-unsigned-executable-memory`・`disable-executable-page-protection`・`allow-dyld-environment-variables`・`disable-library-validation`・`get-task-allow` の 6 つ。中身は Node のリポジトリの [`tools/osx-entitlements.plist`](https://github.com/nodejs/node/blob/main/tools/osx-entitlements.plist) と同じ（手元の `codesign -d --entitlements -` で確認）。一方、Apple の「Resolving common notarization issues」は、`get-task-allow` が残っていると公証が失敗すると書いている。Developer ID の署名・secure timestamp・Hardened Runtime もそれぞれ公証の条件に挙がっている。そこで、.app に入れるときは自分の Developer ID で `--options runtime --timestamp` を付けて掛け直し、`get-task-allow` を抜いた entitlements を付ける。V8 の JIT に要るのは `allow-jit` で、残りは要るかを実機で絞る。[Apple: Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- **npm**: `resolveNpm`（`server/src/npmCommand.ts`）は、`process.execPath` の隣の `../lib/node_modules/npm/bin/npm-cli.js` か PATH から npm を探す。明示のパス（`explicit`）を渡す口もある。.app では npm の JS を `Contents/Resources/npm/` に置き、そのパスを明示で渡せばよい。こうすると、Mach-O のある `Contents/Helpers/` に JS を混ぜずに済む。
- **起動時間**: `.ts` を Node の型の除去で直接読むと、`cli --help` が 393ms かかる。束ねた `.mjs`（Vite を差し替えたもの）なら 99ms になる。常駐サーバーは 1 回起動するだけなので、どちらでも使える。ただ CLI は毎回起動するので、束ねたほうが体感がよい。
- **更新**: Node の版上げは、バイナリと npm を差し替えて掛け直すだけで済む。Sparkle は .app を丸ごと差し替えるので、仕組みは他の方法と変わらない。

### 1.2 Node の Single Executable Application（SEA）

- 状態は Stability 1.1（Active development）。v25.5.0 から `node --build-sea sea-config.json` で 1 ファイルを作れる。macOS では作った後に `codesign` で署名する。[Node.js: Single executable applications](https://nodejs.org/api/single-executable-applications.html)
- 既定では、埋め込んだ main からの `require()`・`import` は組み込みモジュールしか読めない。そのため、1 ファイルに束ねるよう勧められている。v26.9.0 から `useVfs` で node_modules を読み取り専用で同梱できるが、こちらは Stability 1.0（Early development）で、`useCodeCache`・`useSnapshot` と併用できない。
- **今のコードとぶつかる点**（手元で確かめた）: SEA の中から `spawn(process.execPath, [別のスクリプト])` を呼ぶと、別のスクリプトではなく、埋め込んだ main が引数付きで起動された。今の導入はまさにこの形を 3 か所で使っている。
  - `managedDepsRunner.ts` を起動する箇所。
  - `npm-cli.js` を起動する箇所。
  - Playwright の `cli.js install --only-shell chromium` を起動する箇所。

  いずれも `server/src/managedDeps.ts` にある。SEA にするなら、これらを main の中のサブコマンドに振り分けるか、npm と Playwright 用に素の node を別に同梱することになる。素の node を同梱するなら、SEA にする利点はほとんど残らない。
- サイズは node 本体とほぼ同じ（149MB）。起動時間は、束ねた `.mjs` を素の node で読む場合と差がない（94ms 対 99ms）。

### 1.3 Bun の `--compile`

- 「実行系のコピーに自分のプログラムを付けたもの」で、Bun と Node の組み込み API に対応するとされている。macOS の署名には、`allow-jit`・`allow-unsigned-executable-memory` の entitlements を付けるよう案内がある。`--bytecode` で起動を速くできる。[Bun: Single-file executable](https://bun.com/docs/bundler/executables)（出典の Markdown は `oven-sh/bun` の `docs/compiler/executables.mdx`）
- `BUN_BE_BUN=1` を付けると、実行ファイルが `bun` の CLI として振る舞う。そのため、`bun install` は同梱した実行ファイルから呼べる。ただし npm は無い。ADR 0017 の「同梱の npm lock で `npm ci`」を Bun の導入に置き換えることになり、lock の形式と固定版の手順が変わる。
- 手元の試行の結果は次のとおり。
  - `bun src/cli.ts --help`（Bun の実行系でソースを直接読む）は動いた。
  - Vite を差し替えて `--compile` したものは、何も出さずに exit 1 で終わった。原因は追っていない。Effect の `@effect/platform-node` を Bun の上で動かす互換は、本番の経路では確かめられていない。
  - Vite を中に束ねようとすると、`@vitejs/devtools/config` を解決できずにビルドが止まった。

### 1.4 Deno の `compile`

- 権限のフラグはビルド時に決める必要がある。既定で node_modules を丸ごと埋め込む。macOS では既定で ad-hoc 署名なので、配布には掛け直しが要る。静的に追えない動的 import は自動では入らず、`--include` で足す。[Deno: deno compile](https://docs.deno.com/runtime/reference/cli/compile/)
- 管理ディレクトリから `import(pathToFileURL())` で読む SDK や Playwright は、Deno の npm 互換層を通ることになる。この経路は確かめていない。Bun と同じく実行系の乗り換えで、npm も無い。

## 2. 管理ディレクトリへの導入（ADR 0017）は .app から動くか

### 2.1 npm の無い .app からの `npm ci`

- 今の導入は、サーバーの `node`（`process.execPath`）で `npm-cli.js` を起動して、`npm ci --omit=dev --omit=peer --ignore-scripts` を走らせる。`npm ci` は lock が必須で、lock と `package.json` が食い違えばエラーで止まる。既存の node_modules は消してから入れ直す。[npm: npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci)
- npm の JS を .app に同梱して、そのパスを `resolveNpm` の明示の口で渡せば、利用者の Mac に Node や npm が無くても今の流れのまま動く。npm は 16MB ある。
- 導入先は `~/.live-mindmap/deps/` で、.app の外にある。だから導入しても .app の署名の封は壊れない。.app の中に書き込む案は、署名を壊すので採らない。
- 後から取ってくるもの（手元の `~/.live-mindmap/deps` で計測）:
  - claude: 224MB
  - chromium: 211MB
  - cloudflared: 37MB

  どれも .app には入れず、今のまま必要になってから取る。

### 2.2 後から取ってきた実行ファイルは quarantine や Gatekeeper に止められるか

手元の `~/.live-mindmap/deps` にある 3 つを調べた。

| 実行ファイル | 署名 | 拡張属性 |
|---|---|---|
| Claude Code の CLI（`claude-agent-sdk-darwin-arm64/claude`） | Developer ID: Anthropic PBC（`Q6L2SF6YDW`）、Hardened Runtime、timestamp あり | `com.apple.provenance` のみ |
| cloudflared 2026.9.2 | Developer ID: Cloudflare Inc.（`68WVV388M8`）、Hardened Runtime、timestamp あり | `com.apple.provenance` のみ |
| Chromium headless shell（Playwright 1.63.0、rev 1243） | ad-hoc（`linker-signed`） | `com.apple.provenance` のみ |

- `com.apple.quarantine` は 3 つとも付いていない。quarantine は、ファイルを作るアプリの側が付けるもので、Info.plist の `LSFileQuarantineEnabled` は「このアプリが作るファイルを既定で quarantine するか」を決める。Node の `https`・npm・Playwright のダウンロードは、この属性を付けない。だから .app に `LSFileQuarantineEnabled` を入れない限り、導入したものは「インターネットから落とした初回起動」の確認に掛からない。[Apple: LSFileQuarantineEnabled](https://developer.apple.com/documentation/bundleresources/information-property-list/lsfilequarantineenabled)
- Apple Silicon では、どの実行ファイルも署名が無いと動かない。ただし、ad-hoc の署名で足りる。ad-hoc の署名は Gatekeeper を通れないが、Gatekeeper の確認は quarantine が付いたものに掛かる。そのため、quarantine の無い ad-hoc の Chromium は今も動いている。[Apple: macOS Big Sur 11.0.1 Universal Apps release notes](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes)
- **残る不確かさ**: Apple のセキュリティガイドは「Gatekeeper はダウンロードしたソフトウェアが書いたファイルの provenance も追う」と書いている。手元のファイルに付いている `com.apple.provenance` がそれにあたる。いま調べたファイルは、ターミナルから起動したサーバーが書いたものだった。DMG から入れた公証済みの .app が書いた ad-hoc の実行ファイルを、子プロセスとして問題なく起動できるかは、文書からは言い切れない。実装の前に、公証済みの試作 .app から chromium の導入と起動を 1 回通して確かめる。[Apple Platform Security: Gatekeeper and runtime protection](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web)
- Hardened Runtime の制約（ライブラリの検証など）は、それぞれのプロセスの中だけに掛かる。子プロセスとして起動する別の実行ファイルには、その実行ファイル自身の署名が使われる。

## 3. web の静的ファイルと map.html の持ち方

今のサーバーは、実行時に Vite を 2 か所で呼んでいる。どちらも、リポジトリの `web/` のソースと Vite・Foldkit の Vite プラグインが手元にあることを前提にしている。

- **書き出しの map.html**（`server/src/review.ts`）: `vite build`（`vite-plugin-singlefile`）を `web/` に対して毎回走らせている。そこで作った `index.html` と同梱ライセンスを読み、`embedReviewLog`・`embedReviewAudio` で会議のデータを差し込んでいる。ひな形そのものは会議に依存しないので、.app のビルド時に 1 回作り、ライセンス入りの `review-template.html` として `Contents/Resources/` に置けば足りる。公開（share）も同じ `ReviewBuild` を使っている。
- **map.png の撮影**（`server/src/capture.ts`）: Vite の dev server（`createServer`）を立て、Chromium で開いて撮っている。.app では、ビルド済みの web の静的ファイルをサーバー自身が配るように置き換える。
- **会議中の画面**: 今は web の `pnpm dev`（Vite の dev server、`http://localhost:5173`）が配り、`/ws` などをサーバー（4319）に中継している。.app には Vite の dev server が無いので、ビルド済みの web（手元の `vite build` で 676KB）をサーバーが同じポートで配る形にする。
- Vite と `vite-plugin-singlefile` は、`server/package.json` では devDependencies なのに、実行時に import されている。Bun の `--compile` で Vite を中に束ねようとすると、`@vitejs/devtools/config` が解決できずに止まった。Vite を本番の実行系から外すことが、どの同梱方法でも前提になる。

## 4. .app にするときに直すリポジトリの前提

`import.meta.dirname` からリポジトリの配置を前提にしたパスが、次の箇所にある。.app では「リソースの根」を 1 つ受け取る形にそろえる必要がある。

- `server/src/helperPath.ts`: `helper/.build/release/live-mindmap-helper`
- `server/src/appleIntelligence.ts`: `helper/.build/release/live-mindmap-apple`
- `server/src/commonWords.ts`: `server/data/wordfreq-ja-top50000.txt`
- `server/src/managedDeps.ts`: `server/managed-deps/<名前>/`（同梱の lock）と `managedDepsRunner.ts`
- `server/src/review.ts`・`server/src/capture.ts`: `web/`（上記の Vite の 2 か所）

## 5. 勧め

1. **同梱は Node 公式バイナリにする**。node は `Contents/Helpers/node` に置き、自分の Developer ID と Hardened Runtime で、`get-task-allow` を抜いた JIT の entitlements を付けて掛け直す。npm の JS、束ねたサーバーの `.mjs`、同梱の lock は `Contents/Resources/` に置く。
2. **実行時の Vite を外す**。web の静的ファイルと map.html のひな形は、.app のビルド時に作って `Contents/Resources/` に置く。会議中の画面と撮影のページは、サーバーが配る。
3. **管理ディレクトリへの導入は今の形のまま使う**。.app に `LSFileQuarantineEnabled` は入れない。公証済みの試作 .app から chromium・claude・cloudflared の導入と起動を通す確認を、実装 ticket の受け入れ条件に入れる。
4. SEA・Bun・Deno は今は採らない。SEA は、導入の子プロセスを `process.execPath` から切り離した後で、1 ファイルにする利点が要るときに見直す。

## 手元の計測の手順（再現用）

- SEA: `node --build-sea`（`mainFormat: "module"`）と `codesign --sign -` で作り、`--help` を 15 回測った。
- Bun: `Bun.build` に Vite を空のモジュールへ差し替えるプラグインを付けて、`--compile` を試した。
- 起動時間は、`subprocess.run` で 3 回の空回しの後に 15 回測った中央値。
- 署名と属性は `codesign -dvv`、`codesign -d --entitlements -`、`xattr` で見た。
