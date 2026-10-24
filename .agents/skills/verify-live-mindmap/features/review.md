# 見返し

終わったセッションのフォルダに `cli review <フォルダ>` を流すと、見返し用の `map.html` ができます。開くと、時刻のスライダーでその時点のマップに戻れ、再生の速さを選べ、字幕と右の列を出し入れできます。server は要りません。

## Sub-features

- `review-build`: `review` が `map.html` のパスを出す（録音が無いので `map-audio.html` は作らない）。
- `review-seek`: スライダー「時刻」を先頭へ動かすと、ノードがルートだけになる。
- `review-rate`: 「再生の速さ」のメニューから速さを選べる（録音なしは 10・30・60・120 倍、最初は 30 倍）。
- `review-panels`: 「字幕」「右の列」のボタンで出し入れできる（PC の幅では最初は出ている）。

## How to get to it (user POV)

- ターミナルで `cli review <セッションのフォルダ>` を流し、出たパスの `map.html` をブラウザで開く。
- 画面の下のスライダー「時刻」、ボタン「再生の速さ」「字幕」「右の列」を使う。

## Driving it with browser.sh / cli.sh

Preconditions:

- `bash $S/launch.sh` で立てた run（server は使わないが、`map.html` の配信に web を使う）。
- 手書きのログ `e2e/fixtures/review.log.jsonl`（発言 6 件、ノードを足す反映 3 回、録音なし）。

- **ログを置く.** `SD=$(cat "$RUN/sessions-dir"); mkdir -p "$SD/review"; cp e2e/fixtures/review.log.jsonl "$SD/review/log.jsonl"`。
- **作る.** `bash $S/cli.sh "$RUN" review "$SD/review"`。終了コード 0、標準出力が `.../review/map.html`。
- **開く.** `bash $S/browser.sh "$RUN" open "http://127.0.0.1:$P/session-files/review/map.html"`（開いていれば `goto`）。snapshot に `slider "時刻"`、`button "見返しの確認"`・`button "要点1"`〜`button "要点3"`。`bash $S/browser.sh "$RUN" eval "document.querySelectorAll('.map-node__text').length"` が `4`。
- **先頭へ.** `slider "時刻"` の ref を `click` し、`bash $S/browser.sh "$RUN" press Home`。同じ `eval` が `1`。`bash $S/browser.sh "$RUN" screenshot --filename shots/review-home.png`。
- **速さ.** `button "再生の速さ"` を `click`。snapshot に `menu "再生の速さ"` と `menuitem` が 4 つ。`60 倍` の menuitem を `click` し、ボタンの文言が `60×` になり、メニューが消える。
- **出し入れ.** `button "字幕"` と `button "右の列"` は最初 `[pressed]`。それぞれ `click` すると `[pressed]` が外れる。

## Gotchas

- `/session-files/` の配信は、拡張子 `.html` だけを text/html で返します。`log.jsonl` などは text/plain の本文で見えます。
- 「反映 1 つ戻る」などのボタンでも時刻は動きますが、`review-seek` はスライダーの入り口です。ボタンで通した結果をスライダーの確認とは報告しません。
- スマホの幅（`bash $S/browser.sh "$RUN" resize 390 844` の後に開き直す）では、字幕と右の列を隠して始めます（Issue #1236）。
- 別のセッション名で作るときは、server の ISO 時刻のフォルダ名と重ならない名前にします。
