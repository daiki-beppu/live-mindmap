import Foundation

// 2 本のファイル（`相手` と `自分`。`cli recorded --self`）の読み手を、同じ音声の時刻に揃える。
// 読み手は、次に渡す入力の開始位置が、もう一方の読み終えた位置以下になるまで待つ（もう一方が終わっていれば待たない）。
// 速く読める側だけが先へ進むと、`自分` の確定結果が `相手` の文脈より先に届き、ライブと同じ重複の判定にならない。
// 読んだ位置は、そのまま音声の時刻の時計（`now`・`sleep`）になる。保留（`DuplicateMarker`）の長さは、この時計で測る。
// 待ちに時間の上限は付けない。読み終え・失敗・キャンセルのどれでも、その読み手は終わりとして数え、もう一方を待たせない。
// 時計（`sleep`）は、読み手が全部読み終えても戻らない。入力の終わりの後にも、認識結果は届き続ける（`SpeechAnalyzer` の確定）。
// 映像（`screen`）があるときは、音声の読み手は、映像の判定が済んだ時刻（`Screen.advance`）を越えて入力を渡さない。
// 判定器が付ける `screen` の start は、前に送ると判定したフレームの時刻より前にならない。だから、入力の終わりまで映像が進んでいれば、
// その入力から出る結果（end がその入力の終わり以下）より前に流すべき `screen`（start = t、end > t の `partial`・`remark` より前）は、すべて流し終えている。
// 映像の進みは読んだ位置（`positions`）に入れない（時計と、2 本の音声を揃える待ちには影響しない）。
// 保留は結果を使い切った合図（`finishTheirs`・`finishMine`）で解け、組み立て側が `close()` で残りの待ちを解く。

public actor FileReadingAlignment {
    /// 読み手 1 本の操作口。`FileAudioInputs` が持つ。
    public struct Reader: Sendable {
        let id: Int
        let alignment: FileReadingAlignment

        /// 次に渡す入力が `position` 秒で終わる。映像の判定が `position` 秒まで済むのを待つ（映像が無い・終わっていれば待たない）。キャンセルされたら `CancellationError`。
        func waitScreen(through position: Double) async throws {
            try await alignment.waitScreen(through: position)
        }

        /// 次に渡す入力が `start` 秒から始まる。もう一方の読み手が `start` 秒まで読み終えるまで待つ。キャンセルされたら `CancellationError`。
        func waitTurn(start: Double) async throws {
            try await alignment.waitTurn(of: id, start: start)
        }

        /// ここまで `position` 秒を読み終えた。
        func advance(to position: Double) async {
            await alignment.advance(id, to: position)
        }

        /// この読み手は終わった（読み終え・失敗・キャンセル）。もう一方を待たせない。
        func finish() async {
            await alignment.finish(id)
        }
    }

    /// 映像の読み手 1 本の操作口。`relayFileScreen` が持つ。
    public struct Screen: Sendable {
        let alignment: FileReadingAlignment

        /// 映像の判定が `time` 秒まで済んだ（以後に流す `screen` の start は `time` 秒より前にならない）。
        public func advance(to time: Double) async {
            await alignment.advanceScreen(to: time)
        }

        /// 映像の読み出しが終わった（読み終え・失敗・キャンセル）。音声の読み手を待たせない。
        public func finish() async {
            await alignment.finishScreen()
        }
    }

    private var positions: [Int: Double] = [:]
    private var finished: Set<Int> = []
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var closed = false
    private var screenRegistered = false
    private var screenFinished = false
    private var screenTime = 0.0

    public init() {}

    /// 読み手を 1 本足す。読み手は、すべて足してから読み始める（足す前に読み始めた読み手は、足されていない相手を待たない）。
    /// `from` は読み始める音声の時刻（起動し直し）。読み手の位置が 0 のままだと、2 本とも途中から読むときに互いを待って止まるので、開始位置から始める。
    public func addReader(from: Double = 0) -> Reader {
        let id = positions.count
        positions[id] = from
        return Reader(id: id, alignment: self)
    }

    /// 映像の読み手を足す。読み手と同じく、読み始める前に足す。
    public func addScreen(from: Double = 0) -> Screen {
        screenRegistered = true
        screenTime = from
        return Screen(alignment: self)
    }

    /// 音声の時刻。終わっていない読み手の位置の最小値。全部終わっていれば最大値。
    public func now() -> Double {
        let running = positions.filter { !finished.contains($0.key) }.values
        return running.min() ?? positions.values.max() ?? 0
    }

    /// 音声の時刻が `duration` 進むまで待つ。`close()` された後は、待っていた `sleep` も後から呼ぶ `sleep` もすぐ戻る。キャンセルされたら `CancellationError`。
    public func sleep(_ duration: Duration) async throws {
        let target = now() + (Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18)
        while !closed, now() < target {
            try await waitForChange()
        }
        try Task.checkCancellation()
    }

    /// 時計を閉じる。進まなくなった時計を待っている `sleep` を解く（流し終えた後・失敗の後に呼ぶ）。
    public func close() {
        closed = true
        wake()
    }

    private func waitScreen(through position: Double) async throws {
        while screenRegistered, !screenFinished, screenTime < position - 1e-9 {
            try await waitForChange()
        }
    }

    private func advanceScreen(to time: Double) {
        screenTime = max(screenTime, time)
        wake()
    }

    private func finishScreen() {
        screenFinished = true
        wake()
    }

    private func waitTurn(of id: Int, start: Double) async throws {
        while !canProceed(id, start: start) {
            try await waitForChange()
        }
    }

    /// 自分以外の、終わっていない読み手がすべて `start` まで読み終えている。
    private func canProceed(_ id: Int, start: Double) -> Bool {
        positions.allSatisfy { other, position in other == id || finished.contains(other) || position >= start - 1e-9 }
    }

    private func advance(_ id: Int, to position: Double) {
        positions[id] = max(positions[id] ?? 0, position)
        wake()
    }

    private func finish(_ id: Int) {
        finished.insert(id)
        wake()
    }

    /// 位置か終了の変化を 1 回待つ。キャンセルされたら起こされ、`CancellationError` を投げる。
    private func waitForChange() async throws {
        try Task.checkCancellation()
        await withTaskCancellationHandler {
            await withCheckedContinuation { waiters.append($0) }
        } onCancel: {
            Task { await self.wake() }
        }
        try Task.checkCancellation()
    }

    private func wake() {
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume() }
    }
}
