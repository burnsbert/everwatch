import Foundation

/// What the web views may load, and who may talk to the bridge (§3.8).
struct WebPolicy {
    enum Decision: Equatable {
        case allow
        case openExternally
        case retryBackend
        case cancel
    }

    static let retryURL = URL(string: "everwatch://retry")!

    /// The backend port, or nil before the handshake.
    let port: Int?

    func isBackendOrigin(scheme: String?, host: String?, port: Int?) -> Bool {
        guard let expected = self.port, let scheme = scheme?.lowercased(), scheme == "http",
              let host = host?.lowercased(), host == "127.0.0.1" || host == "localhost"
        else { return false }
        return port == expected
    }

    func isBackendURL(_ url: URL) -> Bool {
        isBackendOrigin(scheme: url.scheme, host: url.host, port: url.port)
    }

    func decide(_ url: URL?, isMainFrame: Bool) -> Decision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" { return .allow }
        if isBackendURL(url) { return .allow }
        if scheme == "everwatch" {
            return (isMainFrame && url.host?.lowercased() == "retry") ? .retryBackend : .cancel
        }
        guard isMainFrame else { return .cancel }
        switch scheme {
        case "http", "https", "mailto": return .openExternally
        default: return .cancel
        }
    }

    /// Bridge messages are accepted only from the backend's own origin, so a
    /// local error page or any foreign content can't drive the shell.
    func acceptsBridgeMessage(scheme: String?, host: String?, port: Int?) -> Bool {
        isBackendOrigin(scheme: scheme, host: host, port: port)
    }

    static func pageURL(port: Int, compact: Bool) -> URL {
        URL(string: compact ? "http://127.0.0.1:\(port)/?mode=compact" : "http://127.0.0.1:\(port)/")!
    }

    static func eventsURL(port: Int, token: String) -> URL {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = port
        components.path = "/api/events"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url!
    }

    /// POST target for "go to session" (menu bar, hotkey, notification click).
    static func gotoURL(port: Int, uid: String) -> URL? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.:")
        guard !uid.isEmpty, let encoded = uid.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/api/sessions/\(encoded)/goto")
    }
}

/// Per-launch token and the document-start script that hands it to the page.
enum NativeScript {
    /// base64url without padding (32 random bytes → 43 chars).
    static func base64url(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Installed as a WKUserScript at document start (main frame only). It sets
    /// `window.everwatchNative = {shell, token, shellVersion, dispatch}`;
    /// until the page's bridge replaces `dispatch`, messages queue in
    /// `window.everwatchNative.queue`. The token never appears in a URL.
    static func bootstrap(token: String, shellVersion: String) -> String {
        """
        (function(){\
        var n=window.everwatchNative||{};\
        n.shell=true;\
        n.token=\(JSONText.encode(token));\
        n.shellVersion=\(JSONText.encode(shellVersion));\
        if(typeof n.dispatch!=="function"){n.queue=n.queue||[];n.dispatch=function(m){n.queue.push(m);};}\
        window.everwatchNative=n;\
        })();
        """
    }
}
