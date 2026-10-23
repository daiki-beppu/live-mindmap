import CoreGraphics
import Foundation
import Testing
@testable import HelperCore

private final class RecognitionScript: @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [Result<[String], NSError>]
    private var inputs: [CGImage] = []
    private var diagnostics: [String] = []

    init(_ outcomes: [Result<[String], NSError>]) {
        self.outcomes = outcomes
    }

    func attempt(_ image: CGImage) throws -> [String] {
        try lock.withLock {
            inputs.append(image)
            return try outcomes.removeFirst().get()
        }
    }

    func write(_ line: String) {
        lock.withLock { diagnostics.append(line) }
    }

    var images: [CGImage] { lock.withLock { inputs } }
    var messages: [String] { lock.withLock { diagnostics } }
}

private func visionFailure(_ code: Int = 9, domain: String = "com.apple.Vision", description: String = "認識処理が失敗") -> NSError {
    NSError(domain: domain, code: code, userInfo: [NSLocalizedDescriptionKey: description])
}

private func inputImage() throws -> CGImage {
    let provider = try #require(CGDataProvider(data: Data([20, 40, 60, 255]) as CFData))
    return try #require(CGImage(
        width: 1, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
}

@Suite("画面 OCR の再試行と診断")
struct ScreenTextTests {
    @Test("再試行だけの domain・code の変更も通知して、その画像から数え直す", arguments: [false, true])
    func retryErrorChangeResetsThrottle(changeDomain: Bool) throws {
        let failures = (1...13).flatMap { index in
            let second = index == 1 ? visionFailure() : visionFailure(
                changeDomain ? 9 : 10, domain: changeDomain ? "OtherVision" : "com.apple.Vision",
                description: "再試行画像\(index)")
            return [Result<[String], NSError>.failure(visionFailure()), .failure(second)]
        }
        let script = RecognitionScript(failures)
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        let image = try inputImage()
        for index in 1...13 {
            #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil)
            if index == 2 { #expect(script.messages.count == 2) }
        }
        #expect(script.images.count == 26)
        #expect(script.messages.count == 3)
        for (line, index) in zip(script.messages.dropFirst(), [2, 12]) {
            #expect(line.contains("再試行画像\(index)"))
            #expect(line.contains(changeDomain ? "OtherVision 9" : "com.apple.Vision 10"))
            #expect(line.contains("やり直しても読めなかった"))
        }
    }

    @Test("初回成功は一度だけ読み、行も正常な空配列もそのまま返す", arguments: [["港南店"], []])
    func firstSuccess(lines: [String]) throws {
        let script = RecognitionScript([.success(lines)])
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        let result = recognizeScreenTextBlocking(try inputImage(), recognizer: reader)
        #expect(result == lines)
        #expect(script.images.count == 1)
        #expect(script.messages.isEmpty)
    }

    @Test("同じ画像を一度だけやり直し、回復した二回目の行を採用する")
    func retryRecovers() throws {
        let script = RecognitionScript([.failure(visionFailure()), .success(["二回目の行"])])
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        let image = try inputImage()
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == ["二回目の行"])
        #expect(script.images.count == 2)
        for input in script.images {
            #expect(input.width == image.width && input.height == image.height)
            #expect(input.dataProvider?.data == image.dataProvider?.data)
        }
        #expect(script.messages.count == 1)
        let message = try #require(script.messages.first)
        #expect(message.contains("com.apple.Vision"))
        #expect(message.contains("9"))
        #expect(message.contains("認識処理が失敗"))
        #expect(message.contains("やり直して読めた"))
    }

    @Test("二回失敗したら三回目を試さず nil を返し、両方の原因と最終失敗を知らせる")
    func retryStopsAfterTwoFailures() throws {
        let script = RecognitionScript([
            .failure(visionFailure()), .failure(visionFailure(10, description: "二回目も失敗")), .success(["三回目は読まない"]),
        ])
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        #expect(recognizeScreenTextBlocking(try inputImage(), recognizer: reader) == nil)
        #expect(script.images.count == 2)
        #expect(script.messages.count == 1)
        let message = try #require(script.messages.first)
        for part in ["com.apple.Vision", "9", "認識処理が失敗", "10", "二回目も失敗", "やり直しても読めなかった"] {
            #expect(message.contains(part))
        }
    }

    @Test("async の入口も一度だけやり直し、回復か最終失敗を返す", arguments: [true, false])
    func asyncRetries(recovers: Bool) async throws {
        let second: Result<[String], NSError> = recovers ? .success(["回復"]) : .failure(visionFailure())
        let script = RecognitionScript([.failure(visionFailure()), second])
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        let result = await recognizeScreenText(try inputImage(), recognizer: reader)
        #expect(result == (recovers ? ["回復"] : nil))
        #expect(script.images.count == 2)
    }

    @Test("同じ domain と code の25枚の失敗は1・11・21枚目だけ知らせる")
    func repeatedFailuresAreThrottled() throws {
        let failures = (1...25).flatMap { index in
            [Result<[String], NSError>.failure(visionFailure(description: "画像\(index)")), .failure(visionFailure())]
        }
        let script = RecognitionScript(failures)
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        let image = try inputImage()
        for _ in 1...25 { #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil) }
        #expect(script.images.count == 50)
        #expect(script.messages.count == 3)
        for (line, index) in zip(script.messages, [1, 11, 21]) {
            #expect(line.contains("画像\(index)"))
        }
    }

    @Test("同じ認識所有者へ並行に渡しても画像単位で再試行と間引きを行う")
    func concurrentFailuresAreThrottled() throws {
        let script = RecognitionScript(Array(repeating: .failure(visionFailure()), count: 50))
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        let image = try inputImage()
        DispatchQueue.concurrentPerform(iterations: 25) { _ in
            #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil)
        }
        #expect(script.images.count == 50)
        #expect(script.messages.count == 3)
    }

    @Test("成功または別の domain・code を挟むと同じ所有者の間引きを数え直す")
    func resetsAfterSuccessOrDifferentError() throws {
        let error = visionFailure()
        let script = RecognitionScript([
            .failure(error), .failure(error),
            .failure(error), .failure(error),
            .success([]),
            .failure(error), .failure(error),
            .failure(visionFailure(10)), .failure(error),
            .failure(visionFailure(10, domain: "OtherVision")), .failure(error),
        ])
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        let image = try inputImage()
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil)
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil)
        #expect(script.messages.count == 1)
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == [])
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil)
        #expect(script.messages.count == 2)
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil)
        #expect(script.messages.count == 3)
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil)
        #expect(script.messages.count == 4)
    }

    @Test("再試行で回復しても次の失敗は最初の一回として知らせる")
    func recoveryResetsThrottle() throws {
        let error = visionFailure()
        let script = RecognitionScript([.failure(error), .success([]), .failure(error), .failure(error)])
        let reader = ScreenTextRecognizer(attempt: script.attempt, writeStderr: script.write)
        let image = try inputImage()
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == [])
        #expect(recognizeScreenTextBlocking(image, recognizer: reader) == nil)
        #expect(script.messages.count == 2)
    }
}
