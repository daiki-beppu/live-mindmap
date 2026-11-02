# 初回の準備とその計測

clone 直後の準備（`pnpm bootstrap` → `pnpm dev` → 別のターミナルでの話者分離のモデルの取得と `cli install`）を変えるとき、`scripts/bootstrap.sh`・`helper/scripts/fetch-speaker-models.sh`・`helper/Package.swift` の依存や製品・`server` の `dev` の helper のビルドを触るとき、`scripts/measure-bootstrap.sh` で初回の時間を測るときに読む文書。手順そのものは [README.ja.md の「初回の準備」](../../README.ja.md#初回の準備)、流す時機は AGENTS.md の Evals にある。

- 用語: 無し（初回の準備は開発の手順で、利用者に見える概念ではない）
- ADR: 無し。ビルド済みの成果物を配らない判断は [#1420](https://github.com/daiki-beppu/live-mindmap/issues/1420) にある
- 関連する知識文書: [takt の run](takt-runs.md)（準備のスクリプトを並べて流さない、報告が PR の本文に写らない）、[CI の段とジョブの割り方](ci-stages.md)（`measureBootstrap.heavy` が 1 本で 60 秒を超える）

## 初回の準備の中で helper を `swift build` するのは `pnpm dev` の 1 回だけ。代わりのビルドは `pnpm dev` と同じ引数にし、`--product` を付けない

helper の時間の大半は、依存の FluidAudio のコンパイルだ。構成か製品の指定が変わると作り直しになる。[#1416](https://github.com/daiki-beppu/live-mindmap/issues/1416) では、初回の手順の中で debug（`swift run`、59.4 秒）と release（113.7 秒）の 2 回ビルドしていた。SwiftPM には次の振る舞いがある。

- `--product` で作った後に製品を指定せずに `swift build` すると作り直す。製品を絞って縮むのは約 3 秒だけ
- `swift build` を 1 回増やすだけで、約半分の確率で release を作り直す（6 回中 4 回で名前が変わった。[#502](https://github.com/daiki-beppu/live-mindmap/issues/502)）

このため、`pnpm bootstrap` は `swift package resolve` までにとどめてビルドしない。`fetch-speaker-models.sh` は `helper/.build/release/live-mindmap-helper install-speaker-models` を直接動かし、実行ファイルが無いときだけ `swift build -c release --package-path <helper>` でビルドする（[PR #1464](https://github.com/daiki-beppu/live-mindmap/pull/1464)）。`-Osize`・デバッグ情報を切る・FluidAudio の `traits: []` は、揺れを超える差が出なかったので採っていない。「debug ビルドが戻っていないか」を構造で確かめる check は置かない（`CODING_STANDARDS.md` → Contracts, not structure）。戻ったかは `measure-bootstrap.sh` で見る。

## `pnpm bootstrap` の 3 段は並べて流し、1 つが落ちても残りを最後まで待つ。契約は終了コードと段の名前の付いた出力だけ

`[install]`（今は `scripts/setup-deps.sh`）・`[aec3]`・`[resolve]` を並べ、全部が終わってから落ちた段の名前を並べて 0 以外で終える。途中で止めると AEC3 の meson の作業ディレクトリが中途半端に残る。

テスト（`server/test/bootstrap.heavy.test.ts`）は、`pnpm`・`swift`・AEC3 のスクリプトを PATH の先頭の偽物に差し替える。偽物は 3 つの起動の印が揃うまで先へ進まないので、直列に流すと 8 秒の期限で落ちる。並べたことを時間の比較ではなく合流で確かめている。失敗の側は、落ちた段のプロセスが消えたのを `kill(pid, 0)` で確かめてから成功の段を終わらせ、最後の完了の行より後に落ちた段の名前が出ることを見る。段を足す・変えるときも、この継ぎ目で確かめる。

## `verifyDepsBeforeRun: false` はリポジトリのすべての script に効く

pnpm 12 は script を流す前に依存がそろっているかを確かめる。`pnpm bootstrap` の中で install を並べて流すために、`pnpm-workspace.yaml` に `verifyDepsBeforeRun: false` を置いた（[PR #1490](https://github.com/daiki-beppu/live-mindmap/pull/1490)）。このため、lockfile が変わった後に `pnpm test` などを流しても、pnpm は依存を入れ直さず、古い `node_modules` のまま走る。ブランチを替えたり pull したりして lockfile が変わったら、自分で `pnpm install`（または `bash scripts/setup-deps.sh`）を流す。

## 計測は利用者のキャッシュに書かない。環境変数で向けられない道具は、PATH の先頭の包みで引数を足す

`measure-bootstrap.sh` は一時ディレクトリへ clone し、SwiftPM・pnpm の store と state・uv・`LIVE_MINDMAP_DEPS`・話者分離のモデルをすべて一時ディレクトリへ向ける。pnpm 12 は `npm_config_store_dir` も `--cache-dir` も受け付けないので、`pnpm`・`swift`・`uvx`・`bash` の包みを `bin` に置いて `--store-dir`・`--cache-path` などを足し、段の始めと終わりの時刻をファイルに書かせている。pnpm は script の PATH の先頭へ自分の bin を戻すので、`scriptShell` の入口でも包みを先頭に戻す。

話者分離のモデルの保存先は Foundation の Application Support で `$HOME` を見ないので、helper の開発用の環境変数 `LIVE_MINDMAP_HELPER_SPEAKER_MODEL_DIR` で向ける（[PR #1513](https://github.com/daiki-beppu/live-mindmap/pull/1513)）。`install-speaker-models` と `run` は同じ `defaultSpeakerModelDirectory` を通るので、取る場所と読む場所はずれない。README には書かない。新しい道具やキャッシュを準備の手順に足したら、包みか環境変数のどちらで一時ディレクトリへ向けるかも足す。

## 目標（ビルド 140 秒・初回 240 秒）にはまだ届いていない。最初の計測ではビルドが 223〜229 秒だった

仕様 [#1423](https://github.com/daiki-beppu/live-mindmap/issues/1423) の見込み（ビルド約 136 秒・計約 205〜220 秒）は、#1416 の段ごとの値から debug のビルドを引いて足したもので、まとめた形では測っていなかった。2026-10-24 に `measure-bootstrap.sh` で同じコミットを 2 回測った値（[#1518](https://github.com/daiki-beppu/live-mindmap/issues/1518)、Apple M4・10 コア・16GB・Swift 6.4）は次のとおり。

| 段 | 基準（#1416、秒） | 1 回目（秒） | 2 回目（秒） |
|---|---:|---:|---:|
| AEC3 の compile | 22.7 | 63.1 | 58.7 |
| Swift の依存の解決 | 31.2 | 51.8 | 52.1 |
| helper の release ビルド | 113.7 | 166.1 | 164.1 |
| モデルの取得 | 45.0 | 39.2 | 31.0 |
| ビルドの計 | 136.4 | 229.2 | 222.8 |
| 初回の計 | 約 300 | 299.6 | 284.1 |

開始の条件は満たしていたが、load average は 3.63・3.76 で上限 4 の手前だった。環境差か処理差かは切り分けていない。#1518 は単独の不具合として開いている。初回の時間に効く変更の before/after は、この表ではなく、同じ時間帯に main とブランチを続けて測った値で比べる。

## `measure-bootstrap.sh` は、takt や他のセッションが動いていないときに手元で流す

開始の条件（空き 10GB 以上・1 分の load average 4 未満・ほかの `swift-build` 0 本）は、takt や案内役のセッションが並行していると満たせない（#1518 の triage では 4.64）。takt の run の中で測ると、run 自身の負荷が混ざる。1 回で約 5GB を使い、終わると（失敗・中断でも）消す。クラウドのセッションでは流さない（AGENTS.md の「クラウドのセッション」）。

測った表は issue のコメントに残す。takt の 1 回で通った run は実装の報告を PR の本文に写さず（[takt の run](takt-runs.md)）、#1519 と [PR #1843](https://github.com/daiki-beppu/live-mindmap/pull/1843) は before/after の表を受け入れ条件にしていたのに、本文に表が無い。今読める値は #1518 の本文のものだけだ。

## 出典

- [clone 直後の初回の準備を `pnpm bootstrap` にまとめ、helper のビルドを 1 回に減らしたとき](../devlog/2026-11-02.md#bootstrap-one-build)
- 仕様 [#1423](https://github.com/daiki-beppu/live-mindmap/issues/1423)、親 [#1431](https://github.com/daiki-beppu/live-mindmap/issues/1431)、元の地図 [#1415](https://github.com/daiki-beppu/live-mindmap/issues/1415) の決定 [#1416](https://github.com/daiki-beppu/live-mindmap/issues/1416)・[#1420](https://github.com/daiki-beppu/live-mindmap/issues/1420)・[#1422](https://github.com/daiki-beppu/live-mindmap/issues/1422)
- 子 [#1432](https://github.com/daiki-beppu/live-mindmap/issues/1432)・[PR #1464](https://github.com/daiki-beppu/live-mindmap/pull/1464)、[#1433](https://github.com/daiki-beppu/live-mindmap/issues/1433)・[PR #1490](https://github.com/daiki-beppu/live-mindmap/pull/1490)、[#1434](https://github.com/daiki-beppu/live-mindmap/issues/1434)・[PR #1513](https://github.com/daiki-beppu/live-mindmap/pull/1513)、[#1435](https://github.com/daiki-beppu/live-mindmap/issues/1435)・[PR #1519](https://github.com/daiki-beppu/live-mindmap/pull/1519)
- 計測の結果 [#1518](https://github.com/daiki-beppu/live-mindmap/issues/1518)、その後の [#1809](https://github.com/daiki-beppu/live-mindmap/issues/1809)・[PR #1843](https://github.com/daiki-beppu/live-mindmap/pull/1843)
