# web の AGENTS.md

Foldkit のコードは、公式の skill と llms.txt に従って書く。この文書は、そのうえで加える repo 固有の決まりと、版の上げ方を書く。

- 公式の skill: `.claude/skills/` と `.agents/skills/` の `audit-program`・`foldkit`・`generate-program`。
- llms.txt: https://foldkit.dev/llms.txt （各ページの URL の末尾に `.md` を付けると Markdown になる。全文は `llms-full.txt`）。
- 方針: Foldkit と `@foldkit/ui` の公式の機能をできるだけ使い、自前で書くのは公式に無いものだけにする。

## 公式の skill

- 写した版は、`github.com/foldkit/foldkit` のタグ `foldkit@0.167.0`（コミット `74071173b1253e9efeec050a31ca86df1931ce5a`）の `skills/`。出どころは `skills-lock.json` にも残る。
- skill の中身は書き換えない。食い違いは、この文書の側で読み替える。
- 読み替え 1（subtree）: skill `foldkit` は、参照用に foldkit のソースを `repos/foldkit/` に subtree で置くよう書いている。この repo は subtree を置かない。ソースは入れた `node_modules` のものを読む（`web/node_modules/foldkit/` と `web/node_modules/@foldkit/ui/`）。
- 読み替え 2（Tailwind）: skill `generate-program` は Tailwind を前提にしている。web は Tailwind v4（`@tailwindcss/vite`）を入れてあり、`h.Class` には意味のクラス名（BEM）にユーティリティを並べて書く。設定は `web/src/styles.css` の中: Preflight は外す（`theme.css` と `utilities.css` だけを import）、既定のテーマは `--*: initial` で消して今の色を今の hex のまま token にする、走査は `source(none)` と `@source` で web/src に絞る。点滅（`@keyframes`）と子孫・状態のセレクタ・`min()`/`calc()`/`color-mix` の長い値は、層の外の素の CSS に残す（ユーティリティに勝たせるため）。影（`shadow-*`）とバッジは足さない。

## コードの置き場

- Foldkit のコードは `web/src/app/` に置く。oxlint と `@foldkit/oxlint-plugin` の対象はこのディレクトリだけにする。
- 純粋な関数（`layout.ts`・`camera.ts` など）は今の場所のまま、`web/src/app/` から使う。

## Foldkit の規約

Foldkit の公式の規約に従う。公式の AGENTS.md のうちアプリ向けの部分、公式の `skills/`、`@foldkit/oxlint-plugin` のルールがそれに当たる。主なもの:

- イベントは、何が原因で起きるかで受け方を選ぶ。Message → Command、要素 → Mount、Model の条件で開け閉め → Subscription。属性のハンドラが渡さない値（wheel の量、修飾キー、`code`・`isComposing`、gesture、`<audio>` の時刻）は、要素の Mount か、`Dom.streamFromEvent` 系の Subscription で取る。
- Message は、動詞で始まる過去形の事実にする。Command の結果の Message は `Completed<Command名>` か `Succeeded…` / `Failed…` にする。`NoOp` は使わない。
- `modifyFields` を使う。`switch` と `commands: []` は書かない。
- 子（`@foldkit/ui` の Slider など）は `Update.foldChild` で組み込む。子の内部の Message には頼らない。
- Model の「無い」は `Schema.Option` で表す。
- キーは安定した ID で付ける。表示中のデータからは作らない。
- `@foldkit/vite-plugin` は必ず使い、`freezeModel` は切らない。
- Command は、それを返す update の隣に置く。
- lint: web に oxlint と `@foldkit/oxlint-plugin` を入れ、Foldkit のルールを error にする。対象は `web/src/app/` の Foldkit のコードだけ。web の `typecheck` で走らせる（`pnpm typecheck` と CI に載る）。
- 公式の skill と llms.txt に従う（上の節）。
- 導いた値: 配置・畳んだ後の木・カメラの目標などは、update でも view でも、元の値から純粋な関数で毎回計算する。重ければ `createLazy` を使う。それでも足りないと測れたときだけ Model に置き、入力を変える分岐のすべてで計算し直す。

## 公式の部品を使う

方針: できるだけ Foldkit と `@foldkit/ui` の公式の機能を使う。自前で書くのは公式に無いものだけ。

| 用途 | 使うもの |
|------|----------|
| キー | `Dom.streamFromKeyBindings` の表を 1 つ持つ。各バインディングに説明（キーの一覧の文言）も持たせ、Subscription とキーの一覧の両方をこの表から作る。キーの意味が Model で変わるときは「このキーが押された」という Message を出し、意味は update で決める。変換中のイベントはこの道具も無視するので、日本語入力がオンのときの直し（今の純粋な関数）は残す |
| ポインタ・ホイール・ジェスチャー | 公式の道具は無い。生のイベントは表示面の要素の Mount で受け、Mount は「何が起きたか」の Message を出すだけにする。キーの一覧の「マウス・トラックパッド」の行は、キーの表と同じ形の静的な表から作る |
| 速さのメニュー | `@foldkit/ui` の Menu |
| 見返しのボタンのツールチップ | `@foldkit/ui` の Tooltip |
| シークバー・音量 | `@foldkit/ui` の Slider |
| キーの一覧（`?`） | `@foldkit/ui` の Popover を `isModal: false` で使う。背景を止めず、マップを動かせる今の挙動を保つ（Dialog は常にモーダルで背景を `inert` にするので使わない） |
| 知らせ（取り込みの途切れ・共有画面・見る状態） | `@foldkit/ui` の Toast（headless）。今と同じ位置に描き、出入りの動きとスワイプでの消去は使わない。共有画面で画面を動かさない。消えるまでの時間は Toast の duration で持つ |
| 右の列・字幕の出す・隠す | `@foldkit/ui` の Disclosure |
| 文書・window のイベント | `Dom.streamFromEvent` 系 |

## Schema

- Model は本物の Schema で書き、型は Schema から導く。`Schema.declare` で素通しはしない。
- Snapshot とその部品（ノード・見る状態に要る値）は、server の `core` で Schema として定義する。型はそこから導き、server と web の両方がそれを使う。共有のパッケージには切り出さない。
- Set・Map が要る欄は、`Schema.ReadonlySet` / `HashSet` / `HashMap` などで書く。

## 版

- web も `effect` を server と同じ版（今は 4.0.1）で exact に持つ。Foldkit の peer（4.0.0 の exact）は、`pnpm-workspace.yaml` の `peerDependencyRules.allowedVersions` で許す。束ねられる effect は 1 つにする。
- `foldkit`・`@foldkit/ui`・`@foldkit/vite-plugin`・`@foldkit/oxlint-plugin` は exact で固定する。上げるのは、要る修正があるときか Effect を上げるときだけ。

### 版の上げ方

Foldkit は 1.0 より前で、マイナー版で互換を壊すことがある。だいたい 2〜4 日に 1 版出る。各リリースに GitHub Releases の upgrade guidance と blog の告知がある。

1. CHANGELOG の Breaking を読む。
2. GitHub Releases の upgrade guidance を読む。
3. 公式の skill を写し直す。リポジトリのルートで、新しいタグの URL で同じコマンドを流す（`<新しい版>` を置き換える）:

   ```sh
   npx -y skills@1.7.2 add "https://github.com/foldkit/foldkit/tree/foldkit@<新しい版>/skills" --skill "*" -a claude-code -a codex -y
   ```

   `skills-lock.json` と `.agents/skills/`・`.claude/skills/` の差分をコミットし、この文書の「写した版」のタグとコミットも更新する。
4. server・web・Foldkit をいっしょに動かす（effect を上げるなら server も同じ版に揃え、両方のテストと typecheck を通す）。
5. Foldkit の peer が server の effect の版に追いついたら、`peerDependencyRules.allowedVersions` の許可を外す。
