struct SpeakerSegmentUpdate {
    let segments: [SpeakerSegment]
    let settled: Double
}

struct SpeakerSegmentTimeline {
    private var processedFrames = 0
    private var openStarts: [Int?] = Array(repeating: nil, count: 8)

    mutating func append(probabilities: [Float], frameCount: Int) -> SpeakerSegmentUpdate {
        precondition(probabilities.count == frameCount * 8)
        var closed: [SpeakerSegment] = []
        for slot in 0..<8 {
            for frame in 0..<frameCount {
                let position = processedFrames + frame
                if probabilities[frame * 8 + slot] > 0.5 {
                    if openStarts[slot] == nil { openStarts[slot] = position }
                } else if let start = openStarts[slot] {
                    closed.append(segment(slot: slot, start: start, end: position, isFinal: true))
                    openStarts[slot] = nil
                }
            }
        }
        processedFrames += frameCount
        let tentative = openSegments(isFinal: false)
        let settledFrame = openStarts.compactMap { $0 }.min() ?? processedFrames
        return SpeakerSegmentUpdate(segments: closed + tentative, settled: Double(settledFrame) / 100)
    }

    mutating func finish() -> SpeakerSegmentUpdate {
        let remaining = openSegments(isFinal: true)
        openStarts = Array(repeating: nil, count: 8)
        return SpeakerSegmentUpdate(segments: remaining, settled: Double(processedFrames) / 100)
    }

    private func openSegments(isFinal: Bool) -> [SpeakerSegment] {
        openStarts.enumerated().compactMap { slot, start in
            start.map { segment(slot: slot, start: $0, end: processedFrames, isFinal: isFinal) }
        }
    }

    private func segment(slot: Int, start: Int, end: Int, isFinal: Bool) -> SpeakerSegment {
        SpeakerSegment(start: Double(start) / 100, end: Double(end) / 100, slot: slot, isFinal: isFinal)
    }
}
