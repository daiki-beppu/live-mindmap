import AppKit
import CoreAudio

public enum CoreAudioError: Error, CustomStringConvertible {
    case status(String, OSStatus)

    public var description: String {
        switch self {
        case let .status(operation, status): return "\(operation) に失敗した（OSStatus \(status)）"
        }
    }
}

func audioAddress(
    _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
}

func audioProperty<T>(
    _ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, default initial: T
) throws -> T {
    var address = audioAddress(selector, scope: scope)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutableBytes(of: &value) { bytes in
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, bytes.baseAddress!)
    }
    guard status == noErr else { throw CoreAudioError.status("プロパティ \(selector) の取得", status) }
    return value
}

/// Core Audio のプロセスのオブジェクト ID の一覧。
private func processObjectIDs() throws -> [AudioObjectID] {
    var address = audioAddress(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    guard status == noErr else { throw CoreAudioError.status("プロセス一覧のサイズ取得", status) }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
    guard status == noErr else { throw CoreAudioError.status("プロセス一覧の取得", status) }
    return ids
}

private func bundleID(of process: AudioObjectID) -> String? {
    guard let bundleID = try? audioProperty(process, kAudioProcessPropertyBundleID, default: "" as CFString) as String,
          !bundleID.isEmpty
    else { return nil }
    return bundleID
}

/// Core Audio のプロセス一覧（bundle id を持つものだけ）。
public func currentAudioProcesses() throws -> [AudioProcess] {
    try processObjectIDs().compactMap { id in
        guard let bundleID = bundleID(of: id) else { return nil }
        let running = (try? audioProperty(id, kAudioProcessPropertyIsRunningOutput, default: UInt32(0))) ?? 0
        return AudioProcess(objectID: id, bundleID: bundleID, isRunningOutput: running != 0)
    }
}

/// 1 プロセス分の変換。bundle id が無ければ除外する（nil）。
/// pid が読めないプロセスは、helper 自身かどうか分からない。除外せず、入力の使用が読めない扱い（nil）にして「分からない」へ倒す。
func inputProcess(bundleID: String?, readPID: () -> pid_t?, readRunningInput: () -> UInt32?) -> InputProcess? {
    guard let bundleID else { return nil }
    guard let pid = readPID() else { return InputProcess(bundleID: bundleID, pid: -1, isRunningInput: nil) }
    return InputProcess(bundleID: bundleID, pid: pid, isRunningInput: readRunningInput().map { $0 != 0 })
}

/// Core Audio のプロセス一覧（bundle id を持つもの）と、それぞれが入力を使っているか（`IsRunningInput`）。
/// pid・入力の使用が読めないプロセスは `isRunningInput` を nil にする。一覧そのものが読めなければ throw する。
public func currentInputProcesses() throws -> [InputProcess] {
    try processObjectIDs().compactMap { id in
        inputProcess(
            bundleID: bundleID(of: id),
            readPID: { try? audioProperty(id, kAudioProcessPropertyPID, default: pid_t(0)) },
            readRunningInput: { try? audioProperty(id, kAudioProcessPropertyIsRunningInput, default: UInt32(0)) }
        )
    }
}

/// プロセス一覧の変化と、各プロセスの機器の変化の通知を受けて `onChange` を呼ぶ（Issue #1071）。
/// 一覧が変わったら、各プロセスへの登録を張り直す。通知は取りこぼしうるので、読み直しはポーリングと併用する。
public final class AudioInputObserver: @unchecked Sendable {
    private let queue = DispatchQueue(label: "live-mindmap.audio-input-observer")
    private let onChange: @Sendable () -> Void
    private var listListener: AudioObjectPropertyListenerBlock?
    private var processListener: AudioObjectPropertyListenerBlock?
    private var observed: Set<AudioObjectID> = []

    public init(onChange: @escaping @Sendable () -> Void) {
        self.onChange = onChange
    }

    public func start() {
        queue.sync {
            guard listListener == nil else { return }
            let processListener: AudioObjectPropertyListenerBlock = { [onChange] _, _ in onChange() }
            self.processListener = processListener
            let listListener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                self?.rebind()
                self?.onChange()
            }
            self.listListener = listListener
            var address = audioAddress(kAudioHardwarePropertyProcessObjectList)
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue, listListener)
            rebind()
        }
    }

    public func stop() {
        queue.sync {
            guard let listListener, let processListener else { return }
            var address = audioAddress(kAudioHardwarePropertyProcessObjectList)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue, listListener)
            var devices = audioAddress(kAudioProcessPropertyDevices)
            for id in observed { AudioObjectRemovePropertyListenerBlock(id, &devices, queue, processListener) }
            observed = []
            self.listListener = nil
            self.processListener = nil
        }
    }

    /// 呼ぶ側は `queue` の上にいる。一覧に合わせて、各プロセスの機器への登録を足し引きする。
    private func rebind() {
        guard let processListener else { return }
        let current = Set((try? processObjectIDs()) ?? [])
        var devices = audioAddress(kAudioProcessPropertyDevices)
        for id in observed.subtracting(current) { AudioObjectRemovePropertyListenerBlock(id, &devices, queue, processListener) }
        for id in current.subtracting(observed) { AudioObjectAddPropertyListenerBlock(id, &devices, queue, processListener) }
        observed = current
    }
}

/// 起動中の通常アプリ（Dock に出るもの）。
public func currentRunningApps() -> [RunningApp] {
    NSWorkspace.shared.runningApplications.compactMap { app in
        guard app.activationPolicy == .regular, let bundleID = app.bundleIdentifier else { return nil }
        return RunningApp(bundleID: bundleID, name: app.localizedName ?? bundleID)
    }
}
