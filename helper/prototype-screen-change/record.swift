// PROTOTYPE（使い捨て、issue #252）: 選んだアプリのウィンドウを ScreenCaptureKit で取り込み、
// フレームごとの状態・dirtyRects・縮小した輝度（128×72）・サムネイルと、1 秒ごとのウィンドウのタイトルを記録する。
// 使い方: swiftc -O record.swift -o record && ./record <bundle id> <出力先> <秒> [fps=4] [タイトルに含む語]
import AppKit
import CoreImage
import ScreenCaptureKit

let args = CommandLine.arguments
guard args.count >= 4 else { print("usage: record <bundle id> <out dir> <seconds> [fps]"); exit(2) }
let bundleID = args[1], outDir = URL(fileURLWithPath: args[2]), seconds = Double(args[3])!
let fps = args.count > 4 ? Double(args[4])! : 4
let titleHas = args.count > 5 ? args[5] : "" // 候補が多いとき、タイトルで選ぶ（試作だけの都合）
try FileManager.default.createDirectory(at: outDir.appendingPathComponent("thumbs"), withIntermediateDirectories: true)
FileManager.default.createFile(atPath: outDir.appendingPathComponent("frames.jsonl").path, contents: nil)
let log = try FileHandle(forWritingTo: outDir.appendingPathComponent("frames.jsonl"))
let lock = NSLock()
func write(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    lock.lock(); log.write(data); log.write("\n".data(using: .utf8)!); lock.unlock()
}
func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

let SW = 128, SH = 72
let ci = CIContext()
let gray = CGColorSpaceCreateDeviceGray()

final class Out: NSObject, SCStreamOutput {
    var n = 0
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let info = attachments.first,
              let raw = info[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return }
        var rec: [String: Any] = ["t": nowMs(), "status": ["complete", "idle", "blank", "suspended", "started", "stopped"][status.rawValue]]
        guard status == .complete, let px = CMSampleBufferGetImageBuffer(sb) else { write(rec); return }
        let w = Double(CVPixelBufferGetWidth(px)), h = Double(CVPixelBufferGetHeight(px))
        let dirty = (info[.dirtyRects] as? [NSDictionary] ?? []).compactMap { CGRect(dictionaryRepresentation: $0) }
        rec["dirty"] = dirty.map { [$0.minX / w, $0.minY / h, $0.width / w, $0.height / h] }
        rec["size"] = [w, h]
        let img = CIImage(cvPixelBuffer: px)
        // 64×36 の輝度（平均で縮める）
        var buf = [UInt8](repeating: 0, count: SW * SH)
        ci.render(img.applyingFilter("CILanczosScaleTransform", parameters: ["inputScale": Double(SH) / h, "inputAspectRatio": (Double(SW) / w) / (Double(SH) / h)]),
                  toBitmap: &buf, rowBytes: SW, bounds: CGRect(x: 0, y: 0, width: SW, height: SH), format: .L8, colorSpace: gray)
        rec["sig"] = Data(buf).base64EncodedString()
        n += 1
        let name = String(format: "%05d.jpg", n)
        rec["thumb"] = "thumbs/" + name
        let thumb = img.transformed(by: CGAffineTransform(scaleX: 320 / w, y: 320 / w))
        try? ci.writeJPEGRepresentation(of: thumb, to: outDir.appendingPathComponent("thumbs/" + name), colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6])
        write(rec)
    }
}

let out = Out()
let sem = DispatchSemaphore(value: 0)
Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let wins = content.windows.filter { $0.owningApplication?.bundleIdentifier == bundleID && $0.title?.isEmpty == false && (titleHas.isEmpty || $0.title!.contains(titleHas)) }
        guard let win = wins.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { print("no window"); exit(1) }
        print("window", win.windowID, win.title ?? "", win.frame)
        let cfg = SCStreamConfiguration()
        cfg.width = Int(win.frame.width); cfg.height = Int(win.frame.height) // 論理ピクセル（Retina の半分）
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.showsCursor = false
        cfg.queueDepth = 5
        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: win), configuration: cfg, delegate: nil)
        try stream.addStreamOutput(out, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
        try await stream.startCapture()
        write(["t": nowMs(), "event": "start", "window": win.windowID])
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            // タイトルは前面のタブのもの。1 秒ごとに取り直す
            let c = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            let w = c.windows.first { $0.windowID == win.windowID }
            write(["t": nowMs(), "event": "title", "title": w?.title ?? "", "onScreen": w?.isOnScreen ?? false])
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        try await stream.stopCapture()
        print("frames", out.n)
    } catch { print("ERR", error) }
    sem.signal()
}
sem.wait()
