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

## 推奨（#1795 で決める）

1. **素の CSS + CSS 変数を選ぶ。** Tailwind の 32 項目が消え、増える依存は無い。1 ファイル HTML と dev にそのまま乗る（どちらも検証済み）。今の `styles.css` は、子孫・状態のセレクタ、`@keyframes`、`color-mix`・`min()`・`calc()` をすでに素の CSS で持っているので、移すのは `h.Class` のユーティリティ（延べ 313 語、規則にして約 75〜80）だけ。
2. **トークンは `:root` の CSS 変数に置く。** 今の `@theme static` の 14 個（色 12、`--spacing`、`--font-weight-semibold`）をそのまま写す。`--spacing: 1px` は Tailwind の数のユーティリティのためだけにあるので、移したあとは要らない。
3. **打ち間違いの検査は小さなスクリプトで足す。** `h.Class` のクラス名と `styles.css` の規則を両方向に突き合わせ、`typecheck` に載せる。fallow の CSS の規則は Foldkit の `h.Class` を読まないので、未使用のクラスの検査には使えない（fallow の側で Foldkit を読めるようになるまで）。CSS のプロパティの綴り違いは、stylelint を入れない限り捕まらない（StyleX も lint を足さないと捕まらない点は同じ）。
4. **StyleX は今回も勧めない。** 10/10 の 4 点のうち、1 ファイル HTML の回避・0.x の互換の壊れ方・65 のセレクタの書き換えは今も同じ。綴り違いは lint で捕まるようになったが、`@stylexjs/eslint-plugin` を oxlint の alpha の JS プラグインに載せることになる。依存は Tailwind を外して減る分より多く増える（46 項目以上）。

## 未検証のもの

- dev サーバーで CSS を変えたとき、ブラウザで実際に差し替わるか（HMR のモジュールとして配られることだけを確かめた）。
- Tailwind を外したあと StyleX を入れたときの依存の数（`lightningcss` を Vite と共有できるか）。
- StyleX で自分の属性（`.review-tip[data-open]` など）を書く形と、`:has(> …)` の直下の子を表せるか。
- 素の CSS に移したあとの `styles.css` の実際の行数（見込みは数えた語の数からの推計）。
- 検査スクリプトを今のコードの組み立てる修飾子（`map-node--${kind}` など）に合わせたときの、許す一覧の大きさ。

## 出典

- StyleX: npm の `@stylexjs/stylex`・`@stylexjs/unplugin`・`@stylexjs/babel-plugin`・`@stylexjs/eslint-plugin`（版・時刻・依存）、`api.npmjs.org/downloads/point/last-week/…`。`github.com/facebook/stylex` の `CHANGELOG.md`、`compare/5a419da...main`、`packages/@stylexjs/unplugin/src/vite.js` の履歴、`packages/@stylexjs/eslint-plugin/src/stylex-valid-styles.js`、`packages/@stylexjs/stylex/src/stylex.js`、`packages/docs/content/docs/api/javascript/when.mdx`。`@stylexjs/unplugin@0.19.1` の `lib/es/vite.mjs`
- Foldkit: `foldkit@0.167.0` の `dist/html/index.js`、`github.com/foldkit/foldkit` の `packages/foldkit/src/html/index.ts`、コード検索
- fallow: `fallow@3.33.1` の `capabilities.json`・`issue-registry.json`・`schema.json`、fallow.tools/docs/explanations/health/
- oxlint: oxc.rs/docs/guide/usage/linter/js-plugins
- Vite: vite.dev/guide/features（CSS の HMR）、npm の `vite@8.3.2` の依存
- 10/10 の調査: `origin/research/foldkit-css` の `docs/investigations/2026-10-10-foldkit-css.md`（#747）
- この repo: `web/src/styles.css`、`web/vite.config.ts`、`web/AGENTS.md`、`web/src/app/**`、`server/src/review.ts`、`.fallowrc.json`
