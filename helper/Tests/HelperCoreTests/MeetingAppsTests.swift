import Testing
import HelperCore

private func proc(_ id: UInt32, _ bundleID: String, output: Bool = true) -> AudioProcess {
    AudioProcess(objectID: id, bundleID: bundleID, isRunningOutput: output)
}

private let chrome = RunningApp(bundleID: "com.google.Chrome", name: "Google Chrome")
private let zoom = RunningApp(bundleID: "us.zoom.xos", name: "zoom.us")
private let textEdit = RunningApp(bundleID: "com.apple.TextEdit", name: "TextEdit")

@Suite("会議アプリの一覧")
struct MeetingAppListTests {
    @Test("音を出している helper はブラウザ本体にまとめ、Zoom と並べて 2 件になる")
    func groupsHelperUnderBrowser() {
        let apps = meetingApps(
            audioProcesses: [proc(1, "com.google.Chrome.helper"), proc(2, "us.zoom.xos")],
            runningApps: [chrome, zoom, textEdit]
        )
        #expect(apps.map(\.bundleID).sorted() == ["com.google.Chrome", "us.zoom.xos"])
        #expect(apps.first { $0.bundleID == "com.google.Chrome" }?.name == "Google Chrome")
        #expect(apps.first { $0.bundleID == "us.zoom.xos" }?.name == "zoom.us")
    }

    @Test("同じアプリの複数プロセスは 1 件にまとまる")
    func deduplicatesProcessesOfOneApp() {
        let apps = meetingApps(
            audioProcesses: [proc(1, "com.google.Chrome"), proc(2, "com.google.Chrome.helper"), proc(3, "com.google.Chrome.helper.Renderer")],
            runningApps: [chrome]
        )
        #expect(apps.map(\.bundleID) == ["com.google.Chrome"])
    }

    @Test("音を出していないアプリは並べない")
    func excludesSilentApps() {
        let apps = meetingApps(
            audioProcesses: [proc(1, "us.zoom.xos", output: false), proc(2, "com.google.Chrome.helper")],
            runningApps: [chrome, zoom]
        )
        #expect(apps.map(\.bundleID) == ["com.google.Chrome"])
    }

    @Test("起動中のアプリに対応しない音声プロセスは並べない")
    func excludesProcessesWithoutRunningApp() {
        let apps = meetingApps(
            audioProcesses: [proc(1, "com.apple.audio.SystemSoundServer"), proc(2, "us.zoom.xos")],
            runningApps: [zoom]
        )
        #expect(apps.map(\.bundleID) == ["us.zoom.xos"])
    }

    @Test("bundle id の前方一致は . の境界で判定する（Chrome Canary の helper は Chrome にならない）")
    func prefixMatchRespectsBoundary() {
        let apps = meetingApps(
            audioProcesses: [proc(1, "com.google.ChromeCanary.helper")],
            runningApps: [chrome]
        )
        #expect(apps.isEmpty)
    }

    @Test("音を出しているプロセスがなければ空")
    func emptyWhenNothingPlays() {
        #expect(meetingApps(audioProcesses: [], runningApps: [chrome, zoom, textEdit]).isEmpty)
    }
}

@Suite("プロセスタップの対象")
struct TapTargetTests {
    @Test("Zoom は us.zoom.xos のプロセスだけが対象になる")
    func zoomTargetsOnlyZoom() throws {
        let targets = try tapTargets(
            forApp: "us.zoom.xos",
            in: [proc(1, "us.zoom.xos"), proc(2, "com.google.Chrome.helper"), proc(3, "com.apple.Music")]
        )
        #expect(targets.map(\.objectID) == [1])
    }

    @Test("ブラウザは本体と helper の両方が対象になり、ほかのアプリは含まれない")
    func browserTargetsWholeBrowser() throws {
        let targets = try tapTargets(
            forApp: "com.google.Chrome",
            in: [
                proc(1, "com.google.Chrome", output: false),
                proc(2, "com.google.Chrome.helper"),
                proc(3, "com.google.Chrome.helper.Renderer"),
                proc(4, "com.apple.Music"),
                proc(5, "com.google.ChromeCanary.helper"),
            ]
        )
        #expect(targets.map(\.objectID).sorted() == [1, 2, 3])
    }

    @Test("合うプロセスが 0 件のときは全プロセスへ広げず、エラーで失敗する")
    func noMatchFailsInsteadOfFallingBackToEverything() {
        #expect(throws: MeetingAppError.noMatchingProcess(bundleID: "us.zoom.xos")) {
            try tapTargets(forApp: "us.zoom.xos", in: [proc(1, "com.google.Chrome.helper"), proc(2, "com.apple.Music")])
        }
    }

    @Test("音声プロセスがないときもエラーで失敗する")
    func noProcessesFails() {
        #expect(throws: MeetingAppError.noMatchingProcess(bundleID: "com.google.Chrome")) {
            try tapTargets(forApp: "com.google.Chrome", in: [])
        }
    }
}
