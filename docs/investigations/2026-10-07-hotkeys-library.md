# ショートカットキーのライブラリの調査（Issue #286）

地図 #153（画面を人が動かす操作）のショートカットキーに使うライブラリを選ぶための事実を、一次情報（公式ドキュメント・リポジトリのソース・npm レジストリ・Chromium のソース）で確かめた。調べた日は 2026-10-07。`web/package.json` の版は React `^19.3.0`、`@xyflow/react` `^12.12.0`。

結論は次のとおり。

- **TanStack Hotkeys（`@tanstack/react-hotkeys` 0.13.0）は、問いの要件（`Mod`、連続キー、入力欄での無効化、要素に限る、押しっぱなし、キー一覧）をすべて組み込みで持つ。ただし README に「alpha」と明記され、0.x の minor で破壊的変更が入っている（0.11.0・0.12.0）。** 使うなら exact-pin にして、上げるときは CHANGELOG を読む。
- **react-hotkeys-hook（5.3.3）は 2019 年からの安定版で、依存ゼロ・min+gzip で約 2.9 KB（TanStack は約 10.7 KB）。** `mod`・連続キー・スコープ・`description` はあるが、キー一覧は「登録中のキー」を Provider から取る形で、ヘルプ表示や `⌘` 表記の整形は自前になる。
- **React Flow のキー操作は、今の `MapView` の設定では大半がすでに効かないが、既定のキー（`Backspace`・`Shift`・`Space`・`Meta`）の監視自体は動いていて、単独で押されたときに `preventDefault` する。** 衝突を避けるには、使わない `*KeyCode` を `null` にする。
- **Chrome では `⌘+` `⌘-` `⌘0`（ページ拡大）はページ側で `preventDefault` して奪える。** 奪えないのはタブ・ウィンドウの開閉と切り替え、終了だけ（Chromium の `IsReservedCommandOrKey`）。

## 1. TanStack Hotkeys の現状

### 安定度と保守

| 項目 | 値 | 出典 |
|---|---|---|
| 安定度 | README 冒頭に「TanStack Hotkeys is alpha. We are actively developing the library」 | [README](https://github.com/TanStack/hotkeys/blob/main/README.md) |
| React 向けパッケージ | `@tanstack/react-hotkeys` 0.13.0（2026-10-04 公開）。コアは `@tanstack/hotkeys` 0.11.0 | [npm](https://www.npmjs.com/package/@tanstack/react-hotkeys) |
| 初版 | 2026-02-10（リポジトリ作成 2026-01-21） | npm レジストリの `time.created`、GitHub API |
| 公開の頻度 | 0.8.0（3 月下旬）から 0.13.0（10 月）まで 12 版。4 月〜9 月中旬は止まっていた | npm レジストリの `time` |
| 破壊的変更 | 0.11.0: `RawHotkey`/`ParsedHotkey` の型が union に、記録の既定が物理キーに。0.12.0: ESM のみ・Node 20 以上・CommonJS を廃止 | [CHANGELOG](https://github.com/TanStack/hotkeys/blob/main/packages/react-hotkeys/CHANGELOG.md) |
| 依存 | `@tanstack/hotkeys`、`@tanstack/react-store`（→ `@tanstack/store`、`use-sync-external-store`）。peer は `react >=16.8` | npm レジストリ、`npm ls` |
| 大きさ | 下の「大きさの比較」 | |
| GitHub | star 737、open issue 14、最終 push 2026-10-04、archived でない | GitHub API |
| 週間 DL | `@tanstack/react-hotkeys` 約 112 万 | npm downloads API |

### API（React）

`useHotkey`（1 つ）、`useHotkeys`（配列で複数）、`useHotkeySequence(s)`（連続キー）、`useHotkeyRegistrations`（登録一覧）、`useHeldKeys`・`useKeyHold`（押しているキー）、`useHotkeyRecorder`（キーの割り当てを記録）、`HotkeysProvider`（既定の上書き）、`formatForDisplay`（表示用の文字列）。出典: [Hotkeys Guide](https://github.com/TanStack/hotkeys/blob/main/docs/framework/react/guides/hotkeys.md)、`packages/react-hotkeys/src/`。

```tsx
import { useHotkey } from '@tanstack/react-hotkeys'
useHotkey('Mod+S', (event, context) => save(), { meta: { name: 'Save', group: 'File' } })
```

### キーの書き方

- 修飾キー: `Mod+Shift+S` のような文字列、または `{ key: 'S', mod: true, shift: true }`。型で補完が効く（[Overview](https://github.com/TanStack/hotkeys/blob/main/docs/overview.md)）。
- `Mod`: 「macOS では Command、Windows/Linux では Control」（同）。
- 論理キーと物理キー: `Mod+S` は `event.key`（配列に従う）、`Mod+[KeyS]` は `event.code`（位置）。`=`・`-`・`+` などの記号キーも扱える（`packages/hotkeys/src/constants.ts` の `PUNCTUATION_KEYS`）。
- 連続キー: `useHotkeySequence(['G', 'G'], cb, { timeout: 1000 })`。既定の間隔は 1000 ms。修飾キーだけの押下・IME 変換中・キーの自動反復では進まない（[Sequences Guide](https://github.com/TanStack/hotkeys/blob/main/docs/framework/react/guides/sequences.md)、`sequence-manager.ts`）。

### スコープ（要素に限る・入力欄で無効にする）

- 要素に限る: `target` に DOM 要素か React の ref を渡すと、その要素に届いたイベントだけを見る。既定は `document`。ref の要素は `tabIndex` で focus を取れる必要がある（Hotkeys Guide の `target`）。
- 入力欄: `ignoreInputs`。未指定のときの既定が「賢い既定」で、`Ctrl`/`Meta` 付きと `Escape` は入力欄でも効き、単独キーと `Shift`/`Alt` 付きは input・textarea・select・contentEditable では効かない。`true`/`false` で明示もできる（同 `ignoreInputs`）。
- 有効・無効: `enabled`。無効にしても登録は残り、実行だけ止まる。
- 名前つきのスコープ（react-hotkeys-hook の `scopes` のようなもの）は無い。`meta.group` は説明用で、実行範囲は変えないと明記（同 Metadata）。まとめて止めるのは `enabled` に同じ状態を渡す形になる。
- 既定で `preventDefault: true`、`stopPropagation: true`。同じキーを二重に登録すると `conflictBehavior: 'warn'` で警告。

### 押しっぱなし

- 単発のキーは、キーの自動反復（keydown の repeat）でも繰り返し発火する。`requireReset: true` で「離して押し直すまで 1 回」にできる（Hotkeys Guide の `requireReset`、`hotkey-manager.ts`）。
- `eventType: 'keyup'` で離したときに発火。
- 押している間だけの操作（例: Space を押している間ドラッグで移動）は `useKeyHold('Space')` で真偽を取れる。再描画はそのキーの状態が変わったときだけ（[Key State Tracking Guide](https://github.com/TanStack/hotkeys/blob/main/docs/framework/react/guides/key-state-tracking.md)）。

### キー一覧の出力（ヘルプ表示）

`useHotkeyRegistrations()` が今登録中の `hotkeys` と `sequences` を返す。各要素に、キーの文字列・`options.meta`（`name`・`description`・`group`、宣言のマージで項目を足せる）・有効状態が入る。無効の登録も一覧に残り、アンマウントで消える。`formatForDisplay('Mod+S')` は macOS で `⌘ S` を返す。ヘルプ画面を、別のアクション表を持たずに組める作り（Hotkeys Guide の Introspecting registrations、Overview の Display shortcuts）。

## 2. 比べる候補

| | `@tanstack/react-hotkeys` | `react-hotkeys-hook` | `tinykeys` | `hotkeys-js` |
|---|---|---|---|---|
| 最新版 | 0.13.0（alpha） | 5.3.3（2026-06-26） | 4.0.1 | 4.0.8 |
| React 向けか | フック | フック | 素の JS（フックは自前） | 素の JS |
| 実行時の依存 | 3 パッケージ（TanStack Store ほか） | なし | なし | なし |
| min+gzip（下記の方法で計測） | 約 10.7 KB | 約 2.9 KB | 未計測 | 未計測 |
| 週間 DL | 約 112 万 | 約 586 万 | 約 37 万 | 約 171 万 |
| GitHub star / open issue | 737 / 14 | 3,506 / 49 | 4,100 / 6 | 未確認 |
| 最終 push | 2026-10-04 | 2026-10-05 | 2026-09-25 | — |

出典: npm レジストリ（`registry.npmjs.org/<pkg>`）、npm downloads API（`api.npmjs.org/downloads/point/last-week/<pkg>`）、GitHub API（`repos/<owner>/<repo>`）。大きさは、上 2 つを npm から入れて esbuild で `--bundle --minify --format=esm`（react・react-dom は external）にし、gzip したバイト数。TanStack 側は `useHotkey`・`useHotkeys`・`useHotkeySequence`・`useHotkeyRegistrations`・`formatForDisplay` を、react-hotkeys-hook 側は `useHotkeys`・`HotkeysProvider` を import した。

### react-hotkeys-hook 5.x の要点

出典: [API: useHotkeys](https://github.com/JohannesKlauss/react-hotkeys-hook/blob/main/packages/documentation/docs/api/use-hotkeys.mdx)、[Grouping Hotkeys](https://github.com/JohannesKlauss/react-hotkeys-hook/blob/main/packages/documentation/docs/documentation/hotkeys-provider.mdx)、[Scoping hotkeys](https://github.com/JohannesKlauss/react-hotkeys-hook/blob/main/packages/documentation/docs/documentation/useHotkeys/scoping-hotkeys.mdx)、`packages/react-hotkeys-hook/src/lib/`。

- 書き方: `'ctrl+s, shift+w'` や配列。`mod` は macOS で meta、他で ctrl（`validators.ts`）。連続キーは `'g>h>i'`（`sequenceSplitKey`、既定の間隔 `sequenceTimeoutMs: 1000`）。
- 入力欄: 既定で無効（`enableOnFormTags: false`、`enableOnContentEditable: false`）。修飾キーの有無で既定を変える仕組みは無い。
- 要素に限る: `useHotkeys` が返す ref を focus できる要素に付ける。名前つきの `scopes` を `HotkeysProvider` と `useHotkeysContext()` の `enableScope`/`disableScope` で切り替えられる。
- 既定は `preventDefault: false`（TanStack と逆）。
- 押しっぱなし: `keyup`/`keydown` を選べる。`isHotkeyPressed()` で押下中かを取れる。自動反復を抑えるオプションは文書に無い（必要なら `event.repeat` を自分で見る）。
- キー一覧: `HotkeysProvider` の中で `useHotkeysContext().hotkeys` が登録中の一覧を持つ。`description` と `metadata` を付けられる。`⌘` などの表示整形は無い。
- コールバックはメモ化され、参照する値は依存配列に書く必要がある（TanStack は毎描画で同期するので不要）。

`tinykeys` と `hotkeys-js` は React のフックでなく、入力欄の扱い・一覧・解除をこちらで書くことになるので、細かくは見ていない。

## 3. React Flow 自身のキー操作との重なり

出典: `@xyflow/react` 12.12.0 のソース（[xyflow/xyflow](https://github.com/xyflow/xyflow) の `packages/react/src/`）。

### 既定のキー

| prop | 既定 | 役 | 監視する先 |
|---|---|---|---|
| `deleteKeyCode` | `'Backspace'` | 選んだノード・エッジを消す | document |
| `selectionKeyCode` | `'Shift'` | 押している間ドラッグで範囲選択 | window |
| `multiSelectionKeyCode` | macOS `'Meta'`、他 `'Control'` | 押している間クリックで複数選択 | window |
| `panActivationKeyCode` | `'Space'` | 押している間、`panOnDrag` が false でもドラッグで移動 | window |
| `zoomActivationKeyCode` | macOS `'Meta'`、他 `'Control'` | 押している間、ホイールで拡大縮小 | document |
| `disableKeyboardA11y` | `false` | ノードに focus があるとき Enter/Space で選択、Escape で解除、矢印で移動 | ノード要素の onKeyDown |

（`types/component-props.ts`、`container/ReactFlow/index.tsx`、`container/FlowRenderer/index.tsx`、`container/ZoomPane/index.tsx`、`hooks/useGlobalKeyHandler.ts`、`components/NodeWrapper/index.tsx`）

### 今の `web/src/MapView.tsx` での状態

`nodesFocusable={false}`・`elementsSelectable={false}`・`nodesDraggable={false}`・`panOnDrag={false}`・`zoomOnScroll={false}` などで操作は止めてあるが、`*KeyCode` は 1 つも渡していないので、上の 5 つの監視は既定のキーで動いている。

- `useKeyPress`（`hooks/useKeyPress.ts`）は、指定のキーが一致すると、入力欄（input・select・textarea・contenteditable・`.nokey` の中）でなく、修飾キー付きか button/a 以外が target のとき `event.preventDefault()` を呼ぶ。つまり今も `Backspace`・`Shift`・`Space`・`Meta` を単独で押すと既定の動作が止まる。
- 一致の判定は「押しているキーの数が定義と同じ」ものだけ（`isMatchingKey`）。`Meta` 単独の定義は `⌘+=` には一致しないので、ページ拡大などの組み合わせは邪魔しない。
- `nodesFocusable={false}` なので、ノードの onKeyDown（矢印・Enter・Escape）は付かない。#153 の「キーでのノード選択」で focus を有効にすると、これが動き出す。

### 止め方

- 使わない役のキーは prop に `null` を渡すと監視しない（`if (keyCode !== null)` のときだけ addEventListener）。`deleteKeyCode={null}` などを全部 `null` にすれば、React Flow はキーを一切見ない。
- ノードのキー操作は `disableKeyboardA11y` か `nodesFocusable={false}` で止まる。
- 部分的に止めるなら、要素に `nokey` クラスを付けると、その中で起きたキーを React Flow の `useKeyPress` とノードの onKeyDown は無視する（`@xyflow/system` の `isInputDOMNode`。クラス名は固定で、変える prop は無い）。
- 自前で範囲選択や Space で移動を持つなら、React Flow 側のキーを `null` にして、ライブラリ側で `useKeyHold` などから React Flow の `panOnDrag` 等の prop を切り替える形にすれば、二重に処理しない。

### イベントの伝わり方の注意

TanStack Hotkeys の既定は `stopPropagation: true` で、登録先の既定は `document`。React Flow の `selectionKeyCode`・`panActivationKeyCode`・`multiSelectionKeyCode` は `window` で聞いているので、同じキーを TanStack で document に登録すると、React Flow の window の監視には届かなくなる（document → window の順に伝わるため）。同じ document に付いた監視同士は `stopPropagation` では止まらない。

## 4. ブラウザと会議アプリの画面共有での注意

### ブラウザ既定のキーを奪えるか

Chromium の `BrowserCommandController::IsReservedCommandOrKey`（[browser_command_controller.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/browser_command_controller.cc)）が、ページに渡さず先にブラウザが取るコマンドを決めている。

- 予約されているのは、タブを閉じる・ウィンドウを閉じる・新しいタブ/ウィンドウ/シークレットウィンドウ・閉じたタブを戻す・次/前のタブへ・タブの巡回・終了だけ（`⌘W` `⌘T` `⌘N` `⌘⇧T` `⌘Q` など）。これらはページで `preventDefault` しても止まらない。
- 拡大（`⌘+` `⌘-` `⌘0`）・保存（`⌘S`）・検索（`⌘F`）・再読み込みなどは予約されておらず、ページの keydown で `preventDefault` すればブラウザの動作は起きない。
- 全画面表示のときは、全画面の解除と終了以外がすべてページに渡る（macOS でツールバーが出ている全画面を除く）。

Safari と Firefox は今回確かめていない。

### 奪ってよいか

- `⌘+` `⌘-` `⌘0` を奪うと、見ている人がページ全体の文字を大きくする手段（ブラウザの拡大）を失う。画面共有では、発表者がブラウザの拡大でマップを大きく見せる使い方もありうる。マップの拡大縮小に割り当てるなら、ブラウザの拡大の代わりになるか（文字も含めて大きくなるか）を決める必要がある。
- 単独の文字キー（修飾キーなし）のショートカットは、WCAG 2.1 達成基準 2.1.4 Character Key Shortcuts で「無効にできる」「割り当てを変えられる」「その部品に focus があるときだけ効く」のどれかを求められている（[Understanding SC 2.1.4](https://www.w3.org/WAI/WCAG21/Understanding/character-key-shortcuts.html)）。TanStack の `target`（要素に限る）や react-hotkeys-hook の ref がこの 3 つ目に当たる。
- キーのイベントは focus のあるウィンドウにしか届かない。会議アプリ（別アプリ、または別タブの Meet など）に focus があるときは、このページのショートカットは効かない。会議アプリがシステム全体のショートカット（Zoom の「グローバルショートカット」など）を持っている場合はそちらが先に取る可能性があるが、各アプリの仕様は今回確かめていない。

## 推奨

TanStack Hotkeys を使う（利用者の決定と合う）。理由は、#153 で要る「押している間」（`useKeyHold`）・ヘルプ表示（`useHotkeyRegistrations` と `formatForDisplay`）・入力欄の扱いの賢い既定・`Mod` の表示が組み込みで、自前で書く部分が react-hotkeys-hook より少ないこと。条件は次のとおり。

- alpha で 0.x の minor に破壊的変更が入るので、`@tanstack/react-hotkeys` を exact-pin し、上げるときは CHANGELOG を読む。
- React Flow の `*KeyCode` を、使う役以外 `null` にする。Space・Shift・Meta をライブラリ側でも使うなら、どちらか一方だけが処理するように寄せる。
- `⌘+` `⌘-` `⌘0` をマップの拡大縮小に取るかは、奪えることは確かめたので、ブラウザ拡大を失ってよいかという仕様の判断として #153 で決める。

alpha を避けたい場合の代わりは react-hotkeys-hook 5.x（安定版・依存ゼロ・約 2.9 KB）。ヘルプ表示の整形と押下中の状態管理を少し自前で書くことになる。
