import Foundation

public final class SlotMixTracker: @unchecked Sendable {
    private static let sampleRate = 16_000.0
    private let embedder: SpeakerEmbedder
    private var detector = SlotMixDetector()
    private var samples: [Float] = []
    private var baseIndex = 0
    private var embedFailureReported = false
    private var reportedCentroids: [Int: [Float]] = [:]

    public init(embedder: SpeakerEmbedder) {
        self.embedder = embedder
    }

    public func append(samples16k: [Float]) {
        samples.append(contentsOf: samples16k)
    }

    public func discard(before seconds: Double) {
        let drop = min(max(0, Int(seconds * Self.sampleRate) - baseIndex), samples.count)
        guard drop > 0 else { return }
        samples.removeFirst(drop)
        baseIndex += drop
    }

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
