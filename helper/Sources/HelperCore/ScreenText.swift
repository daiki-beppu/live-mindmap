import CoreGraphics
import Foundation
import Vision

// 共有画面の文字を読む（Issue #643）。変化の判定で送ると決めた画面だけに、`screenShot(of:)`（ScreenImage.swift）の中でかける。

/// Vision の OCR は、内部の処理を Swift の並行処理のスレッドに積み、その終わりをセマフォで待つ。
/// 並行処理のスレッド（コア数ぶんしかない）の上で同期で呼ぶと、OCR が自分の握ったスレッドの空きを待って止まり、
/// 同時に呼ぶ数がコア数に届くとプロセスごと止まる（コアの少ない CI のランナーで IT が丸ごと止まった。Issue #1197）。
/// 並行処理の文脈からは、このキューの上で呼ぶ。
private let screenTextQueue = DispatchQueue(label: "live-mindmap.screen-text")

/// 画像に映った文字を、認識した行ごとに上から順に返す。日本語と英語を読む。認識に失敗したら nil。文字が無ければ空の配列。
/// OCR は `screenTextQueue` の上で行い、並行処理のスレッドを塞がない。
public func recognizeScreenText(_ image: CGImage) async -> [String]? {
    await recognizeScreenText(image, recognizer: sharedScreenTextRecognizer)
}

func recognizeScreenText(_ image: CGImage, recognizer: ScreenTextRecognizer) async -> [String]? {
    await withCheckedContinuation { continuation in
        screenTextQueue.async { continuation.resume(returning: recognizer.recognize(image)) }
    }
}

/// `recognizeScreenText` の同期の版。OCR が終わるまでスレッドを止めて待つので、並行処理のスレッドの上では呼ばない
/// （映像のキュー・画面収録のキューの上の `screenShot(of:)` から呼ぶ）。
@available(*, noasync, message: "並行処理のスレッドを塞ぐ。async の文脈からは recognizeScreenText を await する")
func recognizeScreenTextBlocking(_ image: CGImage, recognizer: ScreenTextRecognizer = sharedScreenTextRecognizer) -> [String]? {
    recognizer.recognize(image)
}

private func performScreenTextRecognition(_ image: CGImage) throws -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ja-JP", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}

private let sharedScreenTextRecognizer = ScreenTextRecognizer(
    attempt: performScreenTextRecognition,
    writeStderr: { FileHandle.standardError.write(Data($0.utf8)) }
)

final class ScreenTextRecognizer: @unchecked Sendable {
    private let lock = NSLock()
    private let attempt: (CGImage) throws -> [String]
    private let writeStderr: (String) -> Void
    private struct FailureCause: Equatable {
        let domain: String
        let code: Int

        init(_ error: NSError) {
            domain = error.domain
            code = error.code
        }
    }
    private var lastErrors: [FailureCause] = []
    private var failures = 0

    init(attempt: @escaping (CGImage) throws -> [String], writeStderr: @escaping (String) -> Void) {
        self.attempt = attempt
        self.writeStderr = writeStderr
    }

    func recognize(_ image: CGImage) -> [String]? {
        lock.withLock {
            do {
                let lines = try attempt(image)
                reset()
                return lines
            } catch {
                let first = error as NSError
                var causes = [FailureCause(first)]
                let result: [String]?
                let outcome: String
                do {
                    result = try attempt(image)
                    outcome = "やり直して読めた"
                } catch {
                    let second = error as NSError
                    causes.append(FailureCause(second))
                    result = nil
                    outcome = "やり直しても読めなかった（\(describe(second))）ので、lines は付けずに送る"
                }
                if lastErrors != causes {
                    lastErrors = causes
                    failures = 0
                }
                failures += 1
                if (failures - 1) % 10 == 0 {
                    writeStderr("screen: 画面の文字を読めなかった（\(describe(first))）。\(outcome)\n")
                }
                if result != nil { reset() }
                return result
            }
        }
    }

    private func reset() {
        lastErrors = []
        failures = 0
    }

    private func describe(_ error: NSError) -> String {
        "\(error.domain) \(error.code): \(error.localizedDescription)"
    }
}
