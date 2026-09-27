import AppKit
import WebKit

/// Receives bridge messages and navigation decisions for both web views.
@MainActor
protocol WebHost: AnyObject {
    var webPolicy: WebPolicy { get }
    func bridge(_ message: InboundBridgeMessage, from webView: WKWebView)
    func retryBackend()
    /// A link the navigation policy sends to the default browser.
    func openExternally(_ url: URL)
}

/// Breaks the WKUserContentController → handler retain cycle.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebContainer?
    init(_ target: WebContainer) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { target?.receive(message) }
    }
}

/// A WKWebView wired to the backend: token user script at document start,
/// the `everwatch` message handler, and the navigation allowlist.
@MainActor
final class WebContainer: NSObject, WKNavigationDelegate, WKUIDelegate {
    static let handlerName = "everwatch"

    let webView: WKWebView
    weak var host: WebHost?
    private let compact: Bool
    private var showingLocalPage = false

    init(token: String, compact: Bool, host: WebHost) {
        self.compact = compact
        self.host = host
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: NativeScript.bootstrap(token: token, shellVersion: ShellInfo.version),
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        config.userContentController = controller
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        controller.add(WeakScriptHandler(self), name: Self.handlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
    }

    func loadBackend(port: Int) {
        showingLocalPage = false
        webView.load(URLRequest(url: WebPolicy.pageURL(port: port, compact: compact)))
    }

    func loadLocal(_ kind: ErrorPage.Kind) {
        showingLocalPage = true
        webView.loadHTMLString(ErrorPage.html(kind), baseURL: nil)
    }

    func dispatch(_ message: OutboundBridgeMessage) {
        guard !showingLocalPage else { return }
        webView.evaluateJavaScript(message.javaScript, completionHandler: nil)
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard let host else { return }
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              host.webPolicy.acceptsBridgeMessage(scheme: origin.protocol, host: origin.host, port: origin.port)
        else { return }
        if case .success(let decoded) = InboundBridgeMessage.decode(message.body) {
            host.bridge(decoded, from: webView)
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let isMain = action.targetFrame?.isMainFrame ?? true
        switch host?.webPolicy.decide(action.request.url, isMainFrame: isMain) ?? .cancel {
        case .allow:
            decisionHandler(.allow)
        case .openExternally:
            if let url = action.request.url { host?.openExternally(url) }
            decisionHandler(.cancel)
        case .retryBackend:
            decisionHandler(.cancel)
            if showingLocalPage { host?.retryBackend() }
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: WKUIDelegate

    /// target=_blank / window.open: never create a new web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, host?.webPolicy.decide(url, isMainFrame: true) == .openExternally {
            host?.openExternally(url)
        }
        return nil
    }
}

/// Main window: frame autosaved, ⌘W hides it (the app stays in the menu bar).
/// A SilentWindow, so keys the page leaves unhandled never beep.
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    let window: SilentWindow
    let web: WebContainer
    var onKeyChange: ((Bool) -> Void)?

    init(token: String, host: WebHost) {
        web = WebContainer(token: token, compact: false, host: host)
        window = SilentWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: true)
        super.init()
        window.title = "Everwatch"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 480, height: 320)
        window.contentView = web.webView
        window.tabbingMode = .disallowed
        window.delegate = self
        if !window.setFrameUsingName("EverwatchMainWindow") { window.center() }
        window.setFrameAutosaveName("EverwatchMainWindow")
    }

    var isKey: Bool { NSApp.isActive && window.isKeyWindow }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowDidBecomeKey(_ notification: Notification) { onKeyChange?(true) }
    func windowDidResignKey(_ notification: Notification) { onKeyChange?(false) }
}

/// W-7: compact always-on-top panel. Non-activating so clicking it doesn't
/// pull focus away from iTerm2. A SilentPanel, so keys the page leaves
/// unhandled never beep.
@MainActor
final class CompactPanelController: NSObject {
    let panel: SilentPanel
    let web: WebContainer
    private var loadedPort: Int?

    init(token: String, host: WebHost) {
        web = WebContainer(token: token, compact: true, host: host)
        panel = SilentPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 480),
                            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                            backing: .buffered, defer: true)
        super.init()
        panel.title = "Everwatch"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = web.webView
        if !panel.setFrameUsingName("EverwatchCompactPanel") { panel.center() }
        panel.setFrameAutosaveName("EverwatchCompactPanel")
    }

    var isVisible: Bool { panel.isVisible }

    func show(port: Int?) {
        if let port, port != loadedPort {
            loadedPort = port
            web.loadBackend(port: port)
        }
        panel.orderFrontRegardless()
    }

    func toggle(port: Int?) {
        if panel.isVisible { panel.orderOut(nil) } else { show(port: port) }
    }

    func backendRestarted(port: Int) {
        loadedPort = nil
        if panel.isVisible { show(port: port) }
    }
}
