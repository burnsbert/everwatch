import Foundation
import ObjectiveC

/// What happens when an event nobody handled falls off the end of the
/// responder chain (`-[NSResponder noResponderFor:]`).
///
/// AppKit's default beeps: `-[NSResponder noResponderFor:]` compares the
/// selector with `keyDown:` and tail-calls AppKit's system-alert function. WKWebView re-sends
/// every keyDown the page didn't `preventDefault()` (WebKit
/// `WebViewImpl::doneWithKeyEvent` → `[NSApp sendEvent:]` → `keyDown:` →
/// `[super keyDown:]`), so in a stock NSWindow every unbound key, and every
/// ⌘-combo no menu item claims, ends in that beep.
///
/// Everwatch never beeps (the only audible path is SystemSoundPlayer behind
/// SoundPolicy). Every responder that can end a chain (the application
/// object and every window/panel that hosts a web view; see
/// App/SilentResponders.swift) overrides `noResponder(for:)` to call
/// `drop(_:)` here, and never calls super.
enum UnhandledEventPolicy {
    /// The Objective-C selector name AppKit's default beeps for.
    static let beepingSelector = "keyDown:"

    /// AppKit's default behavior, for reference and tests: it beeps for
    /// `keyDown:` and does nothing for anything else.
    static func appKitDefaultBeeps(selector: String) -> Bool {
        selector == beepingSelector
    }

    /// Everwatch's behavior: never, for any selector.
    static func mayBeep(selector: String) -> Bool {
        false
    }

    /// What every override does: record the event (the self-test reads the
    /// log) and drop it. Returns `mayBeep(selector:)`, i.e. always false.
    @discardableResult
    static func drop(_ selector: String, log: UnhandledEventLog = .shared) -> Bool {
        log.record(selector)
        return mayBeep(selector: selector)
    }
}

/// Counts dropped fall-throughs. Never audible; only the headless self-test
/// and unit tests read it.
final class UnhandledEventLog: @unchecked Sendable {
    static let shared = UnhandledEventLog()

    private let lock = NSLock()
    private var counts: [String: Int] = [:]

    func record(_ selector: String) {
        lock.lock(); counts[selector, default: 0] += 1; lock.unlock()
    }

    func count(_ selector: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return counts[selector] ?? 0
    }

    var total: Int {
        lock.lock(); defer { lock.unlock() }
        return counts.values.reduce(0, +)
    }
}

/// Objective-C runtime inspection used to prove, without ever calling
/// AppKit's default, that a class overrides a method.
enum MethodOverride {
    /// True when `cls` is `base` or a subclass of it.
    static func inherits(_ cls: AnyClass, from base: AnyClass) -> Bool {
        var current: AnyClass? = cls
        while let c = current {
            if c === base { return true }
            current = class_getSuperclass(c)
        }
        return false
    }

    /// True when instances of `cls` (a subclass of `base`) dispatch
    /// `selector` to an implementation other than `base`'s own. Reads IMPs
    /// only; nothing is invoked.
    static func isOverridden(_ selector: Selector, in cls: AnyClass, below base: AnyClass) -> Bool {
        guard cls !== base, inherits(cls, from: base),
              let baseMethod = class_getInstanceMethod(base, selector),
              let method = class_getInstanceMethod(cls, selector)
        else { return false }
        return method_getImplementation(method) != method_getImplementation(baseMethod)
    }

    /// Verdict for a responder chain given as the dynamic class of each
    /// responder, first responder first. The chain is silent when its last
    /// responder (the one AppKit sends `noResponderFor:` to) overrides it.
    static func chainEndIsSilent(_ chain: [AnyClass], selector: Selector, base: AnyClass) -> Bool {
        guard let last = chain.last else { return false }
        return isOverridden(selector, in: last, below: base)
    }
}

/// The process-wide layer: replaces `cls`'s own implementation of a
/// `-(void)method:(SEL)selector` (in practice `-[NSResponder noResponderFor:]`)
/// with one that calls `UnhandledEventPolicy.drop`. That covers windows
/// Everwatch doesn't create itself (the standard About panel, any other stock
/// AppKit window or responder). The Silent* subclasses stay the primary,
/// statically checkable layer.
///
/// `class_replaceMethod` only ever touches `cls` (if `cls` merely inherited
/// the method it gains an override; its superclass is untouched).
/// Installing is idempotent, the replaced implementation is kept only for
/// IMP-identity checks and is never called, and there is no uninstall.
final class SilentMethodPatch: @unchecked Sendable {
    enum Outcome: Equatable {
        case installed
        case alreadyInstalled
        /// `cls` doesn't respond to the selector, so nothing was changed.
        case missingMethod
    }

    let cls: AnyClass
    let selector: Selector
    private let log: UnhandledEventLog
    private let lock = NSLock()
    private var silent: IMP?
    private var replaced: IMP?

    init(cls: AnyClass, selector: Selector, log: UnhandledEventLog = .shared) {
        self.cls = cls
        self.selector = selector
        self.log = log
    }

    /// The silent implementation, once installed.
    var silentIMP: IMP? {
        lock.lock(); defer { lock.unlock() }
        return silent
    }

    /// The implementation it replaced (for identity checks only; never called).
    var replacedIMP: IMP? {
        lock.lock(); defer { lock.unlock() }
        return replaced
    }

    /// The implementation `cls` dispatches the selector to right now.
    var currentIMP: IMP? {
        class_getInstanceMethod(cls, selector).map(method_getImplementation)
    }

    /// True when `cls` currently dispatches to the silent implementation.
    var isInstalled: Bool {
        guard let silent = silentIMP, let current = currentIMP else { return false }
        return current == silent
    }

    @discardableResult
    func install() -> Outcome {
        lock.lock(); defer { lock.unlock() }
        guard let method = class_getInstanceMethod(cls, selector) else { return .missingMethod }
        let current = method_getImplementation(method)
        if let silent, current == silent { return .alreadyInstalled }
        let log = self.log
        let block: @convention(block) (AnyObject, Selector) -> Void = { _, eventSelector in
            UnhandledEventPolicy.drop(NSStringFromSelector(eventSelector), log: log)
        }
        let imp = imp_implementationWithBlock(block)
        class_replaceMethod(cls, selector, imp, method_getTypeEncoding(method))
        silent = imp
        replaced = current
        return .installed
    }
}
