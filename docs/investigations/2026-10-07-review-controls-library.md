# 見返しの操作に使うコンポーネントライブラリ（Issue #308）

見返し用のマップ（`map.html`。`vite-plugin-singlefile` で 1 ファイルにし、`file://` で開く。#298）で時刻を動かす操作（▶・コマ送り・シークバー・目印・章・速さ・キー操作）を、自作せずライブラリで作るならどれがよいかを調べた（地図は #297）。メディアプレイヤー系（Video.js 10・media-chrome・Vidstack）と汎用の headless 系（Radix UI・Base UI・React Aria Components・Ark UI）を、npm の中身・ソース・公式の文書で確かめ、Vite 8・React 19・`vite-plugin-singlefile` でそれぞれ小さなページをビルドして重さを測り、Chromium 153 の `file://` で開いて触った。結論は次のとおり。

- **勧めるのは Video.js 10 の React 版（`@videojs/react` 10.0.1）。** シークバーに要るもの（ホバーの位置の時刻を出す `Preview`、章の帯 `Chapters`、章の名前 `ChapterTitle`、`aria-valuetext` の読み上げ）がそろっていて、見た目を持たない（素の CSS で描く）。React の部品で Web Components を使わない。足す重さは gzip で **約 19 KB（Slider だけ）〜30 KB（プレイヤーごと）**。`file://` でエラーなく動いた。
  - 音声なしの今は、プレイヤーにつながない汎用の `Slider`（値を外から渡す、公開の API）を使い、時刻は今の試作どおり自前の状態で持つ。目印と章の帯は `Slider.Track` の中に自前の要素で置き、ホバーの `Slider.Value` の `format` で時刻と議題の名前を出す。
  - 音声を付けるときは、同じ部品のまま `TimeSlider`（`<audio>` 1 つにつながる）へ移せる。章は `<track kind="chapters">`（Blob URL の VTT）から帯と名前を描く。`file://` で、Blob URL の `<audio>` の再生・シーク・章 3 つの描画・ホバーの章の名前まで確かめた。
  - ▶・コマ送り・速さは、素の `<button>`・`<select>` と今のキー操作のままにする（Video.js の `PlayButton` などはプレイヤーにつながないと使えず、速さの候補も 0.2〜2 倍に固定されている）。
- **次点は Radix UI の Slider（`radix-ui` 1.7.0）。** MIT・最も軽い（Slider だけで gzip 約 9 KB）・長く使われている。ただしホバーの時刻表示・章・目印は無く、自前で書く（ポインターの位置から時刻を出す 20〜30 行と、目印の配置）。Video.js 10 が出たばかり（10.0.0 が 2026-10-01）であることを嫌うなら、こちらにする。
- **Vidstack は使わない。** README で「Video.js 10 に移る。2028 年 1 月までセキュリティ修正だけ」と宣言されている。media-chrome も README で新しく始めるなら Video.js を勧めており、Web Components（Shadow DOM・既定のテーマつき）で gzip 約 44 KB と重い。
- **どのライブラリでも、矢印キーはシークバーにフォーカスがあるときだけ効き、`[ ]` は奪わない。** 試作のように、操作の後でフォーカスを外せば、矢印はノードの選択に残る。
- 要る手間: 試作のシークバー（`web/src/prototype-review/`）を `Slider` に置き換えるのは半日ほど。Video.js は Apache-2.0 なので、`map.html` にライセンスの文面を残す仕組み（ビルドで注記を足す）が要る。版は固定（exact pin）にする。

## 調べ方

- 版: `@videojs/react` 10.0.1、`media-chrome` 4.19.3、`@vidstack/react` 1.15.7、`radix-ui` 1.7.0、`@base-ui/react` 1.8.0、`react-aria-components` 1.21.1、`@ark-ui/react` 5.39.3。npm のレジストリ（`npm view`）で版・公開日・ライセンス・依存を、GitHub の API でリポジトリの状態を見た（2026-10-07）。
- ソース: Video.js 10 は GitHub の `videojs/v10` を取得して、React の部品（`packages/react/src/ui/`）・スライダーのキー処理（`packages/core/src/dom/ui/slider/slider.ts`）・ホットキー（`packages/core/src/dom/hotkey/coordinator.ts`）・公式の文書の原稿（`site/src/content/docs/`）を読んだ。他のライブラリは npm から入れた `node_modules` の中身を読んだ。
- ビルド: リポジトリの外のスクラッチの場所に Vite 8.3.3・`@vitejs/plugin-react` 6.1.2・`vite-plugin-singlefile` 2.3.3・React 19.3.0 を入れ、ライブラリごとに「▶・シークバー（目印 5 つ）・時刻・速さの選択」だけのページを作って single-file でビルドした。リポジトリに依存は足していない。
- 開いて確かめる: Playwright 1.63 の Chromium 153（ヘッドレス）で `file://` から開き、コンソールのエラー・失敗した読み込み・`role="slider"` の属性・キー操作（フォーカスして `←`・`[`・`End`）・ホバーのプレビューを見た。音声は、ページの中で 300 秒の無音の WAV を作って Blob URL にし、`<audio>` 1 つで鳴らした（#299 の決定と同じ置き方。章は VTT を Blob URL にした `<track kind="chapters">`）。
- Firefox・Safari、読み上げソフトでの実際の読み上げは確かめていない。

## 1. 候補の状態とライセンス

| ライブラリ | 版（公開日） | ライセンス | 状態 |
|---|---|---|---|
| Video.js 10（`@videojs/react`） | 10.0.1（2026-10-02）。10.0.0 が 2026-10-01 | Apache-2.0 | Vidstack・Plyr・Media Chrome・Video.js の人たちがここに集まった。GitHub `videojs/v10` は毎日更新 |
| media-chrome（`media-chrome/react`） | 4.19.3（2026-09-28） | MIT | 更新は続いている。README の冒頭で「新しく始めるなら Video.js を」と案内 |
| Vidstack（`@vidstack/react`） | 1.15.7（2026-10-06） | MIT | **非推奨。** リポジトリの説明が「Deprecated in favour of Video.js 10; security fixes only until January 2028」 |
| Radix UI（`radix-ui`） | 1.7.0（2026-10-05。`@radix-ui/react-slider` 1.5.0） | MIT | `radix-ui/primitives` は毎日更新 |
| Base UI（`@base-ui/react`） | 1.8.0（2026-09-04） | MIT | `mui/base-ui` は毎日更新。旧名 `@base-ui-components/react` は 1.0.0-rc.0 で止まっている |
| React Aria Components | 1.21.1（2026-09-04） | Apache-2.0 | `adobe/react-spectrum` は毎日更新 |
| Ark UI（`@ark-ui/react`） | 5.39.3（2026-10-05） | MIT | `chakra-ui/ark` は毎日更新。中身は Zag.js |

- どれも peerDependencies に React 19 を含み、Vite 8（Rolldown）で警告なくビルドできた（Video.js だけ、依存の `react-compiler-runtime` の `"use no memo"` について Rolldown が「保てないかもしれない」と出したが、動作には影響しなかった）。
- **ライセンス（ADR 0004）:** MIT のものはそのまま使える。Apache-2.0（Video.js 10・React Aria）も MIT のプロジェクトの依存として両立する。ただし `map.html` はライブラリをまるごと中に入れて人に渡すものなので、再配布にあたり Apache-2.0 の第 4 条（ライセンスの写しを付ける）を満たす必要がある。今回のビルドでは、どのライブラリでも `@license` などの注記は残っていなかった（MIT の React も同じ）。ビルドでライセンスの文面を HTML のコメントに足す手順を作れば、MIT・Apache-2.0 のどちらにも足りる。`videojs/v10` に NOTICE ファイルは無い。

## 2. 重さ（1 ファイルの HTML、Chromium で開いたもの）

基準は「React だけで、素の `<input type="range">`・`<button>`・`<select>` で作ったページ」（221,284 バイト・gzip 68,505 バイト）。差がライブラリの分。gzip は `gzip -9`。

| ページ | 素のまま | gzip | 基準との差（素のまま / gzip） |
|---|---|---|---|
| 基準（React だけ） | 221,284 | 68,505 | — |
| Radix: Slider だけ | 248,837 | 77,944 | +27.6 KB / **+9.4 KB** |
| Base UI: Slider だけ | 254,618 | 80,926 | +33.3 KB / +12.4 KB |
| React Aria: Slider だけ | 264,754 | 82,945 | +43.5 KB / +14.4 KB |
| Ark UI: Slider だけ | 266,322 | 83,704 | +45.0 KB / +15.2 KB |
| **Video.js 10: 汎用の Slider だけ**（プレイヤーなし、ホバーのプレビューつき） | 278,365 | 87,110 | +57.1 KB / **+18.6 KB** |
| **Video.js 10: プレイヤー + `<audio>` + TimeSlider（章・プレビュー）+ PlayButton・速さ・Hotkey** | 311,508 | 98,588 | +90.2 KB / **+30.1 KB** |
| Video.js 10: 同じ部品を自前の時計（音声なし）につないだもの | 311,103 | 98,309 | +89.8 KB / +29.8 KB |
| Radix: Slider + Toggle + Select | 319,653 | 101,653 | +98.4 KB / +33.1 KB |
| Ark UI: Slider + Toggle + Select | 356,986 | 112,018 | +135.7 KB / +43.5 KB |
| Base UI: Slider + Toggle + Select | 358,792 | 116,906 | +137.5 KB / +48.4 KB |
| React Aria: Slider + ToggleButton + Select | 420,364 | 132,105 | +199.1 KB / +63.6 KB |
| media-chrome: `<audio>` + TimeRange（章・プレビュー）+ Play・速さ | 408,057 | 112,032 | +186.8 KB / +43.5 KB |
| Vidstack: `<audio>` + TimeSlider（章・プレビュー）+ Play | 536,035 | 165,958 | +314.8 KB / +97.5 KB |

（KB は 1,000 バイト。各ページには試験用の共通コード（時計・無音の WAV を作る処理）が同じだけ入っている。）

- 汎用の系統は、Select（浮かぶ一覧）を足すと位置合わせの部品（Floating UI など）が入って 20〜50 KB 増える。速さの選択は候補が 3〜4 つなので、素の `<select>` で足りる。
- 今の画面は 1 ファイルで約 0.41 MB（#298）、ログが 0.32 MB。Video.js を入れても 0.06〜0.09 MB 増えるだけで、音声（16〜32 kbps で 20〜41 MB、#299）と比べれば無視できる。

## 3. 求めることへの対応

| | Video.js 10 | media-chrome | Radix | Base UI | React Aria | Ark UI |
|---|---|---|---|---|---|---|
| 目印（点） | 無い。Track の中に自前で置く | 無い | 無い。自前 | 無い。自前 | 無い。自前 | **ある**（`Slider.MarkerGroup`・`Marker`） |
| 章（帯） | **ある**（`TimeSlider.Chapters`。VTT の章の cue から。各帯の位置・進みを CSS 変数で渡す） | **ある**（`<track kind="chapters">` から） | 無い | 無い | 無い | 無い |
| ホバーで時刻・名前 | **ある**（`Preview` + `Value type="pointer"`、`ChapterTitle`。汎用の Slider でも `Preview` は使え、`format` で名前も出せる） | **ある**（`media-preview-time-display`・`media-preview-chapter-display`） | 無い | 無い | 無い | 無い |
| 音声なしで使う | 汎用の `Slider`（値を外から渡す）は公開の API。プレイヤーの部品を音声なしで動かすには自前の media をつなぐが、その口（`useMediaAttach`）は `@internal` | 自前の media 要素（HTMLMediaElement と同じ API を持つカスタム要素）を差し込めると文書にある | 値を外から渡すだけ。音声の有無は関係ない | 同左 | 同左 | 同左 |
| `<audio>` 1 つに合わせる | `<Audio>` をそのまま入れればつながる | `<audio slot="media">` でつながる | 自前で `timeupdate` を拾って値にし、変更を `currentTime` に書く | 同左 | 同左 | 同左 |
| 見た目 | 持たない。データ属性と CSS 変数で描く | 既定のテーマあり（Shadow DOM の中。CSS 変数と `::part` で変える） | 持たない | 持たない | 持たない | 持たない |
| 作り | React の部品（Web Components は使わない） | Web Components を React で包んだもの | React | React | React | React（中は Zag.js の状態機械） |

### Video.js 10 を詳しく

- **汎用の Slider**（`Slider.Root`・`Track`・`Fill`・`Thumb`・`Preview`・`Value`）は、プレイヤーの外で `value` と `onValueChange` で使える（公式の文書の「Slider」と、その例 `WithPreview`）。`Value` の `format` で表示を変えられる（`packages/react/src/ui/slider/value.tsx`）。試したページでは `role="slider"`・`aria-label`・`aria-valuenow` が付き、ホバーで `Preview` が位置の値を出した。`aria-valuetext` は自動では付かない（`label` と値だけ）。
- **TimeSlider** は `TimeSlider.Chapters` の `renderChapter` で章ごとの要素を描く。章の境目・幅・その章の中の進みは `--media-slider-chapter-start`・`-end`・`-width`・`-fill` の CSS 変数で渡され、章の cue が無い区間も帯として埋まる（文書の「TimeSlider」）。章は `kind="chapters"` の text track から読むので、プレイヤーの機能に `textTrackFeature` を足す必要がある（音声の既定の組 `audioFeatures` には入っていない: `packages/core/src/dom/store/features/presets.ts`）。足さないと章は 1 本の帯になった。足した後は、章 3 つの帯が描かれ、ホバーで「議題 2」と「2:31」が出た。`aria-valuetext` は「30 seconds of 5 minutes」のように英語で付く（翻訳の仕組みあり）。
- **音声なしでプレイヤーの部品を動かす試し:** プレイヤーの機能は、つないだ相手が `currentTime`・`duration`・`seeking` などを持つか（`isMediaSeekCapable` など）と、`timeupdate` などのイベントだけを見る（`packages/media/src/core/predicate.ts`、`packages/core/src/dom/store/features/time.ts`）。そこで「時刻だけを持つ `EventTarget`」を作ってつなぐと、`PlayButton`（▶ と ❚❚ の切り替え、`aria-label` も Play/Pause に変わる）・`TimeSlider`（`aria-valuenow` が進む、`End` で最後へ）がそのまま動いた。ただしつなぐ口の `useMediaAttach` は `@internal`（`packages/react/src/player/context.tsx`）で、文書に無い。**勧めない。** 音声なしの間は汎用の `Slider` を使う。
- **速さ:** `PlaybackRateButton` は押すたびに候補を巡るが、候補は機能の既定（0.2・0.5・0.7・1・1.2・1.5・1.7・2）に固定で、部品の props では変えられない（`packages/core/src/dom/store/features/playback-rate.ts`）。音声なしの「30 倍」のような速さには合わないので、素の `<select>` にする。
- **ホットキー:** `Hotkey` はプレイヤーのコンテナの中にフォーカスがあるときだけ効く（`target="document"` でページ全体にもできる）。入力欄にフォーカスがあると 1 文字のキーは飛ばし、IME の変換中（`key === "Unidentified"`）も飛ばす（文書の「Add keyboard shortcuts and gestures」、`coordinator.ts`）。スライダーにフォーカスがあるときの Space は、スライダーの操作として扱われて ▶ に渡らなかった。見返しの画面は試作ですでに画面全体のキー（Space・`[ ]`・Home/End）を自前で持っているので、`Hotkey` は使わず今の処理を残すほうが、ライブの画面とも食い違わない。

### media-chrome

- `<media-time-range>` は章（`kind="chapters"`）とホバーの時刻・章の名前を出せた（ホバーで「議題 2」「2:30」）。`<media-controller hotkeys="noarrowleft noarrowright">` で、コンテナの矢印のショートカットを切れる（`dist/media-controller.js` の `keyboardShortcutHandler`）。フォーカスしたシークバーの矢印は、中の `<input type="range">` の操作として効く。
- 音声なしでは、HTMLMediaElement と同じ API を持つカスタム要素を作って `slot="media"` に入れる。▶ だけなら `play()`・`pause()`・`paused` と `play`・`playing`・`pause` のイベントがあればよい、と文書にある（[Media element](https://www.media-chrome.org/docs/en/media-element)）。
- 部品は Web Components（ビルドの中で `customElements.define` が 32 回、`attachShadow` が 11 回）で、既定の見た目（半透明の黒い背景など）が Shadow DOM の中にある。控えめに描き直すには CSS 変数と `::part` で外から上書きしていくことになる。README で Video.js への移行を案内しており、今から選ぶ理由は薄い。

### 汎用の headless 系（Radix・Base UI・React Aria・Ark UI）

- どれも WAI-ARIA の slider のキー（`←` `→` `↑` `↓` で 1 段、`PageUp`/`PageDown` と Shift＋矢印で大きく、`Home`/`End` で端）をスライダーにフォーカスがあるときだけ処理する（Radix の `dist/index.mjs`、Zag の `slider.connect.mjs` など）。値は外から渡す形で、試したページはすべて `file://` でエラーなく動き、`←` で 300 → 299、`[` では動かなかった。
- 目印を部品として持つのは Ark UI だけ（`Slider.Marker`）。それ以外は Track の中に絶対配置の要素を自前で置く（試したページはそれで描けた）。ホバーの時刻表示・章の帯はどれにも無い。
- `aria-valuetext` は Radix は Thumb に直接、Base UI と Ark UI は `getAriaValueText` で、時刻の文字（「5:00」）にできた。React Aria は既定で数値（「300」）で、`formatOptions` で数の書式を変える形。
- 音声を付けたら、`<audio>` の `timeupdate` で値を更新し、`onValueChange` で `currentTime` に書く同期を自前で書く（十数行）。

## 4. ライブの画面のキーとぶつからないか

- ライブ・試作のキー: 矢印はノードの選択、Shift＋矢印はカメラの移動、`[ ]` はコマ送り、Space は ▶、Home/End は端へ（試作 `web/src/prototype-review/main.tsx` の `keydown` の処理）。
- どのライブラリも、矢印・Home/End は**スライダーにフォーカスがあるときだけ**処理し、`[ ]` は使わない。試作は「バーを操作したらフォーカスを外す」ので、普段は矢印がノードの選択に残る。スライダーにフォーカスがある間に矢印で時刻を動かせることは、読み上げ・キーボードだけで使う人のために残すのがよい。
- スライダーのキーを変える口: Video.js の汎用 Slider は `step`・`largeStep` で刻み（1 段・大きい段）を変えられる。キー自体を外すには `onKeyDown` で `preventDefault` するか、`Thumb` を `tabIndex={-1}` にする（Radix は `Slider.Root` に渡した `onKeyDown` で `preventDefault` すると、中のキー処理も止まる。`composeEventHandlers` の作り）。
- プレイヤーの部品のホットキー（Video.js の `Hotkey`、media-chrome の `hotkeys`）は、使わないか、矢印を外して使う。

## 5. 勧める作り方と手間

1. `web` に `@videojs/react` を exact pin で足す（`effect` と同じく、出たばかりの版なので上げるときに変更を確かめる）。
2. 試作のシークバーを `Slider.Root`（`min=0`・`max=会議の長さ`・`value=今の時刻`・`onValueChange`）に置き換える。`Slider.Track` の中に、議題の始まり・決定・TODO の目印と、議題ごとの帯を自前の要素で置く。`Slider.Preview` + `Slider.Value type="pointer"` の `format` で「12:34 議題の名前」を出す。`aria-valuetext` は自前で付ける。
3. ▶・−1／+1・速さは素の `<button>`・`<select>` のまま。キー操作は今の自前の処理のまま。
4. `map.html` のビルドに、入れたライブラリのライセンスの文面を HTML のコメントで足す手順を加える（Apache-2.0 の第 4 条のため。React など MIT のものもまとめて）。
5. 音声を付けるとき: `createPlayer({ features: [...audioFeatures, textTrackFeature] })` のプレイヤーに `<Audio src={Blob URL}>` と、議題から作った章の VTT（Blob URL の `<track kind="chapters">`）を入れ、シークバーを `TimeSlider` に替える（部品の名前と CSS 変数は同じ系統なので、見た目の CSS はほぼそのまま使える）。▶ は `PlayButton` に替えられる。マップの時刻は `usePlayer` で `currentTime` を読んで決める。

手間は、2〜3 が半日ほど、4 が 1 時間ほど。音声の版（5）は #299 の音声の埋め込みができてからで、部品の差し替えは半日ほど。

次点の Radix にする場合は、2 の `Slider` を `radix-ui` の Slider にし、ホバーの時刻表示（`pointermove` の位置を時刻にして要素を動かす）を自前で書く。音声のときは `<audio>` との同期も自前で書く。

## 6. 試した条件と、確かめていないもの

- 計測は各 1 回。サイズは決定的。開いて確かめたのは Chromium 153（ヘッドレス、macOS）だけ。Firefox・Safari の `file://` は確かめていない。
- `file://` の Blob URL の `<audio>` では、Video.js・media-chrome の両方で、同じ Blob URL の読み込みが `net::ERR_ABORTED` と 2〜3 回記録された。再生・シークはできており、メディアの読み込みを途中で打ち切る普通の動きと見ているが、理由は追っていない。
- Vidstack のページは、Blob URL の音声を `MediaPlayer` に渡しても `<audio>` が作られず、時刻が 0 のままだった（非推奨なので追っていない）。
- 読み上げソフト（VoiceOver など）での実際の読み上げは聞いていない。確かめたのは `role`・`aria-*` の属性だけ。
- 161 分の実データ（目印・章が数百ある場合）で描く速さ、タッチ操作、日本語入力がオンのときのスライダーのキーは試していない。
- 試作の画面そのものには組み込んでいない（ライブラリごとの小さなページだけ）。

## 出典

- Video.js 10: [videojs/v10](https://github.com/videojs/v10)（`LICENSE` は Apache-2.0）。読んだもの: `packages/react/src/ui/slider/`・`ui/time-slider/`（`root.tsx`・`chapters.tsx`・`segments.tsx`）、`packages/react/src/player/context.tsx`（`useMediaAttach` の `@internal`）、`packages/core/src/dom/ui/slider/slider.ts`（キー処理）、`packages/core/src/dom/hotkey/coordinator.ts`、`packages/core/src/dom/store/features/`（`presets.ts`・`time.ts`・`playback-rate.ts`）、`packages/media/src/core/predicate.ts`、文書の原稿 `site/src/content/docs/`（`reference/components/slider.mdx`・`time-slider.mdx`、`guides/keyboard-shortcuts.mdx`・`ui-components.mdx`・`architecture.mdx`・`migrate-from-vidstack.mdx`）。公開版は [videojs.org](https://videojs.org)
- Vidstack: [vidstack/player](https://github.com/vidstack/player) の README とリポジトリの説明（非推奨・2028 年 1 月までセキュリティ修正のみ）
- media-chrome: [muxinc/media-chrome](https://github.com/muxinc/media-chrome) の README、[Media element](https://www.media-chrome.org/docs/en/media-element)、npm 4.19.3 の `dist/media-controller.js`・`dist/media-chrome-range.js`
- Radix UI: [radix-ui/primitives](https://github.com/radix-ui/primitives)、[Slider](https://www.radix-ui.com/primitives/docs/components/slider)、npm `@radix-ui/react-slider` 1.5.0 の `dist/index.mjs`
- Base UI: [mui/base-ui](https://github.com/mui/base-ui)、[Slider](https://base-ui.com/react/components/slider)、npm `@base-ui/react` 1.8.0
- React Aria Components: [adobe/react-spectrum](https://github.com/adobe/react-spectrum)、[Slider](https://react-spectrum.adobe.com/react-aria/Slider.html)
- Ark UI: [chakra-ui/ark](https://github.com/chakra-ui/ark)、[Slider](https://ark-ui.com/docs/components/slider)、npm `@ark-ui/react` 5.39.3（`Slider.MarkerGroup`・`Marker`）と `@zag-js/slider` 1.45.0 の `slider.connect.mjs`
- Apache License 2.0 の再配布の条件: [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0)（第 4 条）
- このリポジトリ: `docs/adr/0004-mit-license-no-monetization.md`、`web/package.json`、`prototype/review-controls` の `web/src/prototype-review/main.tsx`（キー操作）、`docs/investigations/2026-10-07-review-html-single-file.md`（#298、`research/review-html-single-file`）・`2026-10-07-review-html-audio.md`（#299、`research/review-html-audio`）
