import Foundation

/// 確定した区間から声の埋め込みを作って `SlotMixDetector` に渡す（Issue #1024）。
/// 16 kHz の音声をタイムライン（`diarize` の最初のバッファを 0 とする秒、シフト前）上の位置付きで溜め、確定済みの位置より前は捨てる。
/// 1 回の `diarize` の worker だけが触る。
public final class SlotMixTracker: @unchecked Sendable {
    private static let sampleRate = 16_000.0
    private let embedder: SpeakerEmbedder
    private var detector = SlotMixDetector()
    private var samples: [Float] = []
    /// `samples[0]` のタイムライン上のサンプル位置。
    private var baseIndex = 0
    private var embedFailureReported = false
    /// 最後に返した枠ごとの重心。変わった枠だけを返すために覚える（この 1 回の `diarize` の中だけ。プロセスをまたぐ状態は持たない）。
    private var reportedCentroids: [Int: [Float]] = [:]

    public init(embedder: SpeakerEmbedder) {
        self.embedder = embedder
    }

    public func append(samples16k: [Float]) {
        samples.append(contentsOf: samples16k)
    }

    /// この位置（秒）より前の音声を捨てる。
    public func discard(before seconds: Double) {
        let drop = min(max(0, Int(seconds * Self.sampleRate) - baseIndex), samples.count)
        guard drop > 0 else { return }
        samples.removeFirst(drop)
        baseIndex += drop
    }

    /// 確定した区間のうち 2 秒以上のものを時刻順に埋め込みにし、混入を判定する。
    /// `centroids` は、この呼び出しで重心が変わった枠の最後の重心（長さ 1）を枠の番号順に返す（Issue #1025。サーバーが起動し直しをまたぐ枠のつなぎ直しに使う）。
    /// `mixed` は混入した枠と、判定のもとになった区間の end（シフト前の秒）。
    /// 10 秒を超える区間は中央の 10 秒を使う。仮の区間は使わない。
    public func update(finalized segments: [SpeakerSegment]) -> (centroids: [(slot: Int, centroid: [Float])], mixed: [(slot: Int, at: Double)]) {
        let usable = segments
            .filter { $0.isFinal && $0.end - $0.start >= SlotMixCriteria.minSegmentSeconds }
            .sorted { ($0.start, $0.end, $0.slot) < ($1.start, $1.end, $1.slot) }
        var mixed: [(slot: Int, at: Double)] = []
        for segment in usable {
            guard let window = window(of: segment) else { continue }
            do {
                if detector.add(slot: segment.slot, embedding: try embedder.embed(window)) {
                    mixed.append((slot: segment.slot, at: segment.end))
                }
            } catch {
                // 補助の機能なので、話者分離は止めない。同じ失敗は 1 回だけ知らせる。
                if !embedFailureReported {
                    embedFailureReported = true
                    FileHandle.standardError.write(Data("話者の混入の検出: 声の埋め込みに失敗した: \(error)\n".utf8))
                }
            }
        }
        let centroids = detector.centroids
            .filter { reportedCentroids[$0.key] != $0.value }
            .sorted { $0.key < $1.key }
            .map { (slot: $0.key, centroid: $0.value) }
        for item in centroids { reportedCentroids[item.slot] = item.centroid }
        return (centroids: centroids, mixed: mixed)
    }

    private func window(of segment: SpeakerSegment) -> [Float]? {
        let length = min(segment.end - segment.start, SlotMixCriteria.maxSegmentSeconds)
        let from = segment.start + (segment.end - segment.start - length) / 2
        let lower = max(Int((from * Self.sampleRate).rounded()) - baseIndex, 0)
        let upper = min(Int(((from + length) * Self.sampleRate).rounded()) - baseIndex, samples.count)
        guard upper - lower >= Int(SlotMixCriteria.minSegmentSeconds * Self.sampleRate) else { return nil }
        return Array(samples[lower..<upper])
    }
}
