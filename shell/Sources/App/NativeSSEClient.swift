import Foundation

/// The shell's own `/api/events` subscriber, so the menu bar, notifications,
/// and hotkeys keep working with the window closed (§0 point 3).
/// Delegate callbacks arrive on the main queue.
@MainActor
final class NativeSSEClient: NSObject, URLSessionDataDelegate {
    var onEvent: ((ShellEvent) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    private let token: String
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var parser = SSEParser()
    private var port: Int?
    private var failures = 0
    private var reconnectWork: DispatchWorkItem?
    private(set) var connected = false

    init(token: String) {
        self.token = token
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45       // server pings every 15 s; silence ⇒ reconnect
        config.timeoutIntervalForResource = .infinity
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }

    func connect(port: Int) {
        self.port = port
        failures = 0
        parser = SSEParser()   // new backend: forget the old Last-Event-ID
        open()
    }

    func disconnect() {
        port = nil
        reconnectWork?.cancel()
        task?.cancel()
        task = nil
        setConnected(false)
    }

    private func open() {
        reconnectWork?.cancel()
        task?.cancel()
        guard let port else { return }
        var request = URLRequest(url: WebPolicy.eventsURL(port: port, token: token))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(token, forHTTPHeaderField: "X-Everwatch-Token")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if !parser.lastEventID.isEmpty {
            request.setValue(parser.lastEventID, forHTTPHeaderField: "Last-Event-ID")
        }
        parser.reset()
        let newTask = session.dataTask(with: request)
        task = newTask
        newTask.resume()
    }

    private func scheduleReconnect() {
        guard port != nil else { return }
        let delay = SSEReconnect.delay(consecutiveFailures: failures, serverRetryMilliseconds: parser.retryMilliseconds)
        failures += 1
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.open() }
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func setConnected(_ value: Bool) {
        guard value != connected else { return }
        connected = value
        onConnectionChange?(value)
    }

    // MARK: URLSessionDataDelegate (main queue)

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                                completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        completionHandler(ok ? .allow : .cancel)
        MainActor.assumeIsolated {
            guard dataTask === self.task else { return }
            if ok {
                self.failures = 0
                self.setConnected(true)
            }
        }
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated {
            guard dataTask === self.task else { return }
            for event in self.parser.feed(data) {
                self.onEvent?(ShellEvent.decode(event))
            }
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated {
            guard task === self.task else { return }
            self.task = nil
            self.setConnected(false)
            self.scheduleReconnect()
        }
    }
}
