# StyleX と素の CSS + CSS 変数を Foldkit の web に当てた事実（Issue #1794）

地図 #1793 の調査チケット。web（`web/`）から Tailwind v4 を外すとき、StyleX と「素の CSS + CSS 変数（デザイントークン）」のどちらにするかを決める材料を集めた。決めるのは #1795。

StyleX は 10/10 の調査（#747、`research/foldkit-css` ブランチの `docs/investigations/2026-10-10-foldkit-css.md`）で一度調べてある。今回は一から調べ直さず、前回の結論が今の最新版でも成り立つかを主に確かめた。素の CSS の側は新しく調べた。

- 出典の版: StyleX は npm の `@stylexjs/*@0.19.1` と、`github.com/facebook/stylex` の `main`（2026-10-30 の `e3e2d02` まで）。Foldkit は web が使う `foldkit@0.167.0`（npm の最新は `0.170.0`）。fallow は repo が固定している `3.33.1`。oxlint は web の `1.87.0`。npm の数字は 2026-10-31 に `npm view` と `api.npmjs.org` で取った。
- 試しのビルド: `origin/main`（`1468f11`）から切った捨てる worktree（push していない）。Vite `8.3.2`、`vite-plugin-singlefile@2.3.3`、TypeScript `7.0.2`、`@effect/tsgo@0.56.0`。見返しの 1 ファイル HTML は、`server/src/review.ts` の `buildReviewTemplate` と同じ形（web の `vite.config.ts` に `viteSingleFile({ deleteInlinedFiles: false })` を足し、`build.license: true`）でビルドした。
- **未検証** と書いたものは、資料を読んだだけで動かしていない主張。

## 結論

- **StyleX の前回の結論 4 つのうち 3 つは今も成り立つ。** 10/10 から StyleX の新しい版は出ていない（最新は `0.19.1` のまま）。1 ファイル HTML には回避なしでは入らず、子孫セレクタの書き換えも多い。0.x のままパッチ版でも互換を壊す方針も変わらない。変わったのは綴り違いの 1 点で、`tsc` は今も通すが、oxlint の JS プラグインとして `@stylexjs/eslint-plugin` を載せると `stylex.create` のキーの綴り違いが error になった（検証済み）。
- **素の CSS + CSS 変数は、ビルドと dev の両方にそのまま乗る。** Tailwind を外し、トークンを `:root` の CSS 変数にした `styles.css` は、1 ファイル HTML の `<style>` にそのまま入った。dev サーバーでも HMR できるモジュールとして配られた（検証済み）。依存は増えず、Tailwind の 32 項目（lock の項目数）が消える。
- **素の CSS の弱いところは、打ち間違いを捕まえる道具。** repo の fallow `3.33.1` には CSS の規則（`css-broken-reference`・`css-dead-surface`）があるが、Foldkit の `h.Class("…")` をクラスの参照として読まない。`h.Class` の綴り違いを見逃し、使っている 49 個のクラスを「未使用」と出した（検証済み）。依存を増やさずに捕まえるには、小さな検査スクリプトが要る。約 30 行の試作で、`h.Class` の綴り違いを捕まえられた（検証済み）。
- **推奨（決めるのは #1795）: 素の CSS + CSS 変数。** 依存が減る、1 ファイル HTML と dev にそのまま乗る、今の `styles.css` がすでにこの形（子孫・状態のセレクタ、`@keyframes`、`color-mix` などは素の CSS）で、書き換えはユーティリティを規則へ移すだけで済む。打ち間違いの検査は `server/scripts/check-*.ts` と同じ形の小さなスクリプトで足す。StyleX は、回避が要る・依存が 46 項目増える・0.x の互換の壊れ方、が前回から変わっていない。

## StyleX: 前回の結論は今も成り立つか

| 前回（10/10）の事実 | 今（10/31） | 変わったか | 根拠 |
|---|---|---|---|
| 最新は `0.19.1`（2026-09-15） | 最新は `0.19.1` のまま。10/10 以降に npm の新しい版は無い。GitHub の `main` には 10/10 以降に 24 のコミットがある（babel-plugin の値の正規化の修正、runtime injection の修正、unplugin の `externalPackages` の型の宣言、依存の更新など）。CHANGELOG に未リリースの節は無い | 変わらない | `npm view @stylexjs/stylex time`、`gh api repos/facebook/stylex/compare/5a419da...main`（ahead 24）、`CHANGELOG.md` |
| 0.x のままで、パッチ版にも破壊的変更（`0.19.1` の「Breaking: Remove `enableDebugClassNames`」、`0.13.0` で `attrs` を削除し `0.18.2` で戻す） | 1.0 は出ていない。方針が変わった兆しも無い | 変わらない | `CHANGELOG.md` |
| 週の DL: `@stylexjs/stylex` 192 万、`@stylexjs/unplugin` 28 万（10/02〜08） | `@stylexjs/stylex` 243 万、`@stylexjs/unplugin` 45 万（10/23〜29） | 増えた | `api.npmjs.org/downloads/point/last-week/…` |
| 1 ファイル HTML に回避なしでは入らない | 今も入らない（検証済み）。今の web は Tailwind の CSS の asset（`style-*.css`）があるので、unplugin は `assets/stylex.css` を新しく作らず、`writeBundle` でその `style-*.css` の末尾に足した。その時点では singlefile がもう HTML に CSS を埋め込んでいるので、HTML の `<style>` には StyleX の規則（`@keyframes x…`・marker の `:hover`・`colr: red`）が 1 つも無く、残った `style-*.css` の側にだけあった。unplugin は `enforce: 'pre'` で、`generateBundle` の時点では CSS の asset がまだ無いため、前回と同じ理由で間に合わない | 変わらない | 試しのビルド。`@stylexjs/unplugin@0.19.1` の `lib/es/vite.mjs` 121–171 行。`main` の `src/vite.js` は 9/23（`8bde1f7`）から変わっていない |
| 前回の回避（`generateBundle` を `enforce: "post"` の別のプラグインに移す）で入る | 今も入る（検証済み）。unplugin の内部の形に頼る回避である点も同じ | 変わらない | 試しのビルド |
| `stylex.create` のキーの綴り違い（`colr: "red"`）は `tsc` も StyleX のコンパイラも通す | `tsc`（TypeScript 7.0.2）と `effect-tsgo diagnostics` は今も通し、CSS に `colr: red` が出た。一方、oxlint `1.87.0` の `jsPlugins` に `@stylexjs/eslint-plugin@0.19.1` を載せ、`@stylexjs/valid-styles` を error にすると「This is not a key that is allowed by stylex」で捕まった。参照の側の綴り違い（`styles.rwo`）は `tsc` が TS2339 で捕まえる | 変わった（lint で捕まる） | 試し。`packages/@stylexjs/eslint-plugin/src/stylex-valid-styles.js` 863–880 行（未知のキーを報告し、距離 2 以内の候補を出す）。oxc.rs の JS Plugins の docs（ESLint v9 互換、alpha） |
| 子孫・状態のセレクタは marker（`defaultMarker` と `when.ancestor`）への書き換えになる | 同じ。数え直すと下の表のとおり、65 のセレクタが書き換えになる | 変わらない | `api/javascript/when.mdx` |
| Foldkit の `h.Class`・`h.Style` は後勝ち | `foldkit@0.167.0` の `dist/html/index.js` 145–148・370・845 行は今も `ctx.data[key] = value` の代入。`main` の `src/html/index.ts` 1334 行も同じ | 変わらない | node_modules と GitHub |
| Foldkit の周りに StyleX の例は無い | `foldkit/foldkit` のコード検索で `stylex` は 0 件 | 変わらない | `gh api search/code` |

### 入れると増える依存

`origin/main` の web に `@stylexjs/stylex@0.19.1` と `@stylexjs/unplugin@0.19.1` を足すと、`pnpm-lock.yaml` の packages に 46 項目増えた（検証済み）。うち 20 項目が `@babel/*` で、残りは `@stylexjs/{babel-plugin,shared,stylex,unplugin}`、`unplugin`、`webpack-virtual-modules`、`acorn`、`browserslist` 一式（`caniuse-lite`・`electron-to-chromium`・`node-releases`・`update-browserslist-db`・`baseline-browser-mapping`・`escalade`）、`styleq`、`invariant`、`loose-envify`、`css-mediaquery`、`postcss-value-parser`、`json5`、`semver`、`lru-cache`、`yallist`、`gensync`、`jsesc`、`js-tokens`、`@dual-bundle/import-meta-resolve`。

- `@stylexjs/unplugin` は `lightningcss ^1.29.1` に依存する。Tailwind が入っている今は Tailwind の `lightningcss@1.32.0` を共有したので、上の 46 項目には入っていない。Tailwind を外したあとの数は **未検証**（Vite 8.3.2 の `lightningcss ^1.33.0` と共有できれば増えない）。
- 綴り違いを捕まえる `@stylexjs/eslint-plugin` を足すと、さらに数項目増える（`@csstools/css-tokenizer`・`micromatch` ほか）。

### 今の `styles.css` を StyleX で書くと

`web/src/styles.css`（218 行）のセレクタを、コメントを除いて種類ごとに数えた（`@media` の中も含む。カンマで分けたセレクタを 1 つずつ数える）。

| 種類 | 数 | StyleX での扱い |
|---|---|---|
| クラス 1 つ（`.map-node` など） | 36 | そのまま `stylex.create` に写せる |
| 自分の擬似クラス（`:hover`・`:focus-visible` など） | 7 | そのまま書ける（`{ default: …, ':hover': … }`） |
| 自分の属性（`.review-tip[data-open]`・`.local-mode-line[data-status="stopped"]` など） | 7 | 書き方の確認が要る（**未検証**）。`when.*` は祖先・兄弟・子孫の属性を見る API で、自分の属性は対象外 |
| クラスの子孫・子（`.map-node:hover .map-node__fold-dot`、`.review-seek[data-pointing] .review-seek__thumb`、`.review .captions` などの画面ごとの上書き 30 余り） | 50 | 書き換えになる。擬似クラスと属性は `when.ancestor` と marker で書ける。`.review …`・`.meeting …` のように祖先のクラスで分けるものは、`when.ancestor` が擬似クラスか属性しか受けないので、画面ごとに属性を付けて marker にするか、view の側で style を選び分ける |
| 要素の子孫（`.evidence h2`、`.review-bar__button svg` など） | 13 | StyleX は要素を外から狙えない（「StyleX doesn't allow arbitrary selectors」）。その要素に直接 style を付ける |
| `:has()`（`.layout:has(> .self-pause-notice) > .intake-notice` など） | 2 | `when.descendant` などに書き換える（StyleX は `:has()` に頼ると docs に書く）。直下の子の `>` は表せない（**未検証**） |
| `html`・`body`・`#root`、複合クラス（`.review-bar__button.review-rate__button`） | 5 | 全体の規則は StyleX で書けないので、素の CSS に少し残る |
| `@keyframes` | 2 | `stylex.keyframes` |
| `@media` | 5 | 値の条件として書ける |
| `color-mix()`・`min()`・`calc()` の値 | 4・11・14 か所 | 値の文字列としてそのまま書ける。`@stylexjs/valid-styles` も通った（検証済み） |

合わせて 65 のセレクタ（クラスの子孫・子 50、要素の子孫 13、`:has()` 2）が書き換えになり、全体の規則 5 つは素の CSS に残る。

### `stylex.props` を Foldkit に載せる形

前回と同じ。`h.Class`・`h.Style` は後勝ちなので、`stylex.props(...)` の `className` は印のクラス（`.nopan`・`.nowheel`、`MAP_NODE_BUTTON_CLASS`）と 1 つの文字列に、`style` は同じ要素の他の `h.Style`（ノードの `transform` など）と 1 つのオブジェクトにまとめて渡す。今回の試しでは、`stylex.props(...).className` と意味のクラス名を空白で連ねて `h.Class` に渡す形で、build・`tsc`・`effect-tsgo` が通った（検証済み）。

## 素の CSS + CSS 変数

### 書き換えの量

`web/src` のテストを除く `.ts` で、`h.Class(` の行は 93（呼び出しは 107。1 行に 2 つあるものがある）。その引数の文字列リテラルを数えた。

- 文字列リテラル 95 のうち、ユーティリティを含むものが 75、重複を除くと 69。ユーティリティの語は延べ 313、種類は 118。
- `h.Class` の外にもユーティリティがある: `review/controls.ts` の `buttonClassName`・`itemsClassName` など、`sessionLayout/speakerName.ts` の `SPEAKER_NAME_COLORS`（話者の色 5 つ）と `cellClass`。
- 意味のクラス名を持たず、ユーティリティだけの文字列が数か所ある（`"m-0 w-full"`、名前の入力欄の `"block w-full …"`）。ここには新しく名前を付ける。

**`styles.css` の行数の見込み:** 新しい規則はおよそ 75〜80（69 の文字列と `h.Class` の外の数か所。すでに規則がある名前（`review-tip` など）は今の行に足すので、もう少し減る）。宣言はおよそ 310。今の `styles.css` の書き方（1 規則 1 行）なら 218 行から約 300 行。1 宣言 1 行で書けば約 700 行。CSS の整形の道具は repo に無いので、書き方は決めるだけでよい。

### トークン（CSS 変数）が 1 ファイル HTML と dev に乗るか

- **1 ファイル HTML（検証済み）:** 捨てる worktree で、`styles.css` の先頭の Tailwind の入口（`@layer`・`@import "tailwindcss/…"`・`@source`・`@theme static`）を `:root { --color-gray-500: #6b7280; … }` に置き換え、`vite.config.ts` から `tailwindcss()` を外して、`review.ts` と同じ形でビルドした。出力の `index.html` に `<link>` は無く、`<style>` に `:root{--spacing:1px;--color-white:#fff;…--color-gray-500:#6b7280;…}` と、`var(--color-gray-500)` を使う規則が入った。Vite の CSS の処理だけで済み、プラグインは要らない。
- **dev（HMR）（検証済み）:** 同じ状態で `vite` の dev サーバーを立て、`/src/styles.css` を取ると、`import.meta.hot = __vite__createHotContext("/src/styles.css")`・`__vite__updateStyle(__vite__id, __vite__css)`・`import.meta.hot.accept()` を持つモジュールとして返り、中に `--color-gray-500: #6b7280` があった。CSS を変えると、そのモジュールが自分を差し替える形。ブラウザで実際に差し替わる様子は見ていない（**未検証**）。Vite の docs は「Importing `.css` files will inject its content to the page via a `<style>` tag with HMR support」と書く。
- 今の `styles.css` はすでに `--kind-color`・`--local-mode-color`・`--caption-name-width` などの CSS 変数を使っており、Tailwind の `@theme static` の値も出力では `:root` の CSS 変数になっている。トークンを `:root` に移すのは、置き場所を変えるだけ。

### Tailwind を外すと消える依存

web から `tailwindcss` と `@tailwindcss/vite` を外すと、`pnpm-lock.yaml` の packages から 32 項目が消えた（検証済み）: `tailwindcss`、`@tailwindcss/{vite,node,oxide}`、`@tailwindcss/oxide-*` の各 OS 向けの 12、`lightningcss@1.32.0` と各 OS 向けの 10、`enhanced-resolve`、`graceful-fs`、`magic-string`、`tapable`。Mac に実際に入るのは、OS 向けのものを 1 つずつにした約 11。Vite 8.3.2 自身は `lightningcss ^1.33.0` に依存するので、Vite の側の `lightningcss` は残る。

### 打ち間違い・未使用のクラスを捕まえる手段

| 手段 | 依存 | `h.Class` の綴り違い | 未使用のクラス | CSS のプロパティの綴り違い | 根拠 |
|---|---|---|---|---|---|
| fallow `3.33.1` の CSS の規則（`fallow health --css`、`fallow audit --css-deep`） | 増えない（固定済み） | 捕まえない。`h.Class("map-node__mark")` を `map-node__marc` にしても `unresolved_class_references` は 0 のまま | 誤検知が多い。`h.Class` を参照として読まないので、使っている `map-node__mark`・`captions__bubble`・`review-bar` など 49 個を「どこからも参照されない」と出す | 対象外 | 試し。fallow の docs（`fallow.tools/docs/explanations/health/`）は参照を「markup」の中のクラス名と書く。参照を読む関数を足す設定は `schema.json` に無い |
| fallow の他の CSS の規則 | 増えない | — | — | — | `css-token-drift`（トークンがあるのに生の値を書いた: 今 2 件）と `css-selector-complexity`（8 件）は今の `styles.css` に効く。どれも既定は `warn` で CI を止めない |
| oxlint | 増えない | 捕まえない（CSS のクラス名の規則は無い） | — | 対象外（CSS を読まない） | `oxlint --rules` |
| 小さな検査スクリプト（`server/scripts/check-*.ts` と同じ形） | 増えない | 捕まえる（検証済み） | 捕まえる | 対象外 | 下の試し |
| クラス名を TS の定数にする（`const C = { mapNodeMark: "map-node__mark" } as const`） | 増えない | `tsc` が捕まえる（プロパティの綴り違い） | `fallow` の未使用の export で一部 | 対象外 | TypeScript の型検査。定数と CSS の規則の食い違いは捕まえない |
| stylelint（`property-no-unknown`） | 増える | — | — | 捕まえる | 入れていない。StyleX の側の `@stylexjs/valid-styles` に当たるもの |

**検査スクリプトの試し（検証済み）:** 約 30 行の Node スクリプトで、`web/src` のテスト以外の `.ts` から `h.Class(...)` の引数と `…ClassName:`・`…_CLASS(ES) =` の値の中の文字列リテラルを取り、`__` か `--` を含む語（BEM の名前）を集めて、`styles.css` のクラスのセレクタと突き合わせた。`map-node__marc` を「定義の無いクラス」として報告した。

- 今の main で流すと、Tailwind のユーティリティと並べただけで規則を持たない BEM の名前（`evidence__meta`・`todos__time` など 33）も「定義の無いクラス」に出る。素の CSS に移して、すべての名前に規則を持たせれば消える。逆に「未使用」には、テンプレート文字列や条件で組み立てる修飾子（`map-node--${kind}`・`captions__bubble--right` など）が出る。決まり（クラス名は `h.Class` か決まった定数の中に文字列リテラルで全部書く。組み立てる修飾子は許す一覧に書く）を置かないと誤検知が残る。
- JS の `closest()` だけが使う印（`nopan`・`nowheel`）は、許す一覧に入れる。
- AGENTS.md の「Rules and what enforces them」の形に合う。`typecheck` に載せれば CI で止まる。

## 追補: 2 回目の試しで分かったこと

上の調べのあと、別の捨てるブランチ（`origin/main` の `1468f11` から切った `scratch/stylex-try` と `scratch/plain-css-try`。どちらも push していない）で、上の「未検証のもの」の一部と、上で触れていない点を確かめた。StyleX の側は `keys/keyList.ts`（Popover のパネルと、子孫セレクタ `.key-list__anchor .key-list`）と `mapSurface/main.ts`（点滅の `@keyframes`、`.map-node:hover .map-node__fold-dot` を marker に、ノードの枠と画面外の点）を書き換え、素の CSS の側は `keys/keyList.ts` と `sessionLayout/speakerName.ts` のユーティリティをすべて意味のクラス名の規則に移した。

### dev での CSS の変更は、どの書き方でも全体の再読み込みになる（検証済み）

- Tailwind を外し、トークンを `:root` に置いた web の dev サーバーをブラウザ（Chrome DevTools MCP）で開き、`styles.css` の `--color-gray-200` を書き換えた。`getComputedStyle(document.documentElement)` の値は 2 秒以内に新しい値になったが、`window` に置いた印は消え、`performance.timeOrigin` が変わった。つまり `<style>` の差し替えではなく、ページ全体を読み直している。
- 理由は Foldkit の Vite プラグイン。`@foldkit/vite-plugin@0.27.0` の `handleHotUpdate` は、変わったモジュールがあれば必ず `server.ws.send({ type: 'full-reload' })` を送り、`[]` を返して Vite の HMR を止める（`dist/index.js` 526–535 行）。Model は Foldkit の側が保って読み直す（同ファイル 129 行の `isReloadFlush`）。
- このため「CSS 変数が HMR に乗るか」は、StyleX・素の CSS・今の Tailwind のどれでも同じ答え（変更は画面に出るが、全体の再読み込みで出る）になり、選ぶ材料にならない。
- StyleX の dev は、unplugin が HTML に `<script src="/@id/virtual:stylex:runtime">` と `<link href="/virtual:stylex.css">` を差し込み、`/virtual:stylex.css` に変換済みのモジュールの規則（`@keyframes x9kdo2h-B`、`.x-default-marker:hover *` など 67 規則）が出た。ファイルを変えて再変換させると新しい値が CSS に出た（検証済み。ブラウザで画面が変わる様子は見ていない）。

### StyleX は web のテストの段取りを変える（検証済み）

- web の `vite.config.ts` は、vitest の mode（`test`）では Foldkit の view-identity 変換が `vi.hoisted` を壊すので、プラグインを 1 つも入れない。StyleX を入れても同じにすると、`stylex.create`・`stylex.keyframes` が変換されないまま走り、「Unexpected 'stylex.keyframes' call at runtime. Styles must be compiled by '@stylexjs/babel-plugin'」で、unit の 54 ファイルのうち 27 が読み込みの段階で落ちた。StyleX は、ビルド時に変換しないと実行できない（`@stylexjs/stylex` の `lib/es/stylex.mjs` 133・166 行）。
- test の mode にだけ `stylex.vite()` を入れると読み込みは通るが、StyleX の動的な style（`slotAt: (x, y) => ({ transform: … })`）でノードの位置を書いた形では、scene テストの 26 件が落ちた。StyleX は動的な値を `--x-transform` のような CSS 変数で inline に渡し、規則の側で `transform: var(--x-transform)` と読むので、inline の `transform` を読むテスト（`mapSurface.scene.test.ts` の「ノードの外側の要素の transform が…」など）が値を見つけられない。
- 動的な値は今どおり `h.Style` で直接渡し、StyleX は動かない値だけにすると、unit の 1884 件がすべて通った。ただし StyleX を test の mode に入れた run だけ、終わりに「close timed out after 10000ms … something prevents Vite server from exiting」が出た（素の CSS の run では出ない）。unplugin の `configureServer` が `setInterval` を張る（`lib/es/vite.mjs` 59 行）のが原因と見ている（**未検証**、出る・出ないの対比だけ）。

### StyleX の書き方の未検証だった点（検証済み）

| 書いたもの | 出た CSS |
|---|---|
| 自分の属性: `display: { default: "none", ":is([data-open])": "block" }` | `.xrtxo2y[data-open]:not(#\#)… { display: block }`。自分の属性は `":is([…])"` のキーで書ける |
| 画面ごとの上書き（`.meeting .side` の類）: `display: { default: null, "@media (max-width: 768px)": { default: null, [stylex.when.ancestor('[data-screen="meeting"]')]: "none" } }` | `@media (width <= 768px) { .x10n2bjd…:where(.x-default-marker[data-screen="meeting"] *) { display: none } }`。画面の根に `data-screen` と marker を付ければ、`@media` と組んで書ける |
| `:focus-within` の祖先（`.review-volume:focus-within .review-volume__slider`） | `:where(.x-default-marker:focus-within *)` |
| 兄弟（`.layout:has(> .self-pause-notice) > .intake-notice` の代わり）: `when.anySibling(":is(*)")` | `:where(.x-default-marker:is(*) ~ *, :has( ~ .x-default-marker:is(*)))`。前後の兄弟の両方に当たり、今の「直下の子に休止の一言があるとき」と同じ意味にはならない |
| `@media (width < 600px)` | `@media (width <= 599.99px)` に書き換えて出す |
| `min(720px, calc(100vw - 2 * 316px))`、`color-mix(…)`、`calc(var(--caption-bubble-ratio) * (…))` | そのまま出る（`calc` の中は `100vw - 632px` に畳む） |

- marker は祖先の要素ごとに `stylex.props(stylex.defaultMarker()).className` を `h.Class` の文字列に足す。今回は `.map-node` に足し、子の畳む丸に `when.ancestor(":hover")` を書いた。
- 型: `tsc` は、キーワードの値を持つプロパティの綴り違い（`display: "flexx"`）を、その style を `stylex.props(...)` に渡した箇所で「Type '"flexx"' is not assignable … Did you mean '"flex"'?」として捕まえた。未知のキー（`colr: "red"`）と長さの綴り違い（`fontSize: "13pz"`）は通し、どちらもそのまま CSS に出た。`effect-tsgo diagnostics` は Effect の診断だけを出し、TS の型の誤り（`styles.kyes`）も出さない（`tsc` の側が TS2339 で捕まえる）。

### StyleX と `@foldkit/ui` の部品の `h.Style`

web が使う部品のうち、属性の配列に自分で `h.Style` を入れるもの（`@foldkit/ui@0.167.0` の `dist`）: Slider（track・塗り・thumb、`slider/index.js` 336・341・368 行）、Popover（button・panel、`popover/index.js` 366・373 行）、Menu（`menu/index.js` 556・567 行）、Tooltip（`tooltip/tooltip.js` 214 行）、Toast（`toast/index.js` 108・170 行）、Disclosure（`disclosure/index.js` 75・83 行）。`[...panel, h.Class(…)]` のように部品の属性の後ろに足すとき、`h.Class` は部品が `h.Class` を持たないので安全だが、`h.Style` を足すと部品の style（Popover のパネルの `position: absolute; visibility: hidden` など）が消える。StyleX の動的な style はこの `h.Style` になるので、これらの要素には動かない style だけを当てる決まりが要る。素の CSS でも、`h.Style` を足さない点は同じ。

### 依存の数: Tailwind を外して StyleX を入れたとき（検証済み）

- `origin/main` の web から `tailwindcss`・`@tailwindcss/vite` を外し、`@stylexjs/stylex@0.19.1`・`@stylexjs/unplugin@0.19.1`・`unplugin@2.3.11` を入れると、lock の packages は main に比べて 47 項目増え、32 項目減った（382 → 397）。`lightningcss` は Vite の `1.33.0` を共有し、増えなかった。
- `unplugin` は `@stylexjs/unplugin` の peer（`^2.3.11`）で、自分で入れる必要がある。版を付けずに入れると最新の `3.7.0` が入り、`pnpm peers check` が unmet peer を出した。上の 46 項目との 1 項目の差は、この `unplugin` を入れたかどうかの差と見ている。
- 素の CSS は 32 項目減って、増えない（上と同じ）。

### 素の CSS の行数の試算（検証済みの一部と推計）

- `keys/keyList.ts`（ユーティリティを持つ `h.Class` 5 か所）と `sessionLayout/speakerName.ts`（4 か所と話者の色の定数 5 つ）を移すと、規則は 17 行増えた（話者の色が 1 色 1 規則、`hover:underline` が `@media (hover: hover)` の 1 規則）。Tailwind の入口（`@layer`・`@import`・`@source`・`@theme static` と `--spacing`）の 6 行は `:root {` の 1 行になった。218 行 → 229 行。
- web のビルドの出力（Tailwind の `@layer utilities`）からユーティリティごとの宣言を引いて、`h.Class` ごとに意味のクラス名 1 つの規則にまとめると、規則は 79、宣言は 394（`--tw-*` の内部の変数を含む）になった。1 規則 1 行なら約 300 行、1 宣言 1 行なら約 550〜700 行。上の見込み（約 300 行）と合う。
- 1 ファイル HTML（検証済み）: この状態で `review.ts` と同じ形でビルドすると、`<style>` に `--color-gray-200:#e5e7eb` と `.captions__name--c1{color:#2f6fb3}` が入り、`<link>` は無かった。
- テスト: unit の 1884 件のうち 1 件（`sessionLayout.scene.test.ts` 230 行、仮の名前は `opacity-50` を持つ）が、ユーティリティのクラス名そのものを見ていて落ちた。移すときは、ユーティリティの名前を見るテストを意味のクラス名に書き換える。

### fallow の `css-dead-surface` は、足した未使用のクラスを `audit` で捕まえる（検証済み）

- `styles.css` に `.key-list__unused { color: red; }` を足して `fallow audit --base origin/main` を流すと、`css-dead-surface`（`unreferenced-css-class`、`key-list__unused`）が出た。変えたファイルに絞る `audit` では、新しく足した未使用のクラスは捕まる。既定は `warn` で verdict を変えない。
- `h.Class("key-list__row")` を `key-list__ro`（1 文字違い）や `key-list__keyz` にしても、`css-broken-reference` は出なかった（上の結論と同じ）。
- 依存を増やさない検査スクリプトの別の試し（約 40 行、`h.Class` の文字列のうち BEM の形の語を拾う）でも、`key-list__ro`・`key-list__keyz` を「定義の無いクラス」に、移したあとの `key-list__row` と足した `key-list__unused` を「使われていないクラス」に出した。`test/semanticClasses.ts` の `SEMANTIC_CLASSES`（scene テストが使う意味のクラス名の一覧、約 110 個）が、印のクラスと規則を持たない名前の「許す一覧」の元にできる。

## 推奨（#1795 で決める）

1. **素の CSS + CSS 変数を選ぶ。** Tailwind の 32 項目が消え、増える依存は無い。1 ファイル HTML と dev にそのまま乗る（どちらも検証済み）。今の `styles.css` は、子孫・状態のセレクタ、`@keyframes`、`color-mix`・`min()`・`calc()` をすでに素の CSS で持っているので、移すのは `h.Class` のユーティリティ（延べ 313 語、規則にして約 75〜80）だけ。
2. **トークンは `:root` の CSS 変数に置く。** 今の `@theme static` の 14 個（色 12、`--spacing`、`--font-weight-semibold`）をそのまま写す。`--spacing: 1px` は Tailwind の数のユーティリティのためだけにあるので、移したあとは要らない。
3. **打ち間違いの検査は小さなスクリプトで足す。** `h.Class` のクラス名と `styles.css` の規則を両方向に突き合わせ、`typecheck` に載せる。fallow の CSS の規則は Foldkit の `h.Class` を読まないので、未使用のクラスの検査には使えない（fallow の側で Foldkit を読めるようになるまで）。CSS のプロパティの綴り違いは、stylelint を入れない限り捕まらない（StyleX も lint を足さないと捕まらない点は同じ）。
4. **StyleX は今回も勧めない。** 10/10 の 4 点のうち、1 ファイル HTML の回避・0.x の互換の壊れ方・65 のセレクタの書き換えは今も同じ。綴り違いは lint で捕まるようになったが、`@stylexjs/eslint-plugin` を oxlint の alpha の JS プラグインに載せることになる。依存は Tailwind を外して減る分より多く増える（+47・−32、追補）。加えて、変換なしでは実行できないので、web の vitest の mode にも StyleX のプラグインを入れる必要があり、動的な値を StyleX で書くと inline の style を読む scene テストが落ちる（追補）。

## 未検証のもの

- `:has(> …)` の直下の子を StyleX で同じ意味に表せるか（`when.anySibling` は前後の兄弟の両方に当たる。追補）。
- StyleX を vitest の mode に入れたときの「close timed out」の原因（unplugin の `setInterval` と見ているが、確かめていない）。
- 素の CSS に全部移したあとの `styles.css` の実際の行数（2 ファイルを移した実数と、残りの推計だけ）。
- StyleX・素の CSS で描いた画面の寸法が今と同じか（ビルドの出力と CSS の文面を見ただけで、画面の computed style は比べていない）。
- 検査スクリプトを今のコードの組み立てる修飾子（`map-node--${kind}` など）に合わせたときの、許す一覧の大きさ。

## 出典

- StyleX: npm の `@stylexjs/stylex`・`@stylexjs/unplugin`・`@stylexjs/babel-plugin`・`@stylexjs/eslint-plugin`（版・時刻・依存）、`api.npmjs.org/downloads/point/last-week/…`。`github.com/facebook/stylex` の `CHANGELOG.md`、`compare/5a419da...main`、`packages/@stylexjs/unplugin/src/vite.js` の履歴、`packages/@stylexjs/eslint-plugin/src/stylex-valid-styles.js`、`packages/@stylexjs/stylex/src/stylex.js`、`packages/docs/content/docs/api/javascript/when.mdx`。`@stylexjs/unplugin@0.19.1` の `lib/es/vite.mjs`
- Foldkit: `foldkit@0.167.0` の `dist/html/index.js`、`github.com/foldkit/foldkit` の `packages/foldkit/src/html/index.ts`、コード検索
- fallow: `fallow@3.33.1` の `capabilities.json`・`issue-registry.json`・`schema.json`、fallow.tools/docs/explanations/health/
- oxlint: oxc.rs/docs/guide/usage/linter/js-plugins
- Vite: vite.dev/guide/features（CSS の HMR）、npm の `vite@8.3.2` の依存
- 追補: `@foldkit/vite-plugin@0.27.0` の `dist/index.js`、`@foldkit/ui@0.167.0` の `dist/{slider,popover,menu,tooltip,toast,disclosure}`、`@stylexjs/stylex@0.19.1` の `lib/es/stylex.mjs`、StyleX の docs（`e3e2d02`）の `learn/styling-ui/defining-styles.mdx`・`api/javascript/when.mdx`・`api/configuration/eslint-plugin.mdx`、`unplugin` の npm の版、`fallow audit --base origin/main` の JSON、この repo の `test/semanticClasses.ts`・`test/sessionLayout.scene.test.ts`・`test/mapSurface.scene.test.ts`
- 10/10 の調査: `origin/research/foldkit-css` の `docs/investigations/2026-10-10-foldkit-css.md`（#747）
- この repo: `web/src/styles.css`、`web/vite.config.ts`、`web/AGENTS.md`、`web/src/app/**`、`server/src/review.ts`、`.fallowrc.json`
