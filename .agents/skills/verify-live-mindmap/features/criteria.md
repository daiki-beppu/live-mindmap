# 判断軸

利用者が `cli start --criteria <ファイル>` で会議の判断軸（1 行 1 軸、記載順が優先順）を渡すと、画面の隅に「判断軸（優先順）」の帯が出て、案・論点・決定のノードの本文の下に関係する軸名が添えられます。軸と関係づけはログ・`map.json`・`map.md`・見返しの `map.html` に残ります。

## Sub-features

- `criteria-strip`: 帯 `判断軸（優先順）` に軸が記載順に並ぶ。空行は無視する。
- `criteria-relation`: 案のノードの名前に関係する軸名が付き、反映のたびに付け替わる。
- `criteria-export`: `stop` の後、`map.md` に `## 判断軸（優先順）` と案の行の `（判断軸：<軸>）`、`map.json` に `"criteria"`。
- `criteria-review`: 見返しの `map.html` にも帯と案の軸名が出る。

## How to get to it (user POV)

- ブラウザで `http://127.0.0.1:<ポート>/` を開いておく。
- ターミナルで `cli start --app <会議アプリ> --criteria <判断軸のファイル>` を流し、終えるときに `cli stop`、見返すときに `cli review <フォルダ>`。

## Driving it with browser.sh / cli.sh

Preconditions:

- `bash $S/launch.sh`（4 件）で立てた run。セッションなし。

- **軸のファイル.** `printf '利用者への影響\n\n工数\n' > "$RUN/criteria.txt"`（空行を 1 つ挟む）。
- **始める.** `bash $S/browser.sh "$RUN" open "http://127.0.0.1:$P/"` の後、`D=$(bash $S/cli.sh "$RUN" start --app us.zoom.xos --criteria "$RUN/criteria.txt" | tail -1)`。終了コード 0。`$D/log.jsonl` の 1 行目（`"type":"start"`）に `"criteria":["利用者への影響","工数"]`。
- **帯.** `sleep 3; bash $S/browser.sh "$RUN" snapshot`。`generic "判断軸（優先順）"` の下の list に `利用者への影響`・`工数` の順の listitem 2 つ。
- **関係づけ.** さらに `sleep 12`（`start` から約 15 秒）して snapshot。`button "導入方針"`・`button "? 導入の進め方"` と、名前が `段階的に導入する — 相手 A` で始まり `利用者への影響` か `工数` で終わる button。軸名がまだ無ければ 5 秒おいてもう一度 snapshot します。`bash $S/browser.sh "$RUN" screenshot --filename shots/criteria-related.png`。
- **書き出し.** `bash $S/cli.sh "$RUN" stop` の後、`grep -n '判断軸' "$D/map.md"` に `## 判断軸（優先順）` と `（判断軸：工数）` を含む案の行。`grep -c '"criteria"' "$D/map.json"`（1 以上）。
- **見返し.** `SD=$(cat "$RUN/sessions-dir"); mkdir -p "$SD/crit"; cp "$D/log.jsonl" "$SD/crit/"; bash $S/cli.sh "$RUN" review "$SD/crit"`。`goto "http://127.0.0.1:$P/session-files/crit/map.html"` の snapshot に、帯 `判断軸（優先順）` と、名前が `工数` で終わる `段階的に導入する` の button、「変わったこと」の `追加 案 段階的に導入する` と `更新 案 段階的に導入する`。

## Gotchas

- 判断軸を渡すと偽の updater は別の振る舞いになります。最初の反映で `議題 導入方針` → `論点 導入の進め方` → `案 段階的に導入する` を足し、以降は 1 回に 1 件だけ読んで案の軸を `利用者への影響` → `工数` → 解除の順に付け替えます。反映ごとに 6 秒待つので、ノードは `start` から 6 秒ほど後、案の軸名は 13 秒ほど後に出ます。README の「10 秒で出なければ不合格」はこの機能には当てはめません。
- 4 件の run では確定は 2 件で、残りは `stop` の確定で読まれます。`stop` 後の案の軸が `工数` になるのはそのためです。解除まで見るなら件数を増やします。
- 案の名前の `— 相手 A` は提案者です。軸名はその後ろに付きます。
