# diarization-bench（使い捨て）

Issue #369 で、話者分離の候補（FluidAudio の Sortformer・LS-EEND・pyannote 逐次版）を合成会議で測った道具。本体には入れない。結果は `docs/research/2026-10-08-diarization-measurement.md`。

1. 合成会議を 16 kHz モノラルにする: `ffmpeg -i meeting.m4a -ac 1 -ar 16000 -c:a pcm_s16le <会議>.wav`
2. `相手` だけの音声を作る（1 人の行を無音に）: `uv run --with numpy python scripts/mute.py <会議>.wav timeline.tsv <話者> <会議>-other.wav`
3. `swift build -c release`。SwiftPM が FluidAudio の `NemoTextProcessing.xcframework.zip`（バイナリの依存）の取得で止まるときは、FluidAudio を手元に複製し、`Package.swift` と `Package@swift-6.2.swift` の `binaryTarget` を curl で落とした zip を展開した `path:` に書き換えて、`.package(path:)` で参照する
4. `.build/release/bench <方式> <wav> <出力の接頭辞>`。方式は `sortformer-fast` / `sortformer-balanced` / `lseend-<型>-<刻み ms>`（末尾に `-offline` で一括処理）/ `pyannote<塊の秒>`
5. 採点: `uv run --with numpy --with scipy python scripts/score.py timeline.tsv <接頭辞> [無音にした話者]`。どの枠に混ざったかは `scripts/confusion.py`
6. 全組み合わせ: `scripts/run-all.sh <作業フォルダ> <このフォルダ>`

`results.jsonl` は計測した全 48 本の採点結果（`audio` は `other` = `相手` だけ、`full` = 全員、`opus24k` = Opus を通した `相手` だけ、`other4` = parnassus から 2 人を無音にした `相手` 4 人）。
