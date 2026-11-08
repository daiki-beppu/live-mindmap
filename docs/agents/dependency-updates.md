# 依存の更新の索引

Renovate の PR を仕上げるエージェントが、グループから既存の手順を引くための索引。手順の正本はリンク先にあり、ここには写さない。正本の無いグループは「正本なし」と書き、AGENTS.md の [Checks](../../AGENTS.md#checks) に従う。

## 行の引き方

- Renovate の groupName で引き、無ければ依存名で引く。
- 当たる行はすべて読む。major は自分のグループの行と major の行の両方を読む。
- どの行にも当たらない PR は、AGENTS.md の [Checks](../../AGENTS.md#checks) だけを回す。

## グループ

- **`effect-foldkit`**: 手順は [AGENTS.md の Effect](../../AGENTS.md#effect) と [web の版の上げ方](../../web/AGENTS.md#版の上げ方)。直すのは server・web・e2e の `package.json`、Foldkit の peer が effect の版に追いついていなければ `pnpm-workspace.yaml` の `peerDependencyRules`、`web/test/foldkitAgents.it.test.ts` の `TAG`、`skills-lock.json` と `web/AGENTS.md` の写した版、`outdatedApi` の指摘。Evals は回さない。人の手は要らない。
- **`claude-agent-sdk`**: 手順は [Claude の固定版を更新する](../../server/managed-deps/claude/README.md#固定版を更新する)。直すのは `server/managed-deps/claude/` の `package.json` と `package-lock.json`、`server/package.json`、`server/test/checkManagedLock.it.test.ts`、`server/test/managedClaudeLoad.it.test.ts`。Evals は [表](#evals) の `claude-agent-sdk` の行。人の手は要らない。
- **playwright**: 手順は [Chromium の固定版を更新する](../../server/managed-deps/chromium/README.md#固定版を更新する)。直すのは `server/managed-deps/chromium/` の `package.json` と `package-lock.json`、`server/package.json`、`server/src/managedDeps.ts` の headless shell revision の対応。Evals は [表](#evals) の playwright の行。人の手は要らない。
- **`e2e`**: 手順は [e2e の記録の取り直し方](../../e2e/README.md#記録の取り直し方) と [AGENTS.md の Evals](../../AGENTS.md#evals) の E2E の段落。直すのは `e2e/package.json` と、同じコミットに入れる `e2e/.e2e/cache/`。Evals は回さない。人の手は要る: 初回の `e2e login openai` で ChatGPT にサインインする。
- **fallow**: 手順は [AGENTS.md の Checks](../../AGENTS.md#checks) の fallow の段落。直すのはルートの `package.json`、`.fallowrc.json` の `$schema` の版、新しい指摘を受けたコード。Evals は回さない。人の手は要らない。
- **FluidAudio**: 手順は正本なし、[Checks](../../AGENTS.md#checks)。直すのは `helper/Package.swift` と `helper/Package.resolved`。Evals は [表](#evals) の FluidAudio の行と、[AGENTS.md の Evals](../../AGENTS.md#evals) の `measure-bootstrap.sh`。人の手は要らない。
- **AEC3**: 手順は正本なし、[Checks](../../AGENTS.md#checks)。直すのは `helper/scripts/build-webrtc-apm.sh` の `COMMIT=`。Evals は [表](#evals) の AEC3 の行と、[AGENTS.md の Evals](../../AGENTS.md#evals) の `measure-bootstrap.sh`。人の手は要らない。
- **ツールチェーン**: 手順は正本なし、[Checks](../../AGENTS.md#checks)。README の決まりは [AGENTS.md の README](../../AGENTS.md#readme)。直すのは `.nvmrc`、`.github/workflows/tests.yml` の `node-version`、ルートの `package.json` の `packageManager`、`README.ja.md` と `README.md` の Node の版。Evals は回さない。人の手は要らない。
- **major**: 手順は正本なし、[Checks](../../AGENTS.md#checks)。ライブラリのグループの行も読む。直すのはライブラリのグループの行と、互換を壊した変更の指摘。Evals はライブラリのグループの行。人の手はライブラリのグループの行に従う。
- **`lockFileMaintenance`**: 手順は正本なし、[Checks](../../AGENTS.md#checks)。直すのは `pnpm-lock.yaml` と、推移依存の更新で新しく出た型・fallow の指摘。Evals は回さない。人の手は要らない。
- **managed-deps の npm**: 手順は [Claude](../../server/managed-deps/claude/README.md#固定版を更新する) と [Chromium](../../server/managed-deps/chromium/README.md#固定版を更新する) の手順 2。直すのは `server/managed-deps/claude/` と `server/managed-deps/chromium/` の `package.json` の `packageManager` と `package-lock.json`、両 README の npm の版。Evals は回さない。人の手は要らない。

## Evals

コマンドと素材は、この表にだけ書く。

| グループ | 回すもの | 素材 |
|---|---|---|
| `claude-agent-sdk` | `cli play … --screen` → `cli eval --truth`。main とブランチの 2 回まで | `~/live-mindmap-samples/synth/screen-cut/` |
| AEC3 の `COMMIT=` | `stt-bench synth` の echo シナリオ → `stt-bench echo --candidate production` | 合成（[helper の AEC3 の計測](../../helper/README.md#aec3-の開始直後の計測stt-bench-echo)） |
| FluidAudio | `speakerAccuracy`（Sortformer の差分が混入の検出に触れる版では `synth/silly` を足す） | `synth/overlap-1/` |
| playwright | 同じ保存済みセッションを main とブランチで書き出し、`map.png` を 2 枚コメントに添える（数字の Evals ではない） | 手元の保存済みセッション 1 つ |
| そのほか | 回さない | — |

`cli eval` は [cli eval](../../server/bench/README.md#cli-evalマップの質)、`speakerAccuracy` は [speakerAccuracy](../../server/bench/README.md#speakeraccuracy話者分離の精度) に回し方がある。

### 測り方の決まり

前例は [AGENTS.md の Evals](../../AGENTS.md#evals) と [`server/bench/README.md`](../../server/bench/README.md)。

- main とブランチを同じ時間帯に続けて測る。
- 結果は数とラベルだけにする。発言の本文は貼らない。
- Claude SDK の計測が 2 回を超えるときだけ、流す前に AskUserQuestion で 1 件聞く。手元のモデルだけの計測は聞かない。
- Evals は合否を出さない。

## 報告

- Renovate の PR では、回した段と結果・Evals の before/after・残した判断を、PR 本文ではなく 1 行目が `## 依存の仕上げ` の PR のコメントに書いてよい。AGENTS.md の [Checks](../../AGENTS.md#checks) と同じ決まり。
- 人の手が要る段は、AskUserQuestion を 1 件に絞って頼む。
