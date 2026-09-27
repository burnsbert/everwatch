import AppKit
import WebKit

/// Last-resort deadline that doesn't depend on the main thread: if the run
/// hasn't exited `seconds` after launch, it kills the current backend, prints
/// a failing report, and `_exit`s.
final class SelfTestWatchdog: @unchecked Sendable {
    private let lock = NSLock()
    private var pid: Int32 = 0

    func setPID(_ value: Int32) {
        lock.lock(); pid = value; lock.unlock()
    }

    func currentPID() -> Int32 {
        lock.lock(); defer { lock.unlock() }
        return pid
    }

    func arm(after seconds: TimeInterval) {
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { [self] in
            let p = currentPID()
            if p > 0 { kill(p, SIGKILL) }
            let line = "{\"checks\":[],\"failure\":\"watchdog: main thread unresponsive\",\"ok\":false}\n"
            FileHandle.standardOutput.write(Data(line.utf8))
            _exit(3)
        }
    }
}

/// Headless runtime self-test (EVERWATCH_SELFTEST=1; see SelfTest.swift and
/// scripts/shell_selftest.sh). Drives the real BackendSupervisor,
/// NativeSSEClient and WebContainer (token user script, bridge, origin
/// checks) against a `--demo --selftest` backend, then prints one JSON report
/// line on stdout and exits 0 (pass) or non-zero.
///
/// Nothing here is ever visible: activation is `.prohibited` (set in
/// main.swift before this exists), the two page hosts (a SilentWindow and a
/// SilentPanel) are borderless, alpha 0, far off-screen, and never ordered
/// in; no key event is ever synthesized; there is no main menu, status
/// item, Dock tile change, hotkey, notification center, Automation probe,
/// sound, or NSWorkspace call. Bridge messages that would do any of those are
/// recorded and dropped.
@MainActor
final class SelfTestRunner: NSObject, NSApplicationDelegate, WebHost {
    private enum Failure: Error, CustomStringConvertible {
        case timeout(String)
        case backend(String)
        case unexpected(String)

        var description: String {
            switch self {
            case .timeout(let what): return "timed out waiting for \(what)"
            case .backend(let what): return "backend failed: \(what)"
            case .unexpected(let what): return what
            }
        }
    }

    private let rawEnvironment: [String: String]
    private let token: String
    private let startedAt = ProcessInfo.processInfo.systemUptime
    private let watchdog = SelfTestWatchdog()
    private var report = SelfTestReport()
    private var step = "launch"
    private var finished = false
    private var activity: NSObjectProtocol?
    private var visibilityTimer: Timer?

    private var supervisor: BackendSupervisor!
    private var sse: NativeSSEClient!
    private var mainWeb: WebContainer!
    private var probeWeb: WebContainer!
    private var hiddenWindow: SilentWindow!
    private var hiddenPanel: SilentPanel!
    private lazy var http = URLSession(configuration: .ephemeral)
    private(set) var webPolicy = WebPolicy(port: nil)

    // Everything observed, in order, with systemUptime timestamps.
    private var readyEvents: [(port: Int, at: TimeInterval)] = []
    private var failedEvent: String?
    private var spawns: [(pid: Int32, at: TimeInterval)] = []
    private var exits: [(status: Int32, decision: RestartPolicy.Decision, at: TimeInterval)] = []
    private var bridgeReady: [(port: Int?, at: TimeInterval)] = []
    private var appearances: [Theme] = []
    private var droppedBridge: [String] = []
    private var foreignBridge: [String] = []
    private var sseEvents: [ShellEvent] = []
    private var visibilityViolations: [String] = []
    private var externalOpens: [String] = []
    private var retryRequests = 0
    private var onboardingPatches: [Int] = []
    private var policyTransitions: [String] = []
    private var lastPolicy = NSApplication.ActivationPolicy.prohibited
    private var policyTimer: Timer?

    init(environment: [String: String]) {
        rawEnvironment = environment
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        token = NativeScript.base64url(bytes)
        super.init()
    }

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
    private var elapsed: TimeInterval { now - startedAt }
    private static func secs(_ t: TimeInterval) -> String { String(format: "%.2fs", t) }

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Keep timers and the run loop at full speed (no App Nap) while hidden.
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep],
                                                         reason: "Everwatch self-test")
        let config: SelfTestConfig
        switch SelfTestConfig.make(environment: rawEnvironment, userHome: NSHomeDirectory()) {
        case .failure(let problem):
            report.failure = "config: \(problem)"
            Task { await finish() }
            return
        case .success(let c):
            config = c
        }
        report.note("timeout_s", config.timeout)
        watchdog.arm(after: config.timeout + 5)
        DispatchQueue.main.asyncAfter(deadline: .now() + config.timeout) { [weak self] in
            MainActor.assumeIsolated { self?.timedOut(after: config.timeout) }
        }
        startVisibilityMonitor()
        build(config)
        Task { await run() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func build(_ config: SelfTestConfig) {
        supervisor = BackendSupervisor(token: token, environment: config.environment,
                                       extraArguments: SelfTestConfig.backendArguments)
        sse = NativeSSEClient(token: token)
        mainWeb = WebContainer(token: token, compact: false, host: self)
        probeWeb = WebContainer(token: token, compact: true, host: self)

        // Gives the page a realistic viewport. Borderless, transparent,
        // off-screen, and never ordered in (defer: true means the window
        // server never even gets a window).
        hiddenWindow = SilentWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1180, height: 760),
                                    styleMask: [.borderless], backing: .buffered, defer: true)
        hiddenWindow.isReleasedWhenClosed = false
        hiddenWindow.alphaValue = 0
        hiddenWindow.ignoresMouseEvents = true
        hiddenWindow.isExcludedFromWindowsMenu = true
        hiddenWindow.collectionBehavior = [.transient, .ignoresCycle]
        hiddenWindow.contentView = mainWeb.webView

        // The compact page's host: the same SilentPanel class as
        // CompactPanelController, and just as hidden as the window above.
        // Only the silent_responder_chain check looks at it.
        hiddenPanel = SilentPanel(contentRect: NSRect(x: -20000, y: -20000, width: 320, height: 480),
                                  styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        hiddenPanel.isReleasedWhenClosed = false
        hiddenPanel.alphaValue = 0
        hiddenPanel.ignoresMouseEvents = true
        hiddenPanel.isExcludedFromWindowsMenu = true
        hiddenPanel.hidesOnDeactivate = false
        hiddenPanel.collectionBehavior = [.transient, .ignoresCycle]
        hiddenPanel.contentView = probeWeb.webView

        sse.onEvent = { [weak self] event in self?.sseEvents.append(event) }
        supervisor.onEvent = { [weak self] event in self?.handleSupervisor(event) }
        supervisor.onSpawn = { [weak self] pid in
            guard let self else { return }
            self.spawns.append((pid, self.now))
            self.watchdog.setPID(pid)
        }
        supervisor.onExit = { [weak self] status, decision in
            guard let self else { return }
            self.exits.append((status, decision, self.now))
            self.watchdog.setPID(0)
        }
    }

    private func startVisibilityMonitor() {
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sampleVisibility() }
        }
        RunLoop.main.add(timer, forMode: .common)
        visibilityTimer = timer
        let fast = Timer(timeInterval: 0.002, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.policyTransitions.count < 40 else { return }
                let p = NSApp.activationPolicy()
                if p != self.lastPolicy {
                    self.policyTransitions.append("\(self.lastPolicy.rawValue)->\(p.rawValue) at \(String(format: "%.3f", self.elapsed)) (\(self.step))")
                    self.lastPolicy = p
                }
            }
        }
        RunLoop.main.add(fast, forMode: .common)
        policyTimer = fast
    }

    private func sampleVisibility() {
        guard visibilityViolations.count < 20 else { return }
        for window in NSApp.windows where window.isVisible || window.occlusionState.contains(.visible) {
            visibilityViolations.append("visible window \(type(of: window)) at \(Self.secs(elapsed))")
        }
        if NSApp.isActive { visibilityViolations.append("app became active at \(Self.secs(elapsed))") }
        // Only .regular gets a Dock icon / menu bar. AppKit reads back
        // .accessory for 2-6 ms around child-process and WebContent launches
        // (policy_transitions in the report); that has no on-screen effect.
        if NSApp.activationPolicy() == .regular {
            visibilityViolations.append("activation policy became regular at \(Self.secs(elapsed))")
        }
    }

    private func timedOut(after timeout: TimeInterval) {
        guard !finished else { return }
        report.failure = "timeout: no result within \(Int(timeout)) s (step: \(step))"
        Task { await finish() }
    }

    private func run() async {
        do {
            try await steps()
        } catch {
            if report.failure == nil { report.failure = "\(step): \(error)" }
        }
        await finish()
    }

    private func finish() async {
        guard !finished else { return }
        finished = true
        visibilityTimer?.invalidate()
        policyTimer?.invalidate()
        if let supervisor, let pid = supervisor.pid {
            sse?.disconnect()
            supervisor.stop()
            if !(await waitForExit(pid: pid, timeout: 4)) { kill(pid, SIGKILL) }
        }
        report.note("spawned_pids", spawns.map { Int($0.pid) })
        report.note("exit_statuses", exits.map { Int($0.status) })
        report.note("dropped_bridge_messages", droppedBridge)
        report.note("onboarding_patch_statuses", onboardingPatches)
        report.note("policy_transitions", policyTransitions)
        report.note("appearances_from_page", appearances.map(\.rawValue))
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        FileHandle.standardOutput.write(Data((report.json(elapsed: elapsed) + "\n").utf8))
        exit(report.exitCode)
    }

    // MARK: Steps

    private func steps() async throws {
        report.check("activation_policy_prohibited", NSApp.activationPolicy() == .prohibited,
                     "activationPolicy raw value \(NSApp.activationPolicy().rawValue)")
        report.note("bundle_identifier", Bundle.main.bundleIdentifier ?? "")
        report.note("ls_ui_element", (Bundle.main.object(forInfoDictionaryKey: "LSUIElement") as? Bool) ?? false)
        report.note("ls_background_only", (Bundle.main.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool) ?? false)

        // 1. Spawn + handshake.
        step = "handshake"
        supervisor.start()
        let port = try await waitForReady(after: 0, timeout: 20)
        report.check("handshake", port > 0, "EVERWATCH_READY \(port) after \(Self.secs(elapsed)), pid \(supervisor.pid ?? 0)")
        report.note("port_initial", port)

        // 2. Page loads with the token script and posts `ready`; native SSE says hello.
        step = "bridge_ready"
        try await waitForBridgeReady(port: port, after: 0)
        report.check("bridge_ready", true, "ready from http://127.0.0.1:\(port)/ at \(Self.secs(elapsed))")

        step = "native_sse_hello"
        let hello = try await waitForHello(after: 0)
        report.check("native_sse_hello", !hello.sessions.isEmpty,
                     "hello rev \(hello.rev), \(hello.sessions.count) sessions, \(hello.waitingCount) waiting, version \(hello.version ?? "?")")

        step = "status_title"
        let display = StatusTitle.menuBar(waiting: hello.waitingCount, connected: sse.connected)
        report.check("status_title",
                     hello.waitingCount > 0 && display.text == "\(StatusTitle.waitingGlyph) \(hello.waitingCount)" && display.attention,
                     "menu bar title \"\(display.text)\" (connected \(sse.connected), attention \(display.attention))")

        // 3. What the page itself sees.
        step = "page_checks"
        let page = try await js(mainWeb.webView, SelfTestScripts.pageChecks, ["token": token])
        report.note("page", page)
        let tokenOK = (page["tokenMatches"] as? Bool) == true && (page["shell"] as? Bool) == true
            && (page["tokenInURL"] as? Bool) == false && (page["hasHandler"] as? Bool) == true
            && (page["dispatchInstalled"] as? Bool) == true
        report.check("page_token_injected", tokenOK,
                     "everwatchNative.shell \(page["shell"] ?? "nil"), token matches \(page["tokenMatches"] ?? "nil"), in URL \(page["tokenInURL"] ?? "nil"), page dispatch installed \(page["dispatchInstalled"] ?? "nil")")
        let rows = (page["rows"] as? Int) ?? 0
        report.check("page_rendered_sessions", (page["bodyReady"] as? Bool) == true && rows > 0,
                     "\(rows) session rows, body ready \(page["bodyReady"] ?? "nil"), visibility \(page["visibility"] ?? "nil")")
        let good = (page["apiGood"] as? Int) ?? 0, bad = (page["apiBad"] as? Int) ?? 0
        report.check("page_api_token_auth", good == 200 && (bad == 401 || bad == 403) && ((page["apiSessions"] as? Int) ?? 0) > 0,
                     "GET /api/state with token \(good), wrong token \(bad)")
        report.check("page_sse_token_auth", (page["sseHello"] as? String) == "hello" && (page["sseBad"] as? String) == "error",
                     "page EventSource with token: \(page["sseHello"] ?? "nil"), wrong token: \(page["sseBad"] ?? "nil")")
        let expectedTitle = StatusTitle.windowTitle(waiting: hello.waitingCount)
        report.check("page_title_matches_native", (page["title"] as? String) == expectedTitle,
                     "page \"\(page["title"] ?? "nil")\", native \"\(expectedTitle)\"")

        // 4. A pref change goes through the authenticated API and comes back as a `state` event.
        step = "native_state_event"
        let sseIndex = sseEvents.count
        let (patchStatus, _) = try await api("PATCH", "/api/prefs", ["theme": "dark"], port: port)
        let changed = try await waitUntil("a state event with theme dark", timeout: 5) { () -> ShellState? in
            for event in sseEvents[sseIndex...] {
                if case .state(let s) = event, s.prefs.theme == .dark { return s }
            }
            return nil
        }
        let changedTitle = StatusTitle.menuBar(waiting: changed.waitingCount, connected: sse.connected).text
        report.check("native_state_event", patchStatus == 200,
                     "PATCH /api/prefs \(patchStatus) → state rev \(changed.rev), theme \(changed.prefs.theme.rawValue), title \"\(changedTitle)\"")

        // 5. Bridge, web → shell.
        step = "bridge_web_to_shell"
        let appearanceIndex = appearances.count
        _ = try await js(mainWeb.webView, SelfTestScripts.postAppearance, ["theme": "light"])
        // The page may post its own appearance (it follows prefs.theme), so look for ours.
        let light = try await waitUntil("appearance{light} message", timeout: 3) { () -> Theme? in
            appearances[appearanceIndex...].contains(.light) ? .light : nil
        }
        report.check("bridge_web_to_shell", light == .light && NSApp.appearance?.name == .aqua,
                     "appearance{theme:light} handled, NSApp.appearance \(NSApp.appearance?.name.rawValue ?? "system"); page-posted themes \(appearances.map(\.rawValue))")

        // 6. Bridge, shell → web, through the real OutboundBridgeMessage script.
        step = "bridge_shell_to_web"
        _ = try await js(mainWeb.webView, SelfTestScripts.wrapDispatch)
        mainWeb.dispatch(.nativeStatus(NativeStatus(automation: .unknown, notifications: .unknown,
                                                    hotkeys: ["show": "disabled", "next": "disabled"])))
        let inbox = try await waitUntilAsync("nativeStatus in the page", timeout: 3) { () -> [String: Any]? in
            let result = try await self.js(self.mainWeb.webView, SelfTestScripts.readInbox)
            let messages = (result["messages"] as? [[String: Any]]) ?? []
            return messages.first { ($0["type"] as? String) == "nativeStatus" }
        }
        report.check("bridge_shell_to_web", (inbox["automation"] as? String) == "unknown",
                     "page dispatch received nativeStatus \(JSONText.encode(inbox))")

        // 7. A page that isn't the backend's origin can't drive the shell.
        step = "bridge_rejects_foreign_origin"
        probeWeb.loadLocal(.starting)
        let probe = try await waitUntilAsync("local page load", timeout: 5) { () -> [String: Any]? in
            let r = try await self.js(self.probeWeb.webView, SelfTestScripts.localPageLoaded)
            return (r["loaded"] as? Bool) == true ? r : nil
        }
        let posted = try await js(probeWeb.webView, SelfTestScripts.postFromForeignPage)
        let foreignAppearanceIndex = appearances.count
        try await Task.sleep(nanoseconds: 1_000_000_000)
        report.check("bridge_rejects_foreign_origin",
                     (posted["posted"] as? Bool) == true && foreignBridge.isEmpty && appearances.count == foreignAppearanceIndex,
                     "posted ready+appearance from origin \"\(probe["origin"] ?? "?")\": accepted \(foreignBridge.count)")

        // 8. Crash → backoff restart.
        step = "restart_after_crash"
        let crash = try await restart(expectStatus: nil, expectDelay: 1, port: port) { pid in
            kill(pid, SIGKILL)
        }
        report.check("restart_after_crash",
                     crash.exit.decision == .restart(after: 1) && crash.delay >= 0.9 && crash.newPID != crash.oldPID
                        && supervisor.crashCount == 1,
                     "SIGKILL pid \(crash.oldPID): status \(crash.exit.status), \(crash.exit.decision), respawned pid \(crash.newPID) after \(Self.secs(crash.delay)), port \(crash.port), crashes in window \(supervisor.crashCount)")
        step = "reconnect_after_crash"
        let crashReconnected = try await reconnected(port: crash.port, bridgeIndex: crash.bridgeIndex, sseIndex: crash.sseIndex)
        report.check("reconnect_after_crash", crashReconnected, "page ready + native hello + rows on port \(crash.port)")

        // 9. Requested restart (exit 75) → immediate, not counted as a crash.
        step = "restart_after_tempfail"
        var installStatus = 0
        let temp = try await restart(expectStatus: BackendExitCode.tempFail, expectDelay: 0, port: crash.port) { _ in
            installStatus = (try? await self.api("POST", "/api/colors/install", [:], port: crash.port))?.0 ?? -1
        }
        report.check("restart_after_tempfail",
                     installStatus == 200 && temp.exit.status == BackendExitCode.tempFail && temp.exit.decision == .restart(after: 0)
                        && temp.delay < 0.5 && supervisor.crashCount == 1,
                     "POST /api/colors/install \(installStatus) → exit \(temp.exit.status), \(temp.exit.decision), respawned pid \(temp.newPID) after \(Self.secs(temp.delay)), port \(temp.port), crashes in window \(supervisor.crashCount)")
        step = "reconnect_after_tempfail"
        let tempReconnected = try await reconnected(port: temp.port, bridgeIndex: temp.bridgeIndex, sseIndex: temp.sseIndex)
        report.check("reconnect_after_tempfail", tempReconnected, "page ready + native hello + rows on port \(temp.port)")

        // 10. Quit: the backend goes away and isn't restarted.
        step = "clean_shutdown"
        guard let lastPID = supervisor.pid else { throw Failure.unexpected("no backend running before shutdown") }
        let spawnCount = spawns.count
        sse.disconnect()
        supervisor.stop()
        let gone = await waitForExit(pid: lastPID, timeout: 5)
        try await Task.sleep(nanoseconds: 300_000_000)
        report.check("clean_shutdown", gone && spawns.count == spawnCount && supervisor.pid == nil,
                     "pid \(lastPID) exited \(gone), respawns after stop \(spawns.count - spawnCount)")

        step = "silent_responder_chain"
        checkSilentResponderChain()

        step = "never_visible"
        sampleVisibility()
        report.check("never_visible",
                     visibilityViolations.isEmpty && externalOpens.isEmpty && retryRequests == 0,
                     visibilityViolations.isEmpty && externalOpens.isEmpty
                        ? "no visible window, never active, never a regular (Dock) app, nothing opened externally; \(policyTransitions.count / 2) transient accessory read-backs"
                        : (visibilityViolations + externalOpens.map { "external open \($0)" }).joined(separator: "; "))
    }

    /// Proves that a key left unhandled can't beep, by inspection only. No
    /// key event is synthesized, and AppKit's original noResponderFor:
    /// (which beeps for keyDown:) is never invoked: each receiver is called
    /// directly only after the IMP it dispatches to has been shown to be one
    /// of Everwatch's silent ones, none of which call the original.
    ///
    /// Layer 1: the Silent* subclasses end every web view's chain and
    /// override the method. Layer 2: NSResponder's own implementation has
    /// been replaced process-wide, so stock windows (About panel) are silent
    /// too.
    private func checkSilentResponderChain() {
        let selector = SilentResponders.selector
        let base: AnyClass = NSResponder.self
        func silent(_ cls: AnyClass) -> Bool { MethodOverride.isOverridden(selector, in: cls, below: base) }
        func name(_ cls: AnyClass) -> String { NSStringFromClass(cls) }
        func imp(_ cls: AnyClass) -> IMP? { class_getInstanceMethod(cls, selector).map(method_getImplementation) }
        let keyDown = UnhandledEventPolicy.beepingSelector
        func dropCount(_ receivers: [NSResponder]) -> Int {
            let before = UnhandledEventLog.shared.count(keyDown)
            for r in receivers { r.noResponder(for: #selector(NSResponder.keyDown(with:))) }
            return UnhandledEventLog.shared.count(keyDown) - before
        }

        // Layer 1.
        let classes = SilentResponders.classes.map { (name($0), silent($0)) }
        let mainChain = SilentResponders.chain(from: mainWeb.webView)
        let panelChain = SilentResponders.chain(from: probeWeb.webView)
        let mainSilent = MethodOverride.chainEndIsSilent(mainChain, selector: selector, base: base)
        let panelSilent = MethodOverride.chainEndIsSilent(panelChain, selector: selector, base: base)
        let mainEndsAtWindow = mainChain.last.map { $0 == object_getClass(hiddenWindow) } ?? false
        let panelEndsAtPanel = panelChain.last.map { $0 == object_getClass(hiddenPanel) } ?? false
        report.note("responder_chain_main", mainChain.map(name))
        report.note("responder_chain_panel", panelChain.map(name))
        report.note("unhandled_events_before_direct_calls", UnhandledEventLog.shared.total)

        let receivers: [NSResponder] = [NSApp, hiddenWindow, hiddenPanel]
        let receiversSilent = receivers.map { r -> (String, Bool) in
            let cls: AnyClass = object_getClass(r) ?? type(of: r)
            return (name(cls), silent(cls))
        }
        let subclassesProven = classes.allSatisfy(\.1) && receiversSilent.allSatisfy(\.1) && mainSilent && panelSilent
        let subclassDrops = subclassesProven ? dropCount(receivers) : 0

        // Layer 2.
        let patch = SilentResponders.processWide
        let silentIMP = patch.silentIMP
        let responderIMP = imp(NSResponder.self)
        let stockClasses: [AnyClass] = [NSResponder.self, NSWindow.self, NSPanel.self, NSApplication.self]
        let stockSilent = stockClasses.map { cls -> (String, Bool) in
            (name(cls), silentIMP != nil && imp(cls) == silentIMP)
        }
        let stock = NSResponder()
        let stockInstanceSilent = silentIMP != nil && object_getClass(stock).flatMap(imp) == silentIMP
        let globalProven = patch.isInstalled && silentIMP != nil && responderIMP == silentIMP
            && patch.replacedIMP != nil && patch.replacedIMP != silentIMP
            && stockSilent.allSatisfy(\.1) && stockInstanceSilent
        let stockDrops = globalProven ? dropCount([stock]) : 0

        report.check("silent_responder_chain",
                     subclassesProven && mainEndsAtWindow && panelEndsAtPanel && subclassDrops == receivers.count
                        && globalProven && stockDrops == 1,
                     "layer 1, overrides noResponder(for:): \((classes + receiversSilent).map { "\($0.0) \($0.1)" }.joined(separator: ", ")); "
                        + "main chain ends at \(mainChain.last.map(name) ?? "nil") (silent \(mainSilent)), "
                        + "panel chain ends at \(panelChain.last.map(name) ?? "nil") (silent \(panelSilent)); "
                        + "direct keyDown: calls dropped \(subclassDrops)/\(receivers.count)"
                        + (subclassesProven ? "" : " (not called: override not proven)")
                        + ". layer 2, process-wide: installed \(patch.isInstalled), NSResponder IMP is the silent one \(responderIMP == silentIMP && silentIMP != nil), "
                        + "replaced a different IMP \(patch.replacedIMP != nil && patch.replacedIMP != silentIMP); "
                        + "dispatch to silent IMP: \(stockSilent.map { "\($0.0) \($0.1)" }.joined(separator: ", ")); "
                        + "direct keyDown: call on a stock NSResponder dropped \(stockDrops)/1"
                        + (globalProven ? "" : " (not called: process-wide patch not proven)"))
    }

    private struct RestartResult {
        let oldPID: Int32
        let newPID: Int32
        let exit: (status: Int32, decision: RestartPolicy.Decision, at: TimeInterval)
        let delay: TimeInterval
        let port: Int
        let bridgeIndex: Int
        let sseIndex: Int
    }

    /// Triggers an exit of the current backend and waits for its replacement's handshake.
    private func restart(expectStatus: Int32?, expectDelay: TimeInterval, port: Int,
                         trigger: (Int32) async -> Void) async throws -> RestartResult {
        guard let oldPID = supervisor.pid else { throw Failure.unexpected("no backend pid") }
        let exitIndex = exits.count, readyIndex = readyEvents.count, spawnIndex = spawns.count
        let bridgeIndex = bridgeReady.count, sseIndex = sseEvents.count
        await trigger(oldPID)
        let exit = try await waitUntil("backend exit", timeout: 10) { exits.count > exitIndex ? exits[exitIndex] : nil }
        let newPort = try await waitForReady(after: readyIndex, timeout: 20)
        guard spawns.count > spawnIndex else { throw Failure.unexpected("ready without a spawn") }
        let spawn = spawns[spawnIndex]
        return RestartResult(oldPID: oldPID, newPID: spawn.pid, exit: exit, delay: spawn.at - exit.at,
                             port: newPort, bridgeIndex: bridgeIndex, sseIndex: sseIndex)
    }

    private func reconnected(port: Int, bridgeIndex: Int, sseIndex: Int) async throws -> Bool {
        try await waitForBridgeReady(port: port, after: bridgeIndex)
        let hello = try await waitForHello(after: sseIndex)
        let rows = try await js(mainWeb.webView, SelfTestScripts.rowCount)
        return !hello.sessions.isEmpty && ((rows["rows"] as? Int) ?? 0) > 0
    }

    // MARK: Waiting

    private func waitUntil<T>(_ what: String, timeout: TimeInterval, _ probe: () -> T?) async throws -> T {
        let deadline = now + timeout
        while true {
            if let value = probe() { return value }
            if let failedEvent { throw Failure.backend(failedEvent) }
            if now > deadline { throw Failure.timeout(what) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func waitUntilAsync<T>(_ what: String, timeout: TimeInterval, _ probe: () async throws -> T?) async throws -> T {
        let deadline = now + timeout
        while true {
            if let value = try await probe() { return value }
            if now > deadline { throw Failure.timeout(what) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func waitForReady(after index: Int, timeout: TimeInterval) async throws -> Int {
        try await waitUntil("EVERWATCH_READY handshake", timeout: timeout) {
            readyEvents.count > index ? readyEvents[index].port : nil
        }
    }

    private func waitForBridgeReady(port: Int, after index: Int) async throws {
        _ = try await waitUntil("bridge ready from port \(port)", timeout: 10) { () -> Bool? in
            bridgeReady[index...].contains { $0.port == port } ? true : nil
        }
    }

    private func waitForHello(after index: Int) async throws -> ShellState {
        try await waitUntil("native SSE hello", timeout: 10) { () -> ShellState? in
            for event in sseEvents[index...] {
                if case .hello(_, let state) = event { return state }
            }
            return nil
        }
    }

    private func waitForExit(pid: Int32, timeout: TimeInterval) async -> Bool {
        let deadline = now + timeout
        while now < deadline {
            if kill(pid, 0) != 0 && errno == ESRCH { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return false
    }

    // MARK: I/O helpers

    /// Runs `body` as an async function in the page's world; it must return a JSON string of an object.
    private func js(_ webView: WKWebView, _ body: String, _ arguments: [String: Any] = [:]) async throws -> [String: Any] {
        let text: String = try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: (value as? String) ?? "")
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
        guard let data = text.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { throw Failure.unexpected("script returned non-JSON: \(text.prefix(200))") }
        return object
    }

    private func api(_ method: String, _ path: String, _ body: [String: Any]?, port: Int) async throws -> (Int, Data) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!, timeoutInterval: 5)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "X-Everwatch-Token")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(JSONText.encode(body).utf8)
        }
        let (data, response) = try await http.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    // MARK: Supervisor (mirrors AppDelegate.handleSupervisor, minus any UI)

    private func handleSupervisor(_ event: BackendSupervisor.Event) {
        switch event {
        case .starting:
            webPolicy = WebPolicy(port: nil)
            sse.disconnect()
            mainWeb.loadLocal(.starting)
        case .ready(let port):
            readyEvents.append((port, now))
            webPolicy = WebPolicy(port: port)
            sse.connect(port: port)
            // Unlike AppDelegate, first mark onboarding done (a fresh
            // EVERWATCH_HOME would otherwise route the page to the wizard,
            // which has no session rows to count), then load the page.
            Task {
                let status = (try? await self.api("PATCH", "/api/prefs", ["onboarding_done": true], port: port))?.0 ?? -1
                self.onboardingPatches.append(status)
                guard self.webPolicy.port == port else { return }
                self.mainWeb.loadBackend(port: port)
            }
        case .failed(let kind):
            failedEvent = "\(kind)"
            webPolicy = WebPolicy(port: nil)
            sse.disconnect()
        }
    }

    // MARK: WebHost

    func bridge(_ message: InboundBridgeMessage, from webView: WKWebView) {
        if webView === probeWeb.webView {
            foreignBridge.append("\(message)")
            return
        }
        guard webView === mainWeb.webView else { return }
        switch message {
        case .ready:
            bridgeReady.append((webPolicy.port, now))
        case .appearance(let theme):
            appearances.append(theme)
            switch theme {
            case .system: NSApp.appearance = nil
            case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
            case .light: NSApp.appearance = NSAppearance(named: .aqua)
            }
        default:
            // openCompact / openSettings / requestNotifications /
            // openSystemSettings / setHotkeys: never acted on here.
            droppedBridge.append("\(message)")
        }
    }

    func retryBackend() {
        retryRequests += 1
    }

    func openExternally(_ url: URL) {
        externalOpens.append(url.absoluteString)   // recorded, never opened
    }
}

/// Page-world scripts for `callAsyncJavaScript` (bodies of async functions).
/// Each returns `JSON.stringify(object)`.
enum SelfTestScripts {
    static let pageChecks = """
    const n = window.everwatchNative || null;
    const rowCount = () => document.querySelectorAll('.row[role="option"], .compact-row').length;
    const out = {
      hasNative: !!n,
      shell: !!(n && n.shell === true),
      tokenMatches: !!(n && n.token === token),
      tokenInURL: location.href.indexOf(token) !== -1,
      shellVersion: n ? String(n.shellVersion) : null,
      dispatchInstalled: !!(n && typeof n.dispatch === 'function' && String(n.dispatch).indexOf('queue.push') === -1),
      hasHandler: !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.everwatch),
      visibility: document.visibilityState,
      origin: location.origin,
    };
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(document.body && document.body.dataset.ready === '1' && rowCount() > 0)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    out.bodyReady = !!(document.body && document.body.dataset.ready === '1');
    out.rows = rowCount();
    out.title = document.title;
    const chip = document.getElementById('status-chip');
    out.statusChip = chip ? chip.textContent.trim() : null;
    const good = await fetch('/api/state', { headers: { 'X-Everwatch-Token': n ? n.token : '' } });
    out.apiGood = good.status;
    out.apiSessions = good.ok ? ((await good.json()).sessions || []).length : -1;
    const bad = await fetch('/api/state', { headers: { 'X-Everwatch-Token': 'not-the-token' } });
    out.apiBad = bad.status;
    const sse = (tok) => new Promise((resolve) => {
      const es = new EventSource('/api/events?token=' + encodeURIComponent(tok));
      const t = setTimeout(() => { es.close(); resolve('timeout'); }, 5000);
      es.addEventListener('hello', () => { clearTimeout(t); es.close(); resolve('hello'); });
      es.onerror = () => { if (es.readyState === 2) { clearTimeout(t); resolve('error'); } };
    });
    out.sseHello = await sse(n ? n.token : '');
    out.sseBad = await sse('not-the-token');
    return JSON.stringify(out);
    """

    static let rowCount = """
    const deadline = Date.now() + 8000;
    const count = () => document.querySelectorAll('.row[role="option"], .compact-row').length;
    while (Date.now() < deadline && !(document.body && document.body.dataset.ready === '1' && count() > 0)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return JSON.stringify({ rows: count() });
    """

    static let postAppearance = """
    window.webkit.messageHandlers.everwatch.postMessage({ type: 'appearance', theme: theme });
    return JSON.stringify({ posted: true });
    """

    /// Wraps the page's installed dispatch so the test can see what arrives,
    /// then forwards to it unchanged.
    static let wrapDispatch = """
    const n = window.everwatchNative;
    if (!window.__everwatchSelftestInbox) {
      const original = n.dispatch;
      window.__everwatchSelftestInbox = [];
      n.dispatch = function (m) { window.__everwatchSelftestInbox.push(m); return original.apply(this, arguments); };
    }
    return JSON.stringify({ wrapped: true });
    """

    static let readInbox = """
    return JSON.stringify({ messages: window.__everwatchSelftestInbox || [] });
    """

    static let localPageLoaded = """
    return JSON.stringify({
      loaded: document.readyState === 'complete' && !!document.body && document.body.textContent.trim().length > 0,
      origin: String(location.origin), href: location.href,
    });
    """

    static let postFromForeignPage = """
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.everwatch;
    if (!h) return JSON.stringify({ posted: false });
    h.postMessage({ type: 'ready' });
    h.postMessage({ type: 'appearance', theme: 'dark' });
    return JSON.stringify({ posted: true });
    """
}
