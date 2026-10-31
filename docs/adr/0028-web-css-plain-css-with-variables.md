# web の CSS は Tailwind を外し、素の CSS と CSS 変数のトークンで書く

web の CSS を Tailwind から、素の CSS と `:root` の CSS 変数（デザイントークン）に替える（地図 [#1793](https://github.com/daiki-beppu/live-mindmap/issues/1793)、決定 [#1795](https://github.com/daiki-beppu/live-mindmap/issues/1795)）。StyleX は採らない。2026-10-10 に Tailwind を選んだ決定（[#748](https://github.com/daiki-beppu/live-mindmap/issues/748)）を置き換える。

#748 の決め手は「Foldkit の例・雛形・同梱のスキルがすべて Tailwind」だった。コードを書くのはエージェントで、手本の書き方は読み替えればよいので、この理由は軽くなった。書きやすさを理由に入れた依存は減らす。物差しは、依存が少ないこと、見返しの 1 ファイル HTML に CSS が収まること、今の寸法と見た目が変わらないこと、影とバッジを足さない控えめな見た目、Foldkit の `h.Class`・`h.Style` と組めること、打ち間違いを検査で捕まえられること、の 6 つ。

調査（[#1794](https://github.com/daiki-beppu/live-mindmap/issues/1794)）の結果、素の CSS はどの物差しも満たした。

- Tailwind の依存 32 項目が消え、増える依存は無い
- 1 ファイル HTML の `<style>` にも dev サーバーにも、回避なしでそのまま乗る
- 今の `styles.css` はすでにこの形なので、移すのは `h.Class` のユーティリティ（重複を除いて 69 の文字列）だけ。リセット用 CSS を入れないので行間も動かない
- `h.Class` のクラス名と `styles.css` の突き合わせは、小さな検査スクリプトで捕まえられた。fallow の CSS 検査は `h.Class` を参照として読まないので、それに頼らない

## Considered Options

- **StyleX**: `stylex.create` の綴り違いは oxlint と `@stylexjs/eslint-plugin` で捕まるようになった。一方で、1 ファイル HTML には今もプラグインの順を入れ替える回避なしでは入らない。依存は 46 項目増え（うち `@babel/*` が 20）、版は 0.x のままで、今の `styles.css` の 65 のセレクタ（クラスの子孫・子、要素の子孫、`:has()`）を書き換えることになる
- **Tailwind のまま**: 32 項目の依存と、リセットとテーマを外す設定を、書きやすさのためだけに持ち続けることになる

## Consequences

- クラス名に型は付かない。打ち間違いと未使用のクラスは、`typecheck` に載せる検査スクリプトで捕まえる
- `web/AGENTS.md` の Tailwind の読み替えと `styles.css` 冒頭の決まりは、移行の中で書き替える
