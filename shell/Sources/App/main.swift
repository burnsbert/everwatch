import AppKit

// Everwatch.app entry point. A regular Dock app (LSUIElement = false) so the
// Dock badge and optional bounce work; the menu bar item keeps working when
// the window is closed.
//
// EVERWATCH_SELFTEST=1 (exactly) runs the headless self-test instead
// (SelfTestRunner.swift, scripts/shell_selftest.sh): activation is prohibited
// before anything else happens, so it never gets a Dock icon, a menu bar, or
// focus, and none of the normal delegate's UI is ever created.
//
// Unhandled keys make no sound (SilentResponders.swift): NSResponder's own
// noResponderFor: is replaced process-wide first, then the shared
// application is created as a SilentApplication (`SilentApplication.shared`
// must be the first `.shared` access so AppKit instantiates the subclass).
MainActor.assumeIsolated {
    SilentResponders.installProcessWide()
    let app = SilentApplication.shared
    if SelfTestConfig.isRequested(environment: ProcessInfo.processInfo.environment) {
        app.setActivationPolicy(.prohibited)
        let runner = SelfTestRunner(environment: ProcessInfo.processInfo.environment)
        app.delegate = runner
        withExtendedLifetime(runner) {
            app.run()
        }
    } else {
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}
