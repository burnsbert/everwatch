import Foundation

/// Decides whether a backend `notify` (already filtered by the Python policy)
/// becomes a native notification (W-1). Notifications are suppressed while
/// the main window is key, and an id is never posted twice (SSE reconnects
/// can replay events).
struct NotifyGate {
    enum Verdict: Equatable {
        case post
        case suppressedWindowKey
        case duplicate
        case invalid
    }

    let capacity: Int
    private var order: [String] = []
    private var seen: Set<String> = []

    init(capacity: Int = 256) {
        self.capacity = max(1, capacity)
    }

    mutating func evaluate(id: String, mainWindowIsKey: Bool) -> Verdict {
        guard !id.isEmpty else { return .invalid }
        guard !seen.contains(id) else { return .duplicate }
        remember(id)
        return mainWindowIsKey ? .suppressedWindowKey : .post
    }

    /// For `userNotificationCenter(_:willPresent:)` when the app is frontmost.
    static func presentInForeground(mainWindowIsKey: Bool) -> Bool {
        !mainWindowIsKey
    }

    /// Notification id for a quota prompt: one per month.
    static func quotaNotificationID(month: String) -> String {
        "quota-\(month)"
    }

    private mutating func remember(_ id: String) {
        seen.insert(id)
        order.append(id)
        if order.count > capacity {
            let evicted = order.removeFirst()
            seen.remove(evicted)
        }
    }
}
