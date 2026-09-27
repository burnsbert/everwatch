import Foundation

/// Local HTML shown in the main window when there is no backend to load
/// (§4.2 check 1: no NSAlert, copyable commands). Self-contained: inline CSS,
/// no scripts. "Try again" navigates to everwatch://retry, which the shell
/// intercepts.
enum ErrorPage {
    enum Kind: Equatable {
        case starting
        case pythonMissing(tried: [String])
        case runtimeMissing(path: String)
        case backendFailed(detail: String)
    }

    static func escape(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for ch in text {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }

    static func html(_ kind: Kind) -> String {
        let title: String
        var body = ""
        var showRetry = true
        switch kind {
        case .starting:
            title = "Starting Everwatch…"
            body = "<p>Starting the Everwatch engine.</p>"
            showRetry = false
        case .pythonMissing(let tried):
            title = "Everwatch needs Python 3.9 or newer"
            body = """
            <p>Everwatch runs a small engine written in Python. Install Python with one of these, then try again:</p>
            <p>With Homebrew:</p><pre>brew install python</pre>
            <p>Or with Apple's Command Line Tools:</p><pre>xcode-select --install</pre>
            """
            if !tried.isEmpty {
                body += "<details><summary>Places checked</summary><pre>\(escape(tried.joined(separator: "\n")))</pre></details>"
            }
        case .runtimeMissing(let path):
            title = "Everwatch's engine isn't installed"
            body = """
            <p>The Everwatch runtime wasn't found at:</p><pre>\(escape(path))</pre>
            <p>Re-run the installer, then try again:</p>
            <pre>curl -fsSL https://raw.githubusercontent.com/burnsbert/everwatch/main/install.sh | bash</pre>
            """
        case .backendFailed(let detail):
            title = "Everwatch's engine stopped"
            body = "<p>The engine exited several times in a row. The last output was:</p>"
            body += "<pre>\(escape(detail.isEmpty ? "(no output)" : detail))</pre>"
            body += "<p>Logs are in <code>~/Library/Logs/Everwatch/</code>. <code>everwatch doctor</code> in a terminal can help.</p>"
        }
        let retry = showRetry ? "<p><a class=\"button\" href=\"\(WebPolicy.retryURL.absoluteString)\">Try again</a></p>" : ""
        return """
        <!doctype html>
        <html lang="en"><head><meta charset="utf-8">
        <title>\(escape(title))</title>
        <style>
        :root{color-scheme:light dark;--bg:#f5f5f7;--fg:#1d1d1f;--dim:#6e6e73;--pre:#e8e8ed;--accent:#9a6400}
        @media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f5f5f7;--dim:#a1a1a6;--pre:#2c2c2e;--accent:#ffaf00}}
        body{margin:0;padding:48px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif}
        main{max-width:640px;margin:0 auto}
        h1{font-size:22px;margin:0 0 16px}
        pre{background:var(--pre);padding:10px 12px;border-radius:8px;font:13px ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-all;-webkit-user-select:all;user-select:all}
        details{color:var(--dim)}
        .button{display:inline-block;margin-top:8px;padding:6px 14px;border-radius:7px;border:1px solid var(--accent);color:var(--accent);text-decoration:none}
        </style></head>
        <body><main><h1>\(escape(title))</h1>
        \(body)
        \(retry)
        </main></body></html>
        """
    }
}
