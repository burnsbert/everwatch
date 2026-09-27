import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WebHost {
    private let environment = ProcessInfo.processInfo.environment
    private let token: String

    private var supervisor: BackendSupervisor!
    private var mainWindow: MainWindowController!
    private var compactPanel: CompactPanelController!
    private var statusItem: StatusItemController!
    private let sse: NativeSSEClient
    private let notifier = Notifier()
    private let hotKeys = HotKeyCenter()
    private let soundPolicy: SoundPolicy
    private let soundPlayer: AttentionCuePlayer = SystemSoundPlayer()

    private var state = ShellState()
    private var runtimeVersion: String?
    private var appliedHotkeys: (show: String, next: String)?
    private var hotkeyStatuses: [String: String] = [:]
    private(set) var webPolicy = WebPolicy(port: nil)

    override init() {
        let token = AppDelegate.makeToken()
        self.token = token
        sse = NativeSSEClient(token: token)
        soundPolicy = SoundPolicy(environment: ProcessInfo.processInfo.environment)
        super.init()
    }

    private static func makeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return NativeScript.base64url(bytes)
    }

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMainMenu()
        mainWindow = MainWindowController(token: token, host: self)
        compactPanel = CompactPanelController(token: token, host: self)
        statusItem = StatusItemController()
        supervisor = BackendSupervisor(token: token, environment: environment)

        mainWindow.onKeyChange = { [weak self] key in self?.mainWindow.web.dispatch(.focus(key: key)) }
        notifier.isMainWindowKey = { [weak self] in self?.mainWindow.isKey ?? false }
        notifier.onClick = { [weak self] uid in
            guard let self else { return }
            guard let uid else { self.mainWindow.show(); return }
            self.gotoSession(uid)
            self.mainWindow.web.dispatch(.notificationClicked(uid: uid))
        }
        notifier.install()
        NSApp.dockTile.badgeLabel = nil
        notifier.clearBadge()

        statusItem.onGoto = { [weak self] uid in self?.gotoSession(uid) }
        statusItem.onShow = { [weak self] in self?.mainWindow.show() }
        statusItem.onCompact = { [weak self] in self?.toggleCompact() }
        statusItem.onSettings = { [weak self] in self?.openSettings() }
        statusItem.onRetry = { [weak self] in self?.retryBackend() }

        sse.onEvent = { [weak self] event in self?.handle(event) }
        sse.onConnectionChange = { [weak self] connected in
            guard let self else { return }
            self.statusItem.update(state: nil, connected: connected)
        }

        supervisor.onEvent = { [weak self] event in self?.handleSupervisor(event) }

        applyHotkeys(show: Prefs.defaultHotkeyShow, next: Prefs.defaultHotkeyNext)
        mainWindow.show()
        supervisor.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        hotKeys.unregisterAll()
        sse.disconnect()
        supervisor.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow.show()
        return true
    }

    // MARK: Backend

    private func handleSupervisor(_ event: BackendSupervisor.Event) {
        switch event {
        case .starting:
            webPolicy = WebPolicy(port: nil)
            sse.disconnect()
            mainWindow.web.loadLocal(.starting)
        case .ready(let port):
            webPolicy = WebPolicy(port: port)
            mainWindow.web.loadBackend(port: port)
            compactPanel.backendRestarted(port: port)
            sse.connect(port: port)
        case .failed(let kind):
            webPolicy = WebPolicy(port: nil)
            sse.disconnect()
            mainWindow.web.loadLocal(kind)
            mainWindow.show()
        }
    }

    func retryBackend() {
        supervisor.retry()
    }

    func openExternally(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    private func handle(_ event: ShellEvent) {
        switch event {
        case .hello(let version, let newState):
            runtimeVersion = version ?? newState.version
            apply(newState)
        case .state(let newState):
            apply(newState)
        case .transition(let transition):
            soundPolicy.handle(transition, prefs: state.prefs, player: soundPlayer)
            if transition.to == "waiting", state.prefs.dockBounce, !NSApp.isActive {
                NSApp.requestUserAttention(.informationalRequest)
            }
        case .notify(let n):
            notifier.post(id: n.id, uid: n.uid, title: n.title, body: n.body)
        case .quotaPrompt(let q):
            notifier.post(id: NotifyGate.quotaNotificationID(month: q.month), uid: nil,
                          title: "Claude usage at \(Int(q.pct.rounded()))%",
                          body: "Open Everwatch to draft the quota email or skip this month.")
        case .ping, .ignored, .malformed:
            break
        }
    }

    private func apply(_ newState: ShellState) {
        let reprobe = AutomationStatus.shouldReprobe(previousItermStatus: state.itermStatus,
                                                     currentItermStatus: newState.itermStatus)
        let dockBadgeWasEnabled = state.prefs.showDockBadge
        state = newState
        if let v = newState.version { runtimeVersion = v }
        statusItem.update(state: newState, connected: sse.connected)
        mainWindow.window.title = StatusTitle.windowTitle(waiting: newState.waitingCount)
        NSApp.dockTile.badgeLabel = StatusTitle.dockBadge(waiting: newState.waitingCount, enabled: newState.prefs.showDockBadge)
        if dockBadgeWasEnabled && !newState.prefs.showDockBadge { notifier.clearBadge() }
        applyTheme(newState.prefs.theme)
        applyHotkeys(show: newState.prefs.hotkeyShow, next: newState.prefs.hotkeyNext)
        if reprobe { sendNativeStatus() }
    }

    private func gotoSession(_ uid: String) {
        guard let port = supervisor.port else { return }
        BackendAPI.goto(port: port, token: token, uid: uid)
    }

    // MARK: Bridge (WebHost)

    func bridge(_ message: InboundBridgeMessage, from webView: WKWebView) {
        switch message {
        case .appearance(let theme):
            applyTheme(theme)
        case .openCompact:
            toggleCompact()
        case .openSettings:
            openSettings()
        case .requestNotifications:
            notifier.requestAuthorization { [weak self] in self?.sendNativeStatus() }
        case .openSystemSettings(let pane):
            NSWorkspace.shared.open(pane.url)
        case .setHotkeys(let show, let next):
            applyHotkeys(show: show, next: next, force: true)
            sendNativeStatus()
        case .ready:
            sendNativeStatus()
            if webView === mainWindow.web.webView {
                mainWindow.web.dispatch(.focus(key: mainWindow.isKey))
            }
        }
    }

    private func sendNativeStatus() {
        let hotkeys = hotkeyStatuses
        DispatchQueue.global(qos: .userInitiated).async {
            let automation = AutomationProbe.itermStatus()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.notifier.status { notifications in
                        let message = OutboundBridgeMessage.nativeStatus(
                            NativeStatus(automation: automation, notifications: notifications, hotkeys: hotkeys))
                        self.mainWindow.web.dispatch(message)
                        self.compactPanel.web.dispatch(message)
                    }
                }
            }
        }
    }

    // MARK: Actions

    private func applyTheme(_ theme: Theme) {
        switch theme {
        case .system: NSApp.appearance = nil
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        }
    }

    private func applyHotkeys(show: String, next: String, force: Bool = false) {
        if !force, let applied = appliedHotkeys, applied.show == show, applied.next == next { return }
        appliedHotkeys = (show, next)
        hotkeyStatuses = hotKeys.apply(show: show, next: next,
                                       onShow: { [weak self] in self?.mainWindow.show() },
                                       onNext: { [weak self] in
                                           guard let self, let uid = self.state.longestWaitingUID else { return }
                                           self.gotoSession(uid)
                                       })
    }

    private func toggleCompact() {
        compactPanel.toggle(port: supervisor.port)
    }

    private func openSettings() {
        mainWindow.show()
        mainWindow.web.dispatch(.openSettings)
    }

    @objc private func showAbout(_ sender: Any?) {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationVersion: ShellInfo.version,
            .credits: NSAttributedString(string: ShellInfo.aboutCredits(runtimeVersion: runtimeVersion)),
        ])
    }

    @objc private func menuSettings(_ sender: Any?) { openSettings() }
    @objc private func menuCompact(_ sender: Any?) { toggleCompact() }
    @objc private func menuShow(_ sender: Any?) { mainWindow.show() }
    @objc private func menuRestartEngine(_ sender: Any?) { retryBackend() }

    private func buildMainMenu() -> NSMenu {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Everwatch", action: #selector(showAbout(_:)), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Settings…", action: #selector(menuSettings(_:)), keyEquivalent: ",").target = self
        appMenu.addItem(withTitle: "Restart Engine", action: #selector(menuRestartEngine(_:)), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Everwatch", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Everwatch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        addSubmenu(appMenu, title: "Everwatch", to: main)

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        addSubmenu(edit, title: "Edit", to: main)

        let view = NSMenu(title: "View")
        let compact = view.addItem(withTitle: "Compact Mode", action: #selector(menuCompact(_:)), keyEquivalent: "\\")
        compact.target = self
        addSubmenu(view, title: "View", to: main)

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Show Everwatch", action: #selector(menuShow(_:)), keyEquivalent: "0").target = self
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        addSubmenu(window, title: "Window", to: main)
        NSApp.windowsMenu = window

        return main
    }

    private func addSubmenu(_ submenu: NSMenu, title: String, to main: NSMenu) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        main.addItem(item)
    }
}
