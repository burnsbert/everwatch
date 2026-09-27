import AppKit

/// Menu bar status item (W-2): "◉ 2" in amber when anything is waiting,
/// otherwise a dim watch-ring glyph (StatusGlyph). Its menu lists waiting
/// sessions longest-first.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    var onGoto: ((String) -> Void)?
    var onShow: (() -> Void)?
    var onCompact: (() -> Void)?
    var onSettings: (() -> Void)?
    var onRetry: (() -> Void)?

    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var state = ShellState()
    private var connected = false
    private static let attentionColor = NSColor(srgbRed: 1.0, green: 0.686, blue: 0.0, alpha: 1.0)  // #FFAF00

    override init() {
        super.init()
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        render()
    }

    func update(state: ShellState?, connected: Bool) {
        if let state { self.state = state }
        self.connected = connected
        render()
    }

    private func render() {
        let display = StatusTitle.menuBar(waiting: state.waitingCount, connected: connected)
        guard let button = item.button else { return }
        button.toolTip = display.toolTip
        if display.showsEyeIcon {
            button.image = StatusGlyph.templateImage()
            button.attributedTitle = NSAttributedString(string: "")
            button.alphaValue = 0.55
        } else {
            button.image = nil
            button.alphaValue = 1
            button.attributedTitle = NSAttributedString(string: display.text, attributes: [
                .foregroundColor: display.attention ? Self.attentionColor : NSColor.labelColor,
                .font: NSFont.menuBarFont(ofSize: 0),
            ])
        }
    }

    // Rebuilt each time it opens, so it always reflects the latest state.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let waiting = connected ? StatusTitle.waitingMenuItems(state) : []
        if waiting.isEmpty {
            let none = NSMenuItem(title: connected ? "Nothing waiting" : "Not connected", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        } else {
            for entry in waiting {
                let mi = NSMenuItem(title: entry.title, action: #selector(gotoSession(_:)), keyEquivalent: "")
                mi.representedObject = entry.uid
                mi.target = self
                menu.addItem(mi)
            }
        }
        menu.addItem(.separator())
        add(menu, "Show Everwatch", #selector(show))
        add(menu, "Compact Mode", #selector(compact))
        add(menu, "Settings…", #selector(settings))
        if !connected { add(menu, "Restart Engine", #selector(retry)) }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Everwatch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let mi = NSMenuItem(title: title, action: action, keyEquivalent: "")
        mi.target = self
        menu.addItem(mi)
    }

    @objc private func gotoSession(_ sender: NSMenuItem) {
        if let uid = sender.representedObject as? String { onGoto?(uid) }
    }
    @objc private func show() { onShow?() }
    @objc private func compact() { onCompact?() }
    @objc private func settings() { onSettings?() }
    @objc private func retry() { onRetry?() }
}

/// Minimal authenticated client for the one call the shell makes itself.
@MainActor
enum BackendAPI {
    static func goto(port: Int, token: String, uid: String) {
        guard let url = WebPolicy.gotoURL(port: port, uid: uid) else { return }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "X-Everwatch-Token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        URLSession.shared.dataTask(with: request).resume()
    }
}
