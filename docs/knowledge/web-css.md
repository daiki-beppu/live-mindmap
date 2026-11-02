# web の CSS

web の見た目（`web/src/styles.css` と、view の `h.Class`・`h.Style`）を足す・変えるとき、見た目のテストを書くとき、`styles.css` を書き換えて寸法と色が変わっていないことを確かめるときに読む文書。書き方の決まりそのものは [web/AGENTS.md](../../web/AGENTS.md) の読み替え 2 にあり、ここでは決まりの裏にある、はまりどころと確かめ方を書く。

- 用語: 無し（CSS の書き方はプロジェクト固有の概念ではない）
- ADR: [0028 web の CSS は Tailwind を外し、素の CSS と CSS 変数のトークンで書く](../adr/0028-web-css-plain-css-with-variables.md)

## クラス名は文字列で丸ごと書く。`check-css.ts` は文字列の中の語を拾うだけで、組み立てた名前は読めない

`web/scripts/check-css.ts` は web の `typecheck` の最後に流れる、依存なしの検査だ。テスト以外の `web/src` の TS の文字列リテラルと、テンプレートの固定部分から語を拾い、次の場合に落ちる。

- `__` か `--` を含む語（BEM の形）が、`styles.css` のどのセレクタにも無い（打ち間違い）
- `styles.css` のクラスが、どの TS の文字列にも出てこない（未使用）
- `:root` のトークンと同じ hex を、`:root` の外に生で書いた（`#fff` と `#ffffff` は同じとみなす）
- `box-shadow` が `none` 以外

`` `map-node--${kind}` `` のように名前の一部を組み立てると、`map-node--` と `kind` に分かれてしまい、打ち間違いも未使用も判定できない。修飾子は `cond ? "captions__bubble--right" : ""` のように名前全体で書く。規則を持たない印のクラス（JS の `closest()` や scene テストが探すだけの名前）は、スクリプトの中の `MARKER_CLASSES` に足す。今は `evidence__meta`・`review-seek__preview-chapter` の 2 つだ。

lint の道具の fallow にも CSS の検査（`--css`・`css-token-drift`）はあるが使わない。Foldkit の `h.Class` を参照として読まないので、使っているクラスを未使用と誤って出す。

捕まえないものもある。ユーティリティのようなクラス（`flex`・`mt-8` など、`__` も `--` も含まない名前）を作ること、`h.Style` に動かない値を書くこと、バッジを足すことは、レビューで見る（ルートの [AGENTS.md](../../AGENTS.md) の「Rules and what enforces them」）。下の `--tw-*` の内部変数も、クラス名でも hex でもないので捕まえない。

## 見た目のテストは、class 名ではなく、画面に出た値で見る

Tailwind からの移行（[#1817](https://github.com/daiki-beppu/live-mindmap/issues/1817)）では、ユーティリティの名前を名指ししたテストが壊れた。e2e の smoke は、自分の発言の行が右に寄ることを `class` に `justify-end` があるかで見ていて、[#1832](https://github.com/daiki-beppu/live-mindmap/issues/1832) の初回に落ちた。scene テストも、仮の名前が薄く出ることを `opacity-50` で見ていた。テストの段では、実装の前に 112 件中 6 件が落ちた。

実ブラウザで画面を開いて computed style と矩形を見る heavy IT（`web/test/review.mount.heavy.test.ts` 22 件・`meeting.mount.heavy.test.ts` 42 件）は、要素を意味のクラスか `aria-label` で選んで値を見ていた。この 2 本と `reviewControls.it.test.ts` は、移行の 4 本の PR すべてで書き替えずに通った。

寸法・位置・色を契約にするなら、この heavy IT の層に足す。scene テストで class を見るのは、状態の修飾子（`captions__row--right`・`captions__name--provisional`）が付くかだけにする。CSS の規則がその修飾子で何をするかは、scene では確かめられない。

## `styles.css` の `--tw-*` と `@property` は Tailwind の名残で、見た目には効いていない

撤去が終わった main の `styles.css` にも、`--tw-leading`・`--tw-font-weight`・`--tw-border-style`・`--tw-outline-style` が 13 か所残っている。うち 2 か所は `@property --tw-border-style`・`@property --tw-leading` の登録だ。移行のあいだの照合で、computed style の差分を 0 にするために、Tailwind が出していた内部変数を写したものだ（[開発ログ](../devlog/2026-11-02.md#tailwind-removal)の 3.）。

見た目に効いているのは、同じ規則に並べた標準のプロパティ（`line-height: 1.5`・`font-weight: 600` など）のほうだ。例外は `border-style: var(--tw-border-style)` の 2 か所で、登録の初期値の `solid` を読んでいる。消すときは、この 2 か所を `border-style: solid` に書き直してから `@property` を消す。新しい規則に `--tw-*` を写さない。

## computed style を全件比べる道具は、カスタムプロパティを入れるかを先に決める。`:root` と `@property` の変数は全要素に出る

`getComputedStyle(element)` を列挙すると、標準のプロパティに加えて、その要素に効いているカスタムプロパティも出てくる。`:root` の変数は全要素に継承される。`@property` で初期値つきに登録した変数は、継承しなくてもどの要素にも初期値で現れる。そのため、変数を 1 つ足したり消したりするだけで、差分は「変数の数 × 要素数」に膨らむ。

移行の照合（20 場面・2,499 要素）での例:

| 変えたこと | 差分 |
|---|---:|
| `border-0` の最後の使い手を消し、Tailwind が `@property --tw-border-style` を出さなくなった | 2,499 |
| `:root` から使わない `--spacing`・`--font-weight-semibold` を消した | 4,998（2 × 2,499） |
| 話し手の名前の色を渡す `--speaker-name-color` を `h.Style` で足した | 48 |

どれも見た目は変わっていない。変数は値を運ぶだけで、見た目は変数を読んだ先の標準のプロパティに出る。見た目が変わらないことを示したいなら、標準のプロパティと矩形だけを比べる。変数も比べるなら、意図して足す・消す変数を、許す差分として先に並べる。

照合のほかの作りは、移行で揺れずに使えた。画素ではなく値で比べる。比べる相手は `origin/main` を別のチェックアウトで同じ手元・同じ時間に流した結果にする。撮る前に `document.fonts.ready` と `document.getAnimations().length === 0` を期限つきで待ち、フォーカスを外す。矩形は 0.5px の誤差を許す。照合のスクリプト（`web/scripts/css-migration/`）は撤去の PR で消したので、また要るときは [PR #1839](https://github.com/daiki-beppu/live-mindmap/pull/1839) の差分から戻す。

## CSS を変えるたびにページ全体が読み直されたら、`vite.config.ts` の `handleHotUpdate` の差し替えを見る

Foldkit の Vite プラグインは、CSS の変更でもページ全体を読み直す。`web/vite.config.ts` は Foldkit のプラグインの `handleHotUpdate` を包み、`.css` の更新だけを Vite の差し替えに任せている（[PR #1853](https://github.com/daiki-beppu/live-mindmap/pull/1853)）。Foldkit を上げてプラグインの名前や `handleHotUpdate` が変わると、起動時に「Foldkit の handleHotUpdate がありません」で落ちる。

## 出典

- [web の CSS から Tailwind を外したときの開発ログ](../devlog/2026-11-02.md#tailwind-removal)
- 仕様 [#1817](https://github.com/daiki-beppu/live-mindmap/issues/1817)、親 [#1829](https://github.com/daiki-beppu/live-mindmap/issues/1829)、子 [#1830](https://github.com/daiki-beppu/live-mindmap/issues/1830)〜[#1833](https://github.com/daiki-beppu/live-mindmap/issues/1833)、[PR #1839](https://github.com/daiki-beppu/live-mindmap/pull/1839)・[#1841](https://github.com/daiki-beppu/live-mindmap/pull/1841)・[#1849](https://github.com/daiki-beppu/live-mindmap/pull/1849)・[#1853](https://github.com/daiki-beppu/live-mindmap/pull/1853)
- #1832 と #1833 の takt の run（`.takt/runs/20261031-*-issue-1832-*`・`20261102-*-issue-1833-*`）
