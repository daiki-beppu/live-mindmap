# Foldkit と組む CSS の書き方（Tailwind・StyleX）の事実（Issue #747）

地図 #734 の調査チケット。web を Foldkit（`foldkit@0.167.0`・`@foldkit/ui@0.167.0`、素の描画は vendored snabbdom）へ載せ替えるとき、今の `web/src/styles.css`（158 行の素の CSS）を Tailwind（v4）か StyleX に替えたら何が起きるかを、一次資料（公式ドキュメント・GitHub のソースと README・npm）と、捨てるブランチでの試しのビルドで確かめた。決めるのは #748。

- 出典の版: Foldkit は `github.com/foldkit/foldkit` の `main`（コミット `49dc36e`）。StyleX は `github.com/facebook/stylex` の `main`（コミット `5a419da`、`@stylexjs/*` は `0.19.1`）。Tailwind は npm の `tailwindcss@4.3.3`・`@tailwindcss/vite@4.3.3` と `tailwindcss.com/docs`。npm の数字は 2026-10-10 に `npm view` と `api.npmjs.org` で取った。
- 試しのビルド: 試作のブランチ `origin/prototype/foldkit-review`（`web/src/prototype-foldkit/`）から切った手元だけの捨てるブランチ（`scratch/foldkit-css-try`、push していない）。Vite `8.3.2`、`vite-plugin-singlefile@2.3.3`、TypeScript `7.0.2`。
- **未検証** と書いたものは、資料を読んだだけで動かしていない、または一次資料で確かめられなかった主張。

## 結論

- **Foldkit の周りは Tailwind 一色。** examples の 34 個すべてが `tailwindcss`・`@tailwindcss/vite`（`^4.3.3`）を使い、`create-foldkit-app` の雛形・foldkit.dev のサイト・Foldkit 同梱のエージェント向けスキル（`skills/generate-program`）も Tailwind を前提にする。StyleX はリポジトリのどこにも出てこない。`@foldkit/ui` は headless（見た目を持たない）で、クラスは利用者が `h.Class` で足す。
- **Tailwind v4 は手を入れずに通る。** `@tailwindcss/vite@4.3.3` は peer に `vite: ^5.2.0 || ^6 || ^7 || ^8` を持ち、試作に入れて single-file のビルドを通すと、ユーティリティ・`@theme` の色・`@keyframes` の点滅が `<style>` に入った（検証済み）。
- **StyleX はそのままでは 1 ファイルの HTML に入らない。** `@stylexjs/unplugin` の Vite 版と `vite-plugin-singlefile` を並べると、StyleX の CSS は `<style>` に入らず `assets/stylex.css` に別に書かれた（検証済み）。StyleX の `generateBundle` を `enforce: "post"` の別のプラグインに移して singlefile の前に走らせると入った（検証済み、ただし unplugin の内部の形に頼る回避）。
- **Foldkit の属性は「後勝ち」。** 1 つの要素に `h.Class` を 2 回渡すと後の 1 つだけが残り、`h.Style` も同じ（検証済み）。`stylex.props` の `className`・`style` を載せるときも、Tailwind のクラスを足すときも、1 つの文字列・1 つのオブジェクトにまとめてから渡す必要がある。`@foldkit/ui` の `Slider` は track・thumb・塗りに `h.Style` を自分で付けるので、その後ろに `h.Style` を足すと Slider の位置の指定が消える。
- **今の CSS の色は、もともと Tailwind v3 の既定の色そのもの。** `styles.css` の 9 色（`#6b7280` など）はすべて Tailwind v3 の `gray-50`〜`gray-900` と `yellow-400` に一致する。「AI 臭くない」見た目を作っているのは色ではなく、影・バッジ・色帯を付けない決まり（コメントに書いてある）の側。
- **推奨（決めるのは #748）:** 替えるなら Tailwind。ただし既定の見た目に寄らないよう、Preflight を外し、`@theme` を `--*: initial` で空にして今の色・寸法だけを token にし、自動の走査を切って `web/src` だけを読ませる。点滅の keyframes・`:hover` で子を出す類（`.map-node:hover .map-node__fold-dot`）・`.nopan`／`.nowheel` は CSS の側に残す。StyleX は、Foldkit での使用例が無い・1 ファイルの HTML に回避が要る・祖先の状態で子を変えるのに marker が要る・0.x でパッチ版にも破壊的変更が入る、の 4 点で勧めない。替えずに今の素の CSS（クラス名）のまま載せ替える道もあり、試作はそれで動いている。

## Foldkit 側の事実

| 確かめたこと | 事実 | 出典 |
|---|---|---|
| examples が CSS に何を使うか | `examples/` の 34 個すべての `package.json` に `tailwindcss` と `@tailwindcss/vite`（`^4.3.3`）。`vite.config.ts` は `plugins: [tailwindcss(), foldkit(...)]`、`src/styles.css` は `@import 'tailwindcss';` だけ | `examples/*/package.json`、`examples/counter/vite.config.ts`・`src/styles.css` |
| 雛形・サイト | `packages/foldkit/README.md`:「`create-foldkit-app` scaffolds a complete setup with Tailwind, TypeScript, Oxlint, Oxfmt, and the Vite plugin」。サイト（`packages/website`）も `tailwindcss@^4.3.3`・`vite@^8.3.1` で、クラスの衝突を `tailwind-merge`（`extendTailwindMerge`）で解く | `packages/foldkit/README.md` 32 行、`packages/website/package.json`、`packages/website/src/prose.ts` 17 行 |
| `@foldkit/ui` の見た目 | 「Headless, accessible UI components」「You provide the elements and the styling」。README の例は `h.Class('px-4 py-2 rounded-lg')`。Animation のページは「Style with Tailwind data-attribute selectors like `data-[closed]:opacity-0`」 | `packages/ui/README.md`、`packages/website/src/page/ui/animationPage.md` 27 行 |
| エージェント向けの指示 | Foldkit 同梱のスキル `generate-program` は「`vite.config.ts` with Tailwind」「Use `h.Class(...)` for Tailwind classes」、Preflight が `input` の白を消す注意まで書く | `skills/generate-program/SKILL.md` 296・299・588・725 行 |
| StyleX の言及 | リポジトリ全体で 0 件 | `grep -ri stylex`（clone 全体） |
| `h.Class` の実装 | 文字列を空白で割って snabbdom の class モジュールの `{名前: true}` にし、`ctx.data.class` に**代入**する（足し合わせない）。`h.Style` も `ctx.data.style` に代入 | `packages/foldkit/src/html/index.ts` 1323–1331 行（`setModuleData`）・1632 行・2321 行 |
| 後勝ちの確認 | `inertHtml.div([h.Class("a b"), h.Class("c"), h.Style({color:"red"}), h.Style({"--x":"1"})])` の data は `{"class":{"c":true},"style":{"--x":"1"}}`（検証済み） | 捨てるブランチの `csstry/classTwice.ts` |
| `@foldkit/ui` が付ける style | `Slider` は track（`position: relative; touch-action: none`）・塗り・thumb（位置）に `h.Style` を付ける。root には付けない | `packages/ui/src/slider/index.ts` 736–797 行 |

`h.Class` は任意の文字列を受けるので、Tailwind のクラス・StyleX が返す `className`・`.nopan` のような印のクラスは、どれも 1 つの文字列に連ねれば載る。試作の `cls(...)`（偽の値を落として空白で連ねる）がそのまま使える。

## Tailwind v4

### 入れ方とビルド

- 公式の手順は `npm install tailwindcss @tailwindcss/vite`、`vite.config.ts` に `tailwindcss()`、CSS に `@import "tailwindcss";`（tailwindcss.com/docs/installation/using-vite）。
- `@tailwindcss/vite@4.3.3` の peer は `vite: ^5.2.0 || ^6 || ^7 || ^8`（npm）。Foldkit の examples も Vite `^8.3.1` で使っている。
- **試し（検証済み）:** 試作に `tailwindcss@4.3.3`・`@tailwindcss/vite@4.3.3` を足し、キー一覧を `absolute top-3 right-3 z-5 border border-line bg-white px-3 py-2 text-[13px] text-ink pointer-events-none` に、点滅を `@theme` の `--animate-node-blink` と `@keyframes` に置き換えて、`vite-plugin-singlefile` で build した。出力は `index.html` 1 つで、`<link rel=stylesheet>` は無く、`.top-3`・`.text-\[13px\]`・`.animate-node-blink`・`@keyframes node-blink`・`--color-ink` の色が `<style>` に入った。今の `styles.css` と並べても壊れない。
- `vite-plugin-singlefile@2.3.3` の peer は `vite: ^5.4.21 || ^6 || ^7 || ^8`。
- dev サーバー（HMR）での動きは **未検証**。

### 今の CSS との相性

| 今の CSS の中身 | Tailwind での扱い | 根拠 |
|---|---|---|
| 点滅（`@keyframes map-node-blink`、50% だけ指定、`animation: 1s ease-in-out 3`） | `@theme` に `--animate-node-blink` と `@keyframes` を置くと `animate-node-blink` で使える（検証済み）。中身は今の CSS をそのまま写せる | 試しのビルド |
| 動的な `transform`（ノードの `translate`、ビューポートの `translate() scale()`） | Tailwind は実行時の値を作れない（ソースを文字列として走査し、完全なクラス名だけを生成する）。今の試作どおり `h.Style` で直接当てる | tailwindcss.com/docs/detecting-classes-in-source-files |
| `.nopan`・`.nowheel`・`MAP_NODE_BUTTON_CLASS`・`FOLD_DOT_CLASSES`（JS が `closest()` で探す） | ただのクラス名として `h.Class` の文字列に並べれば残る。Tailwind は CSS を持たない名前を無視するだけ | 同上（未知の名前は生成しない） |
| 子孫・状態のセレクタ（`.map-node:hover .map-node__fold-dot`、`.review-seek[data-pointing] .review-seek__thumb`、`.review-volume:focus-within ...`） | `group-hover:`・`group-data-[pointing]:` などの variant で書けるが、親に `group` を付け、子のクラスが長くなる。CSS の側に残す手もある | **未検証**（variant の書き方は公式の docs に載る機能だが、今回は試していない） |
| `color-mix(in srgb, var(--kind-color) 15%, white)`、`min(720px, calc(100vw - 2 * 316px))` | 任意値 `bg-[color-mix(in_srgb,var(--kind-color)_15%,white)]` のように書ける（空白は `_`）。読みにくくなるので、CSS か `@utility` に置く方が素直 | tailwindcss.com/docs/adding-custom-styles |
| 共有画面で動かさない固定の寸法（字幕の幅・`bottom: 24px`・右の列 300px） | 任意値（`w-[300px]`）か `@theme` の token。値そのものは変わらない | 同上 |
| Preflight | `@import "tailwindcss"` は Preflight（全要素の margin・padding を 0、`border: 0 solid`、`ol, ul` の `list-style: none`、`img, svg, video, canvas, audio` を `display: block` など）を入れる。Preflight は `h1`〜`h6` の `font-weight` も `inherit` にするので、`font-weight` を書いていない `.evidence h2`・`.changes h2`（根拠・変わったこと の見出し）は太字でなくなる（docs の記述からの推論、**未検証**）。`tailwindcss/theme.css` と `tailwindcss/utilities.css` だけを import すれば外せる（試しのビルドはこの形） | tailwindcss.com/docs/preflight |
| 今の素の CSS と混ぜたときの優先 | Tailwind の出力は `@layer theme`・`@layer utilities` に入る。層の外の CSS（今の `styles.css`）は層の中の宣言に常に勝つので、同じ要素に今のクラスとユーティリティを両方付けると、ユーティリティが効かない。少しずつ移すなら、今の CSS を `@layer components` に入れる | MDN `@layer`「Styles that are not defined in a layer always override styles declared in named and anonymous layers.」、tailwindcss.com/docs/adding-custom-styles |

### 自動の走査が拾う余計なもの（検証済み）

Tailwind は既定で `.gitignore`・`node_modules`・CSS・lock ファイル以外のすべてのファイルを平文として走査する（tailwindcss.com/docs/detecting-classes-in-source-files）。試しのビルドでは、書いていないのに `.visible`・`.hidden`・`.transform`・`.container`・`.border` が生成された（ソース中の `"visible"`・`"hidden"` などの語を拾った）。今は害が無いが、`hidden` という名前のクラスを自分で使うと `display: none` が付く。`@import "tailwindcss" source(none);` と `@source "../src";` で走査先を絞れる（同ページ）。

### 既定の見た目への寄りやすさ

- `@import "tailwindcss"` は既定の theme（色・文字の大きさ・影・角丸・字体）を入れ、`bg-red-200`・`shadow-sm`・`rounded-lg` などはそこから生える（tailwindcss.com/docs/theme「This is why utilities like `bg-red-200`, `font-serif`, and `shadow-sm` exist out of the box」）。
- `@theme { --*: initial; ... }` で既定の theme を全部消し、自分の token だけにできる。`--color-*: initial` なら色だけ消える（同ページ）。試しのビルドで `--color-*: initial` にすると `--color-red` は出力に無かった（検証済み）。
- 今の `styles.css` の 9 色は、Tailwind v3 の既定の色と完全に一致する（`tailwindcss@3.4.17` の `lib/public/colors.js` で照合: `gray-50 #f9fafb`・`100 #f3f4f6`・`200 #e5e7eb`・`400 #9ca3af`・`500 #6b7280`・`600 #4b5563`・`700 #374151`・`900 #111827`・`yellow-400 #facc15`）。v4 の既定は OKLCH で値が少し違う（`gray-500` は `oklch(55.1% 0.027 264.364)`、`node_modules/tailwindcss/theme.css`）ので、v4 の既定の名前に移すと色がわずかに変わる。今の hex を token として `@theme` に写せば変わらない。
- Foldkit のスキルは「影を足すな」とは言わない。エージェントが Tailwind で書くと、既定の `shadow-*`・`rounded-*` を足しやすいかは **未検証**（経験則としてはあり得る）。theme を空にしておけば、その名前のクラスは生成されず効かない。

## StyleX

### Vite での入れ方

- 公式の Vite 対応は `@stylexjs/unplugin`（`stylex.vite()`）。公式の docs（`packages/docs/content/docs/learn/installation/vite/index.mdx`）と README（`packages/@stylexjs/unplugin/README.md`）の例は React（`@vitejs/plugin-react`）と並べる。peer は `unplugin: ^2.3.11` だけで、Vite の版の範囲は書いていない。
- 公式の examples の Vite は `^7.2.4`（`examples/example-vite/package.json`）。**Vite 8 で build が通ることは今回確かめた**（検証済み）。dev サーバーの HMR（`virtual:stylex:runtime`・`/virtual:stylex.css` を HTML に差す）は **未検証**。
- コミュニティの Vite プラグイン: `vite-plugin-stylex@0.13.0` は最終更新 2024-11、peer が `vite ^5.2.7`・`@stylexjs/stylex ^0.9.3` で止まっている。`@stylex-extend/vite@0.7.1` は 2025-03 が最後。`unplugin-stylex@0.6.3`（2026-05）は peer `@stylexjs/stylex 0.x`。`@stylexjs/esbuild-plugin` は npm で非推奨。公式の unplugin 以外を選ぶ理由は見当たらない（npm）。
- **1 ファイルの HTML（検証済み）:** `stylex.vite({ useCSSLayers: false })` と `viteSingleFile()` を並べた build では、StyleX の CSS は `<style>` に入らず `assets/stylex.css` に別に書かれた。unplugin は `generateBundle` で既存の CSS の asset に足し、無ければ `writeBundle` で `assets/stylex.css` を書く（`lib/es/vite.mjs` 121–165 行）。unplugin 本体は `enforce: 'pre'`（`lib/es/core.mjs` 330 行）なので、Vite 8 では `generateBundle` の時点でまだ CSS・HTML の asset が無く（bundle は JS 1 本だけだった）、`writeBundle` の時には singlefile が CSS を消している。`cssCodeSplit: true` にしても変わらなかった。unplugin が返すプラグインから `generateBundle` だけを抜いて `enforce: "post"` の別プラグインにし、singlefile の前に置くと `<style>` に入った。これは unplugin の内部の形に頼る回避で、版が上がると壊れ得る。

### React 以外での使い方

- StyleX は React に依らない。`stylex.props(...)` は `{ className?, style?, 'data-style-src'? }` を返す（`packages/@stylexjs/stylex/src/stylex.js` 138–169 行）。`stylex.attrs(...)` は `{ class?, style?: string }` を返し、docs は「useful for SSR output and for frameworks such as Solid, Svelte, Vue, and Qwik」と書く（`api/javascript/attrs.mdx`）。公式の examples に React 以外は SvelteKit が 1 つある。snabbdom・Foldkit の例は無い。
- **Foldkit への載せ方（検証済み）:** `h.Style` はオブジェクトを受けるので、`attrs` より `props` が合う。試作では次の形で build と型検査が通った。

  ```ts
  const sx = (h: H, extra: string, ...xs: stylex.StyleXStyles[]) => {
    const p = stylex.props(...xs);
    return [h.Class(cls(p.className, extra)), ...(p.style ? [h.Style(p.style as Record<string, string>)] : [])];
  };
  ```

  後勝ちのため、同じ要素に別の `h.Style`（例: ノードの `width`・`visibility`）があるなら、`stylex.props` の `style` と 1 つのオブジェクトにまとめる必要がある。`@foldkit/ui` の `Slider` の thumb などに StyleX の動的な style を当てると、Slider の位置の指定を上書きして消す。
- `.nopan`・`.nowheel` などの印のクラスは、`className` に文字列で連ねれば残る（StyleX のクラス名はハッシュ `x1u8a7rm` のような名前なので、JS から StyleX のクラスで `closest()` はできない）。

### 今の CSS との相性

| 今の CSS の中身 | StyleX での扱い | 根拠 |
|---|---|---|
| 点滅 | `stylex.keyframes({ "50%": {...} })` を `animationName` に渡す。試しのビルドで `@keyframes x9kdo2h-B` が出た（検証済み） | `learn/styling-ui/defining-styles.mdx`「Keyframe animations」 |
| 動的な `transform` | `node: (x, y) => ({ transform: \`translate(${x}px, ${y}px)\` })` で、`.xsqj5wx { transform: var(--x-transform) }` と `@property --x-transform` が出て、値は inline の CSS 変数で渡る（検証済み）。docs は「Dynamic styles are an advanced feature and should be used sparingly」と書く | 同ページ「Dynamic styles」 |
| 子孫・状態のセレクタ | 「StyleX doesn't allow arbitrary selectors or "styling at a distance"」。親の `:hover` で子を変えるには、親に `stylex.defaultMarker()` を付け、子で `stylex.when.ancestor(':hover')` を使う（試しで `.x-default-marker:hover *` が出た、検証済み）。`[data-pointing]` のような属性も `when.ancestor('[data-…]')` で書ける。今の 10 か所ほどの子孫セレクタは、すべて marker に書き換えになる | `learn/recipes/descendant-styles.mdx`、`api/javascript/when.mdx` |
| 優先度 | `useCSSLayers: false` の出力は各規則に `:not(#\#)` を重ねて詳細度を ID 並みに上げる（試しの出力で確認）。今の `styles.css` のクラスと同じ要素で競ると StyleX が勝つ。`useCSSLayers: true` にすると `@layer` に入り、今度は層の外の `styles.css` が勝つ | 試しの出力、`api/configuration/babel-plugin.mdx` の `useLayers`、MDN `@layer` |
| 型 | `stylex.create` のキーの綴り違い（`colr: "red"`）は、`tsc` も StyleX のコンパイラも通し、そのまま CSS に出た（検証済み）。綴りの検査は ESLint の `@stylexjs/eslint-plugin` の役（**未検証**） | 試しのビルド |

## 保守とエージェント

| 指標 | Tailwind | StyleX | （参考）Foldkit |
|---|---|---|---|
| 今の版 | `4.3.3`（2026-07-16） | `0.19.1`（2026-09-15） | `0.167.0`（2026-10-08） |
| 版の動き | v4 は 2025-01-21 の `4.0.0` から 46 回の安定版。直近は `4.2.0`（2026-02）→ `4.3.0`（2026-05）→ `4.3.3`（2026-07） | 0.x のまま。`0.16.2`（2025-10）から `0.19.1` まで 1 年で 14 回。CHANGELOG に破壊的変更が繰り返し載る: `0.13.0`（2025-05）で `attrs` を削除し `0.18.2`（2026-03）で戻す、`0.19.1`（パッチ版）で「Breaking: Remove `enableDebugClassNames`」 | npm に 209 版、9 月以降ほぼ週 1〜2 回 |
| npm の週の DL（2026-10-02〜08） | `tailwindcss` 1 億 3,423 万、`@tailwindcss/vite` 4,827 万 | `@stylexjs/stylex` 192 万、`@stylexjs/unplugin` 28 万 | `foldkit` 2.8 万 |
| GitHub の星 | 97,849 | 10,398 | 945 |

- **エージェントの知識の厚み:** 直接は測れない。代わりの目安として、利用の量は Tailwind が StyleX の約 70 倍（週の DL）。Foldkit 同梱のスキルとすべての examples が Tailwind で書かれているので、Foldkit を書くエージェントが読む手本は Tailwind になる。StyleX は 0.x で API が動く（`attrs` の削除と復活など）ため、古い知識で書くと今の版に合わない恐れがある（**未検証**、CHANGELOG からの推測）。
- **Tailwind v4 と v3 の違い:** v4 は設定を CSS（`@theme`・`@source`・`@utility`）に移したので、v3 の `tailwind.config.js` の知識で書くと合わない。エージェントが v3 の書き方を混ぜるかは **未検証**。
- **型:** Tailwind のクラスは文字列で型は付かない。StyleX は `StyleXStyles` の型で「どの style を受けるか」を部品の引数に書けるが、`create` の中の綴り違いは型では捕まらなかった（上表）。

## 推奨（#748 で決める）

1. **載せ替えでは CSS を替えず、今の `styles.css` をクラス名のまま使う**のが最小。試作はこれで動いており、Foldkit の都合で CSS を替える必要は無い。
2. **書き方を替えるなら Tailwind。** 理由: Foldkit の手本・雛形・スキルがすべて Tailwind、Vite 8 と 1 ファイルの HTML にそのまま入る、利用の量が桁違いに多い。既定の見た目に寄らないように、次の形で入れる。
   - Preflight を入れない（`tailwindcss/theme.css` と `tailwindcss/utilities.css` だけを import）。
   - `@theme { --*: initial; }` で既定の theme を消し、今の 9 色・寸法を token として写す（色は今の hex のまま）。既定の `shadow-*`・`rounded-*` が生成されなくなる。
   - `source(none)` と `@source "../src"` で走査先を絞る。
   - 点滅の keyframes、子孫・状態のセレクタ、`color-mix`・`min()` の長い値は CSS（`@layer components` か `@utility`）に残す。
   - 動的な `transform` は今どおり `h.Style`。
   - 今の CSS と混ぜる間は、今の CSS を `@layer components` に入れないとユーティリティが負ける。
3. **StyleX は勧めない。** 1 ファイルの HTML に入れるのに unplugin の内部に頼る回避が要る、Foldkit・snabbdom での使用例が無い、子孫セレクタを marker に書き換える量が多い、0.x でパッチ版にも破壊的変更が入る。
4. **どれを選んでも**、Foldkit の属性は後勝ちなので、クラスと style は 1 つの文字列・1 つのオブジェクトにまとめて渡す決まりが要る（`@foldkit/ui` の Slider の `h.Style` を上書きしない）。

## 未検証のもの

- Tailwind・StyleX の dev サーバー（HMR）での動き。
- 試作の画面を Tailwind・StyleX で描いた見た目が今と同じか（ビルドの出力を見ただけで、ブラウザでは見ていない）。
- Tailwind の `group-*` variant で今の子孫セレクタを書き換えたときの読みやすさ。
- `@stylexjs/eslint-plugin` が `create` の綴り違いを捕まえるか。
- エージェントが Tailwind で書くと既定の影・角丸を足しやすいか、v3 の書き方を混ぜるか。

## 出典

- Foldkit: `github.com/foldkit/foldkit`（`49dc36e`）の `examples/*/package.json`・`examples/counter/vite.config.ts`、`packages/foldkit/README.md`、`packages/foldkit/src/html/index.ts`、`packages/ui/README.md`・`packages/ui/src/slider/index.ts`、`packages/website/package.json`・`src/prose.ts`・`src/page/ui/*.md`、`skills/generate-program/SKILL.md`
- Tailwind: tailwindcss.com/docs/installation/using-vite、/docs/detecting-classes-in-source-files、/docs/preflight、/docs/theme、/docs/adding-custom-styles。npm の `tailwindcss`・`@tailwindcss/vite`（版・時刻・peer）、`tailwindcss@3.4.17` の `lib/public/colors.js`、`tailwindcss@4.3.3` の `theme.css`
- StyleX: `github.com/facebook/stylex`（`5a419da`）の `packages/@stylexjs/stylex/src/stylex.js`、`packages/@stylexjs/unplugin/README.md`、`packages/docs/content/docs/`（`learn/installation/vite/index.mdx`・`learn/styling-ui/defining-styles.mdx`・`learn/recipes/descendant-styles.mdx`・`api/javascript/attrs.mdx`・`api/javascript/when.mdx`・`api/configuration/babel-plugin.mdx`）、`examples/example-vite`・`examples/example-sveltekit`、`CHANGELOG.md`。npm の `@stylexjs/*`・`vite-plugin-stylex`・`@stylex-extend/vite`・`unplugin-stylex`。`@stylexjs/unplugin@0.19.1` の `lib/es/vite.mjs`・`lib/es/core.mjs`
- MDN: developer.mozilla.org/en-US/docs/Web/CSS/@layer
- npm の週の DL: api.npmjs.org/downloads/point/last-week。GitHub の星: `gh api repos/...`
- この repo: `web/src/styles.css`、`web/src/enterFold.ts`・`MapNode.tsx`・`MapView.tsx`（`closest()` と `.nopan`・`.nowheel`）、`origin/prototype/foldkit-review` の `web/src/prototype-foldkit/`
