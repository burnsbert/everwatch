import AppKit
import UserNotifications

/// Silent native notifications with click-to-focus (W-1). Authorization asks
/// for alerts only, and every notification's content has no sound or badge.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var isMainWindowKey: () -> Bool = { false }
    /// uid of the session to focus, or nil (quota prompt) to show Everwatch.
    var onClick: ((String?) -> Void)?

    private var gate = NotifyGate()
    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    func install() {
        center.delegate = self
    }

    func requestAuthorization(completion: @escaping () -> Void) {
        center.requestAuthorization(options: [.alert]) { _, _ in
            DispatchQueue.main.async(execute: completion)
        }
    }

    /// Clear an old notification-system badge when Everwatch's optional Dock
    /// count is off. AppKit's dockTile badge is cleared separately.
    func clearBadge() {
        center.setBadgeCount(0, withCompletionHandler: nil)
    }

    func status(completion: @escaping (NotificationStatus) -> Void) {
        center.getNotificationSettings { settings in
            let status = NotificationStatus.from(authorizationStatusRawValue: settings.authorizationStatus.rawValue)
            DispatchQueue.main.async { completion(status) }
        }
    }

    func post(id: String, uid: String?, title: String, body: String) {
        guard gate.evaluate(id: id, mainWindowIsKey: isMainWindowKey()) == .post else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = nil
        if let uid { content.userInfo = ["uid": uid] }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            let key = MainActor.assumeIsolated { self.isMainWindowKey() }
            completionHandler(NotifyGate.presentInForeground(mainWindowIsKey: key) ? [.banner, .list] : [])
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let uid = response.notification.request.content.userInfo["uid"] as? String
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.onClick?(uid)
            }
            completionHandler()
        }
    }
}
