# #766 の試作（使い捨て）

「文ごとの種別判定を Claude から切り出す」の試作。結論は issue #766 のコメントが正本。main には入れない。

## 作り

- 土台は #765 の試作（`prototype/765-route`）。振り分け（新しい発言に決定・TODO があるかを Jev で判定し、≥0.3 なら Sonnet 5.5、他は Haiku 5.5 low）はそのまま
  - `jev`: #765 で採った振り分けそのまま（基準）
  - `hint`: 振り分けに加え、新しい発言を文に切り（`src/localPrompt.ts` の `splitSentences`）、文ごとに Jev（`choice`）で #487 の 7 種類（なし・説明・問い・提案・懸念・合意・作業）から選ばせる。なし・説明以外の文の後ろに〔種類 確からしさ〕を付けて差分更新に渡す。振り分けの判定と並べて呼ぶ。文ごとの失敗・1 秒の時間切れはヒントなし
  - SYSTEM の末尾にヒントの読み方を足す（`src/claude.ts` の `HINT_APPEND`、`PROTO766_HINT=1` のときだけ）
- 判定の記録は出力の `calls[].judge.hints`。費用はヒントの Jev の入力トークンも足す

## 道具

- `m766.ts <jev|hint> <items.json> <lines.json> <out.json> <truth.json>`
- `run.sh <screen|facilitators> <回> <dir>`: 2 案を同時に 1 回ずつ流す（実際は screen と facilitators も並べて 4 本同時）
- `analyze.mjs`: #765 と同じ
- 入力は #761・#765 と同じ items / lines

結果は [results.md](results.md)。
