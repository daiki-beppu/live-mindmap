import CoreAudio

struct EchoAligner<Canceller: EchoCanceller> {
    static var holdLimitSamples: Int { echoSampleRate / 2 }

    private let canceller: Canceller
    private let frameTicks: UInt64

    private var reverseNext: UInt64?
    private var reverseStarted = false
    private var reference: [Float] = []
    private var referenceTime: UInt64 = 0
    private var referenceDone = false

    private var capture: [Float] = []
    private var captureTime: UInt64 = 0

    init(canceller: Canceller) {
        self.canceller = canceller
        frameTicks = Self.ticks(samples: echoFrameSamples)
    }

    mutating func addReference(_ samples: [Float], hostTime: UInt64) {
        if reverseNext == nil { reverseNext = hostTime }
        if reference.isEmpty {
            reference = samples
            referenceTime = hostTime
            return
        }
        let end = referenceTime &+ Self.ticks(samples: reference.count)
        if hostTime >= end &+ frameTicks {
            reference.append(contentsOf: repeatElement(0, count: Self.sampleCount(ticks: hostTime - end)))
            reference.append(contentsOf: samples)
        } else if hostTime &+ frameTicks <= end {
            let overlap = min(Self.sampleCount(ticks: end - hostTime), samples.count)
            reference.append(contentsOf: samples.dropFirst(overlap))
        } else {
            reference.append(contentsOf: samples)
        }
    }

    mutating func addCapture(_ samples: [Float], hostTime: UInt64) {
        if capture.isEmpty { captureTime = hostTime }
        capture.append(contentsOf: samples)
    }

    mutating func referenceFinished() {
        referenceDone = true
    }

    mutating func drain(force: Bool) -> [(samples: [Float], hostTime: UInt64)] {
        var output: [Float] = []
        let outputTime = captureTime
        var consumed = 0
        while capture.count - consumed >= echoFrameSamples {
            let pending = capture.count - consumed
            let mayFill = force || referenceDone || pending > Self.holdLimitSamples
            let time = captureTime
            guard feedReference(through: time, mayFillWithSilence: mayFill) else { break }
            var frame = Array(capture[consumed..<(consumed + echoFrameSamples)])
            frame.withUnsafeMutableBufferPointer { canceller.processCapture($0.baseAddress!) }
            output.append(contentsOf: frame)
            consumed += echoFrameSamples
            captureTime = time &+ frameTicks
        }
        capture.removeFirst(consumed)
        return output.isEmpty ? [] : [(samples: output, hostTime: outputTime)]
    }

    private mutating func feedReference(through time: UInt64, mayFillWithSilence: Bool) -> Bool {
        if reverseNext == nil {
            guard mayFillWithSilence else { return false }
            reverseNext = time
        }
        let silence = [Float](repeating: 0, count: echoFrameSamples)
        if let next = reverseNext, next > time, !reverseStarted || next >= time &+ frameTicks {
            silence.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress!) }
            return true
        }
        while let next = reverseNext, next <= time {
            discardReference(olderThan: next)
            if reference.count >= echoFrameSamples, referenceTime <= next {
                reference.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress!) }
                reference.removeFirst(echoFrameSamples)
                referenceTime = referenceTime &+ frameTicks
            } else if !reference.isEmpty, referenceTime > next {
                silence.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress!) }
            } else if mayFillWithSilence {
                silence.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress!) }
            } else {
                return false
            }
            reverseNext = next &+ frameTicks
            reverseStarted = true
        }
        return true
    }

    private mutating func discardReference(olderThan next: UInt64) {
        guard !reference.isEmpty, referenceTime < next else { return }
        let drop = min(Self.sampleCount(ticks: next - referenceTime), reference.count)
        reference.removeFirst(drop)
        referenceTime = referenceTime &+ Self.ticks(samples: drop)
    }

    private static func ticks(samples: Int) -> UInt64 {
        AudioConvertNanosToHostTime(UInt64(samples) * 1_000_000_000 / UInt64(echoSampleRate))
    }

    private static func sampleCount(ticks: UInt64) -> Int {
        Int((AudioConvertHostTimeToNanos(ticks) * UInt64(echoSampleRate) + 500_000_000) / 1_000_000_000)
    }
}
