import AppKit

// The responders that can end an Everwatch responder chain. Each overrides
// noResponder(for:) to drop the event silently via UnhandledEventPolicy and
// never calls super, because AppKit's default beeps for keyDown: and
// WKWebView re-sends every key the page leaves unhandled
// (Core/UnhandledEventPolicy.swift has the full path).
//
// Nothing else changes: key equivalents, menus, text input/IME, Tab and Esc
// all run before an event can fall off the end of the chain.
// Every window or panel that hosts a WKWebView must be one of these
// (lint_nosound.py rejects bare NSWindow( / NSPanel( in shell/Sources, and
// the self-test's silent_responder_chain check inspects them at runtime).
//
// A second, process-wide layer covers windows Everwatch doesn't create (the
// standard About panel, any other stock AppKit window): main.swift calls
// SilentResponders.installProcessWide() before anything else, which swaps
// NSResponder's own noResponderFor: for the same silent drop.
//
// Also compiled into build/shell-tests (scripts/build_app.sh), which
// inspects these classes, never instantiates them, and installs the
// process-wide layer in the test process (no windows or events exist there).

/// The application object (main.swift creates it through `.shared` before
/// anything else can). Covers a key event that reaches NSApp itself, such
/// as one typed while the app is active with no key window.
final class SilentApplication: NSApplication {
    override func noResponder(for eventSelector: Selector) {
        UnhandledEventPolicy.drop(NSStringFromSelector(eventSelector))
    }
}

/// Main window (and the self-test's hidden page window).
final class SilentWindow: NSWindow {
    override func noResponder(for eventSelector: Selector) {
        UnhandledEventPolicy.drop(NSStringFromSelector(eventSelector))
    }
}

/// Compact panel. It must be able to become key for the page's keyboard
/// shortcuts even though it's non-activating.
final class SilentPanel: NSPanel {
    override var canBecomeKey: Bool { true }

    override func noResponder(for eventSelector: Selector) {
        UnhandledEventPolicy.drop(NSStringFromSelector(eventSelector))
    }
}

/// The classes above, for the self-test and unit tests.
enum SilentResponders {
    static let selector = #selector(NSResponder.noResponder(for:))
    static let classes: [AnyClass] = [SilentApplication.self, SilentWindow.self, SilentPanel.self]

    /// Replaces `-[NSResponder noResponderFor:]` process-wide. Idempotent.
    static let processWide = SilentMethodPatch(cls: NSResponder.self, selector: selector)

    @discardableResult
    static func installProcessWide() -> SilentMethodPatch.Outcome {
        processWide.install()
    }

    /// Dynamic classes of the responder chain starting at `first`, ending at
    /// the responder AppKit would send noResponderFor: to. Reads
    /// nextResponder only; sends nothing.
    @MainActor
    static func chain(from first: NSResponder, limit: Int = 64) -> [AnyClass] {
        var classes: [AnyClass] = []
        var current: NSResponder? = first
        while let responder = current, classes.count < limit {
            classes.append(object_getClass(responder) ?? type(of: responder))
            current = responder.nextResponder
        }
        return classes
    }
}
