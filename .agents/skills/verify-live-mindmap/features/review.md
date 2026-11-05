# 見返し

終わったセッションのフォルダに `cli review <フォルダ>` を流すと、見返し用の `map.html` ができます。開くと、時刻のスライダーやキーでその時点のマップに戻れ、再生して止められ、再生の速さを選べ、字幕と右の列を出し入れできます。server は要りません。

## Sub-features

- `review-build`: `review` が `map.html` のパスを出す（録音が無いので `map-audio.html` は作らない）。
- `review-seek`: スライダー「時刻」のトラックを押すと時刻が動き、左端ではノードがルートだけになる。
- `review-step`: 「反映 1 つ戻る」「反映 1 つ進む」で反映の時刻へ動く。
- `review-play`: 「再生」で時刻が進み、「止める」で止まる。
- `review-rate`: 「再生の速さ」のメニューから速さを選べる（録音なしは 10・30・60・120 倍、最初は 30 倍）。
- `review-panels`: 「字幕」「右の列」のボタンで出し入れできる（PC の幅では最初は出ている）。
- `review-keys`: `Home`・`End` で最初・最後の時点へ、`E`・`C` で右の列・字幕を出し入れ、`?` でキーの一覧を開閉する。

## How to get to it (user POV)

- ターミナルで `cli review <セッションのフォルダ>` を流し、出たパスの `map.html` をブラウザで開く。
- 画面の下のスライダー「時刻」、ボタン「再生」「反映 1 つ戻る」「反映 1 つ進む」「再生の速さ」「字幕」「右の列」と、キーを使う。

## Driving it with browser.sh / cli.sh

Preconditions:

- `bash $S/launch.sh` で立てた run（server は使わないが、`map.html` の配信に web を使う）。
- 手書きのログ `e2e/fixtures/review.log.jsonl`（発言 6 件、ノードを足す反映 3 回、録音なし）。

- **ログを置く.** `SD=$(cat "$RUN/sessions-dir"); mkdir -p "$SD/review"; cp e2e/fixtures/review.log.jsonl "$SD/review/log.jsonl"`。
- **作る.** `bash $S/cli.sh "$RUN" review "$SD/review"`。終了コード 0、標準出力が `.../review/map.html`。
- **開く.** `bash $S/browser.sh "$RUN" open "http://127.0.0.1:$P/session-files/review/map.html"`（開いていれば `goto`）。snapshot に `slider "時刻"`、`button "見返しの確認"`・`button "要点1"`〜`button "要点3"`。`bash $S/browser.sh "$RUN" eval "document.querySelectorAll('.map-node__text').length"` が `4`。
- **スライダー.** `bash $S/browser.sh "$RUN" run-code "async page => { const t = await page.locator('.review-slider-hit').first().boundingBox(); await page.mouse.click(t.x + t.width * 0.5, t.y + t.height / 2); }"`。snapshot の時刻の表示が `0:00:30 / 0:01:00`、同じ `eval` が `2`。`t.width * 0.5` を外して `t.x + 1` にすると `0:00:00 / 0:01:00` で `eval` が `1`。`bash $S/browser.sh "$RUN" screenshot --filename shots/review-home.png`。
- **反映ごと.** `button "反映 1 つ進む"` を `click`。時刻の表示が `0:00:20 / 0:01:00`、`eval` が `2`。
- **速さ.** `button "再生の速さ"` を `click`。snapshot に `menu "再生の速さ"` と `menuitem` が 4 つ。名前が `60 倍` で始まる menuitem（`60 倍（1 分を 0.0 分で）`）を `click` し、ボタンの文言が `60×` になり、メニューが消える。
- **再生と止める.** 同じメニューで `10 倍` を選び、`press Home`、`button "再生"` を `click`。`sleep 1` の後の snapshot に `button "止める"`。それを `click` すると `button "再生"` に戻り、1 秒おいても時刻の表示が変わらない。
- **出し入れ.** `button "字幕"` と `button "右の列"` は最初 `[pressed]`。それぞれ `click` すると `[pressed]` が外れる。もう一度 `click` して戻す。
- **キー.** `press End` で時刻の表示が `0:01:00 / 0:01:00`、`press Home` で `0:00:00 / 0:01:00`。`press e`・`press c` で `button "右の列"`・`button "字幕"` の `[pressed]` が切り替わる。`press ?` で `? このキー一覧を開閉する` の段落が出る。

## Gotchas

- `/session-files/` は確かめ用に `serve.ts` が足した配信で、拡張子 `.html` だけを text/html で返します。`log.jsonl` などは text/plain の本文で見えます。
- `slider "時刻"` は 12px のつまみで、`click` しても今の時刻のまま動きません。`click` の後はフォーカスが `body` に外れるので、続く `press Home` はスライダーではなく全体のキーとして効きます。`review-seek` はトラック（`.review-slider-hit`）を 1 回のマウス操作で押して確かめます。`Home` やボタンで通した結果をスライダーの確認とは報告しません。
- `mousemove`・`mousedown`・`mouseup` を別々のコマンドで流すと、トラックを押しても時刻は狙った値になりません（開いた直後は `0:01:00` のまま動きませんでした）。`run-code` の `page.mouse.click` を使います。
- 「反映 1 つ戻る」は反映の時刻へ動くので、最初の反映（`0:00:20`）より前には戻りません。ノードがルートだけの時点へはスライダーか `Home` で戻ります。
- 60 倍では 1 分のログが 1 秒で終わるので、`button "止める"` を捉えるときは `10 倍` にします。
- スマホの幅（`bash $S/browser.sh "$RUN" resize 390 844` の後に開き直す）では、字幕と右の列を隠して始めます（Issue #1236）。
- 別のセッション名で作るときは、server の ISO 時刻のフォルダ名と重ならない名前にします。
