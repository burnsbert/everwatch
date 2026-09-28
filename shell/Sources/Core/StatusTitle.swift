import Foundation

/// What the menu bar status item shows (W-2).
struct StatusDisplay: Equatable {
    /// Text title; empty when the eye icon is shown instead.
    let text: String
    /// Amber attention styling (something is waiting).
    let attention: Bool
    /// Show the dim eye icon instead of text.
    let showsEyeIcon: Bool
    let toolTip: String
}

struct WaitingMenuItem: Equatable {
    let uid: String
    let title: String
}

enum StatusTitle {
    static let waitingGlyph = "◉"
    static let maxMenuTitleLength = 60

    static func menuBar(waiting: Int, connected: Bool) -> StatusDisplay {
        guard connected else {
            return StatusDisplay(text: "", attention: false, showsEyeIcon: true,
                                 toolTip: "Everwatch — not connected")
        }
        if waiting > 0 {
            return StatusDisplay(text: "\(waitingGlyph) \(waiting)", attention: true, showsEyeIcon: false,
                                 toolTip: "Everwatch — \(waiting) waiting")
        }
        return StatusDisplay(text: "", attention: false, showsEyeIcon: true,
                             toolTip: "Everwatch — nothing waiting")
    }

    static func windowTitle(waiting: Int) -> String {
        waiting > 0 ? "Everwatch — \(waiting) waiting" : "Everwatch"
    }

    static func dockBadge(waiting: Int, enabled: Bool) -> String? {
        enabled && waiting > 0 ? String(waiting) : nil
    }

    /// Waiting sessions, longest-waiting first, as menu entries like
    /// "◉ 1.3  deploy-fix". Unknown uids are skipped.
    static func waitingMenuItems(_ state: ShellState) -> [WaitingMenuItem] {
        state.waitingOrder.compactMap { uid in
            guard let session = state.session(uid: uid) else { return nil }
            var title = "\(waitingGlyph) "
            if let label = session.tabLabel, !label.isEmpty { title += "\(label)  " }
            title += truncate(session.bestTitle, to: maxMenuTitleLength)
            return WaitingMenuItem(uid: uid, title: title)
        }
    }

    static func truncate(_ text: String, to limit: Int) -> String {
        guard limit > 0 else { return "" }
        guard text.count > limit else { return text }
        return String(text.prefix(limit - 1)) + "…"
    }
}

/// Version strings for the About panel (P-77).
enum ShellInfo {
    static let version = "0.2.7"
    static let bundleIdentifier = "io.github.burnsbert.everwatch"
    static let itermBundleIdentifier = "com.googlecode.iterm2"

    static func aboutCredits(runtimeVersion: String?) -> String {
        let runtime = (runtimeVersion?.isEmpty == false) ? runtimeVersion! : "not connected"
        return "Shell \(version) · Runtime \(runtime)"
    }
}
