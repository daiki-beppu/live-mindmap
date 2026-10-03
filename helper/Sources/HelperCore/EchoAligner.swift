import CoreAudio

/// 参照（タップ）とマイクを hostTime で揃えて AEC に渡す状態機械。入出力を持たない。
/// どちらも 48 kHz・モノラルのサンプルで受け取る。参照の 10 ms 区間は、開始時刻がマイクの 10 ms の開始時刻以下のものを、
/// そのマイクを処理する前に、すべて順に reverse へ渡す。参照が足りないときは無音で埋める。
/// ただし、並行に届く 2 つの流れでは、参照が遅れて届くだけの可能性がある。参照の流れが終わっておらず、
/// 必要な参照がまだ届いていない間は、マイクの処理を保留する。保留が `holdLimitSamples` を超えたら無音で埋めて進める。
struct EchoAligner<Canceller: EchoCanceller> {
    /// 保留できるマイクの量（500 ms 分）。これを超えると、参照を待たずに無音で埋める。
    static var holdLimitSamples: Int { echoSampleRate / 2 }

    private let canceller: Canceller
    private let frameTicks: UInt64

    /// reverse に渡す次の区間の開始時刻。参照もマイクも処理していないうちは nil。
    private var reverseNext: UInt64?
    /// reverse を 1 つでも渡したか。渡すまでは、`reverseNext` より前のマイクの区間を覆う reverse が無い。
    private var reverseStarted = false
    private var reference: [Float] = []
    /// `reference` の先頭サンプルの時刻。
    private var referenceTime: UInt64 = 0
    private var referenceDone = false

    private var capture: [Float] = []
    /// `capture` の先頭サンプルの時刻。
    private var captureTime: UInt64 = 0

    init(canceller: Canceller) {
        self.canceller = canceller
        frameTicks = Self.ticks(samples: echoFrameSamples)
    }

    /// 参照のサンプルを足す。直前の参照との間に 10 ms 以上の隙間があれば無音で埋め、重なりは捨てる。
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

    /// マイクのサンプルを足す。持ち越しがあるときは直前の続きとして扱い、`hostTime` は持ち越しがないときだけ使う。
    mutating func addCapture(_ samples: [Float], hostTime: UInt64) {
        if capture.isEmpty { captureTime = hostTime }
        capture.append(contentsOf: samples)
    }

    /// 参照の流れが終わった。以後、足りない参照は無音で埋める。
    mutating func referenceFinished() {
        referenceDone = true
    }

    /// 処理できるマイクの 10 ms 区間を処理し、連続した結果を 1 つにまとめて返す（無ければ空）。
    /// `force` のときは、参照を待たずに、足りない分を無音で埋めて残りを処理する（480 サンプルに満たない端数は残る）。
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

    /// 開始時刻が `time` 以下の参照の区間を、すべて reverse に渡す。保留が必要で渡せないときは false。
    private mutating func feedReference(through time: UInt64, mayFillWithSilence: Bool) -> Bool {
        if reverseNext == nil {
            // 参照が一度も届いていない。無音を渡してよいときだけ、マイクの時刻から始める。
            guard mayFillWithSilence else { return false }
            reverseNext = time
        }
        let silence = [Float](repeating: 0, count: echoFrameSamples)
        // reverse をまだ 1 つも渡していない間は、参照の開始より前の区間に鳴った参照は無い（開始が 10 ms 未満の遅れでも同じ）。
        // 無音を reverse に渡してから capture を呼ぶ。渡し始めた後は、10 ms 以上離れたときだけ無音を足す。
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
                // 新しい参照が届いていて、この区間の参照は来ない（隙間）。
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

    /// すでに reverse に渡した（無音で埋めた）範囲より前の参照を捨てる。
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
