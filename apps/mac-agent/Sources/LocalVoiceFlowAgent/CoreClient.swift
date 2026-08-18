import Foundation

/// Mirrors `PipelineStageSchema` in packages/shared/src/events.ts.
public enum PipelineStage: String, Codable, Sendable {
    case received, transcribing, transcribed, correcting, completed, failed, cancelled
}

/// Mirrors `ServerEvent`, narrowed to what the agent acts on.
public enum ServerEvent: Sendable {
    case hello(version: String)
    /// `text` carries the transcript on the `transcribed` stage so the HUD can show it.
    case pipeline(dictationId: String, stage: PipelineStage, text: String?)
    case sttStatus(ready: Bool, state: String, error: String?)
    case settingsChanged
}

/// Mirrors `DictationOutcomeSchema` in packages/shared/src/dictation.ts.
public struct DictationOutcome: Decodable, Sendable {
    public var id: String
    public var status: String
    public var text: String?
    public var isRawFallback: Bool?
    public var audioDurationMs: Double?
    public var sttLatencyMs: Double?
    public var llmLatencyMs: Double?
    public var totalLatencyMs: Double?
    public var errorCode: String?
    public var errorMessage: String?
    public var warnings: [String]?
}

/// Mirrors `AgentStatusSchema`.
public struct AgentStatusPayload: Encodable, Equatable, Sendable {
    public var microphone: PermissionState
    public var accessibility: PermissionState
    public var inputMonitoring: PermissionState
    public var agentVersion: String
    public var fnTapActive: Bool
    public var fnTapError: String?
}

/// The subset of settings the agent needs, from `GET /api/agent/config`.
///
/// Every field is optional and falls back to the shared defaults, and both the flat shape and the
/// nested `{ general: {...}, correction: {...} }` shape are accepted, so a core that returns the
/// whole `Settings` object works just as well as one that returns the narrow projection.
public struct AgentConfig: Sendable, Equatable {
    public var enabled = true
    public var hudEnabled = true
    public var fnTriggerEnabled = true
    public var fallbackHotkeyEnabled = true
    public var fallbackHotkey = "control+option+space"
    public var doubleTapWindowMs: Double = 350
    public var minRecordingMs: Double = 350
    public var maxRecordingSeconds: Double = 180
    public var endLockedRecordingWithEnter = false
    public var targetChangedBehavior: TargetChangedBehavior = .pasteOnlyIfSameApp
    public var restoreClipboardAfterPaste = true
    public var clipboardRestoreDelayMs = 600
    public var sendWindowTitle = false

    public init() {}

    public var dictationConfig: DictationConfig {
        DictationConfig(
            doubleTapWindowMs: doubleTapWindowMs,
            minRecordingMs: minRecordingMs,
            maxRecordingSeconds: maxRecordingSeconds,
            endLockedRecordingWithEnter: endLockedRecordingWithEnter,
            fnTriggerEnabled: fnTriggerEnabled,
            fallbackHotkeyEnabled: fallbackHotkeyEnabled
        )
    }

    public static func decode(from data: Data) -> AgentConfig {
        var config = AgentConfig()
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return config
        }
        let general = (root["general"] as? [String: Any]) ?? root
        let correction = (root["correction"] as? [String: Any]) ?? root

        func bool(_ dict: [String: Any], _ key: String, _ fallback: Bool) -> Bool {
            dict[key] as? Bool ?? fallback
        }
        func number(_ dict: [String: Any], _ key: String, _ fallback: Double) -> Double {
            (dict[key] as? NSNumber)?.doubleValue ?? fallback
        }

        config.enabled = bool(general, "enabled", config.enabled)
        config.hudEnabled = bool(general, "hudEnabled", config.hudEnabled)
        config.fnTriggerEnabled = bool(general, "fnTriggerEnabled", config.fnTriggerEnabled)
        config.fallbackHotkeyEnabled = bool(general, "fallbackHotkeyEnabled", config.fallbackHotkeyEnabled)
        config.fallbackHotkey = (general["fallbackHotkey"] as? String) ?? config.fallbackHotkey
        config.doubleTapWindowMs = number(general, "doubleTapWindowMs", config.doubleTapWindowMs)
        config.minRecordingMs = number(general, "minRecordingMs", config.minRecordingMs)
        config.maxRecordingSeconds = number(general, "maxRecordingSeconds", config.maxRecordingSeconds)
        config.endLockedRecordingWithEnter = bool(general, "endLockedRecordingWithEnter", config.endLockedRecordingWithEnter)
        if let raw = general["targetChangedBehavior"] as? String, let parsed = TargetChangedBehavior(rawValue: raw) {
            config.targetChangedBehavior = parsed
        }
        config.restoreClipboardAfterPaste = bool(general, "restoreClipboardAfterPaste", config.restoreClipboardAfterPaste)
        config.clipboardRestoreDelayMs = Int(number(general, "clipboardRestoreDelayMs", Double(config.clipboardRestoreDelayMs)))
        config.sendWindowTitle = bool(correction, "sendWindowTitle", config.sendWindowTitle)
        return config
    }
}

/// Assembles `text/event-stream` frames one line at a time.
///
/// An SSE frame ends at an empty line, and `data:` may legally repeat within one frame, so the
/// lines have to be buffered rather than parsed individually.
struct SSEFrameParser {
    private var dataLines: [String] = []

    /// Returns an event when `line` completes a frame, nil otherwise.
    mutating func feed(_ line: String) -> ServerEvent? {
        guard !line.isEmpty else {
            defer { dataLines.removeAll(keepingCapacity: true) }
            guard !dataLines.isEmpty else { return nil }
            return CoreClient.parseEvent(dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil } // heartbeat comment
        if line.hasPrefix("data:") {
            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
        }
        return nil
    }
}

public enum CoreClientError: Error, CustomStringConvertible {
    case unreachable
    case missingToken(String)
    case http(Int, String?)
    case badResponse

    public var description: String {
        switch self {
        case .unreachable: return "core недоступен"
        case .missingToken(let path): return "нет токена: \(path)"
        case .http(let code, let message): return "HTTP \(code)\(message.map { ": \($0)" } ?? "")"
        case .badResponse: return "неожиданный ответ core"
        }
    }
}

/// Everything the agent says to core on 127.0.0.1.
public final class CoreClient {
    public static let defaultPort = 43117

    public let baseURL: URL
    private let session: URLSession
    private let tokenURL: URL
    private let agentVersion: String
    private let lock = NSLock()
    private var cachedToken: String?

    public init(port: Int? = nil, agentVersion: String = AgentInfo.version) {
        let resolvedPort = port
            ?? ProcessInfo.processInfo.environment["LVF_PORT"].flatMap(Int.init)
            ?? Self.defaultPort
        baseURL = URL(string: "http://127.0.0.1:\(resolvedPort)")!
        tokenURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/LocalVoiceFlow", isDirectory: true)
            .appendingPathComponent("token", isDirectory: false)
        self.agentVersion = agentVersion

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        // A long dictation plus LLM correction can legitimately take minutes.
        configuration.timeoutIntervalForResource = 600
        configuration.waitsForConnectivity = false
        configuration.httpShouldUsePipelining = false
        session = URLSession(configuration: configuration)
    }

    // MARK: - Token

    /// Re-reads the token file on demand: core regenerates it on first run, which can happen after
    /// the agent has already started.
    public func token() throws -> String {
        lock.lock()
        if let cachedToken { lock.unlock(); return cachedToken }
        lock.unlock()

        guard let data = FileManager.default.contents(atPath: tokenURL.path),
              let raw = String(data: data, encoding: .utf8)
        else {
            throw CoreClientError.missingToken(tokenURL.path)
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw CoreClientError.missingToken(tokenURL.path) }

        lock.lock(); cachedToken = trimmed; lock.unlock()
        return trimmed
    }

    public func invalidateToken() {
        lock.lock(); cachedToken = nil; lock.unlock()
    }

    /// Opening this URL in a browser exchanges the token for an HttpOnly session cookie, so the
    /// token itself never has to live in the page.
    public func dashboardURL() -> URL? {
        guard let token = try? token() else { return URL(string: "\(baseURL.absoluteString)/") }
        var components = URLComponents(url: baseURL.appendingPathComponent("session"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "token", value: token)]
        return components?.url
    }

    private func authorized(_ request: inout URLRequest) throws {
        request.setValue("Bearer \(try token())", forHTTPHeaderField: "Authorization")
        // Core requires Origin, when present, to match its own origin on mutating requests.
        request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
    }

    // MARK: - Endpoints

    /// `GET /api/health` — unauthenticated liveness probe.
    public func isReachable() async -> Bool {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 2
        guard let (_, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse
        else { return false }
        return http.statusCode == 200
    }

    /// `POST /api/dictations` — the WAV goes in the body, metadata in `X-LVF-*` headers.
    public func postDictation(
        wavURL: URL,
        dictationId: String,
        mode: RecordingMode,
        target: TargetAppSnapshot?,
        durationMs: Int,
        peakAmplitude: Float,
        sendWindowTitle: Bool
    ) async throws -> DictationOutcome {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/dictations"))
        request.httpMethod = "POST"
        try authorized(&request)
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.setValue(mode.rawValue, forHTTPHeaderField: "X-LVF-Recording-Mode")
        request.setValue(dictationId, forHTTPHeaderField: "X-LVF-Dictation-Id")
        request.setValue(String(durationMs), forHTTPHeaderField: "X-LVF-Audio-Duration-Ms")
        request.setValue(String(format: "%.4f", peakAmplitude), forHTTPHeaderField: "X-LVF-Peak-Amplitude")
        if let target {
            request.setValue(String(target.pid), forHTTPHeaderField: "X-LVF-Pid")
            if let bundleId = target.bundleId {
                request.setValue(Self.percentEncoded(bundleId), forHTTPHeaderField: "X-LVF-Bundle-Id")
            }
            if let name = target.localizedName {
                request.setValue(Self.percentEncoded(name), forHTTPHeaderField: "X-LVF-App-Name")
            }
            if sendWindowTitle, let title = target.windowTitle {
                request.setValue(Self.percentEncoded(title), forHTTPHeaderField: "X-LVF-Window-Title")
            }
        }

        let (data, response) = try await session.upload(for: request, fromFile: wavURL)
        guard let http = response as? HTTPURLResponse else { throw CoreClientError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoreClientError.http(http.statusCode, Self.errorMessage(from: data))
        }
        do {
            return try JSONDecoder().decode(DictationOutcome.self, from: data)
        } catch {
            throw CoreClientError.badResponse
        }
    }

    /// `POST /api/dictations/:id/cancel`
    public func cancelDictation(id: String) async {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/dictations/\(id)/cancel"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        guard (try? authorized(&request)) != nil else { return }
        _ = try? await session.data(for: request)
    }

    /// `POST /api/agent/status`
    public func postAgentStatus(_ snapshot: PermissionSnapshot, fnTapActive: Bool, fnTapError: String?) async {
        let payload = AgentStatusPayload(
            microphone: snapshot.microphone,
            accessibility: snapshot.accessibility,
            inputMonitoring: snapshot.inputMonitoring,
            agentVersion: agentVersion,
            fnTapActive: fnTapActive,
            fnTapError: fnTapError.map { String($0.prefix(300)) }
        )
        var request = URLRequest(url: baseURL.appendingPathComponent("api/agent/status"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        guard (try? authorized(&request)) != nil else { return }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(payload)
        guard let (_, response) = try? await session.data(for: request) else {
            AgentLog.debug("agent status not delivered: core unreachable")
            return
        }
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            // The token was rotated under us.
            invalidateToken()
        }
    }

    /// `GET /api/agent/config`
    public func fetchConfig() async -> AgentConfig? {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/agent/config"))
        request.timeoutInterval = 5
        guard (try? authorized(&request)) != nil else { return nil }
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200
        else { return nil }
        return AgentConfig.decode(from: data)
    }

    /// `GET /api/events` — SSE. Yields until the stream drops; the caller reconnects.
    public func streamEvents(_ onEvent: @escaping @Sendable (ServerEvent) -> Void) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/events"))
        try authorized(&request)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // The session's own 15 s timeout is an *idle* timeout, which is what an event stream wants;
        // a per-request timeout would cut a healthy quiet stream instead.
        request.timeoutInterval = 24 * 60 * 60

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw CoreClientError.badResponse }
        guard http.statusCode == 200 else {
            if http.statusCode == 401 { invalidateToken() }
            throw CoreClientError.http(http.statusCode, nil)
        }
        AgentLog.debug("SSE stream open")

        // Split on newlines by hand rather than using `bytes.lines`: Foundation's
        // AsyncLineSequence swallows empty lines, and the empty line is precisely what terminates
        // an SSE frame — with it, no event is ever dispatched.
        var parser = SSEFrameParser()
        var line: [UInt8] = []
        for try await byte in bytes {
            guard byte != UInt8(ascii: "\n") else {
                if line.last == UInt8(ascii: "\r") { line.removeLast() }
                if let event = parser.feed(String(decoding: line, as: UTF8.self)) { onEvent(event) }
                line.removeAll(keepingCapacity: true)
                continue
            }
            line.append(byte)
            // A stream that never sends a newline must not grow without bound.
            if line.count > 1 << 20 { line.removeAll(keepingCapacity: false) }
        }
    }

    // MARK: - Launching core

    public enum LaunchResult: Sendable {
        case launched(String)
        case noLauncher
        case failed(String)
    }

    /// Locations the launcher may live in, most specific first. The script itself is generated by
    /// scripts/build.sh, which is the only place that knows where the repository is.
    public static func launcherCandidates() -> [URL] {
        var candidates: [URL] = []
        if let bundled = Bundle.main.url(forResource: "start-core", withExtension: "sh") {
            candidates.append(bundled)
        }
        if let override = ProcessInfo.processInfo.environment["LVF_CORE_LAUNCHER"], !override.isEmpty {
            candidates.append(URL(fileURLWithPath: override))
        }
        candidates.append(
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/LocalVoiceFlow", isDirectory: true)
                .appendingPathComponent("start-core.sh", isDirectory: false)
        )
        return candidates
    }

    /// Starts core through its launcher script. Always argv arrays with `shell: false` semantics —
    /// `Process` never goes through a shell here, and no user text is ever part of the arguments.
    @discardableResult
    public func launchCore() -> LaunchResult {
        let fm = FileManager.default
        guard let script = Self.launcherCandidates().first(where: { fm.isExecutableFile(atPath: $0.path) }) else {
            AgentLog.error("no executable core launcher found")
            return .noLauncher
        }

        // Executed directly via its shebang, not through `sh -c`: no string is ever handed to a
        // shell for interpretation.
        let process = Process()
        process.executableURL = script
        process.arguments = []
        process.currentDirectoryURL = script.deletingLastPathComponent()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        // Hand over only what the launcher needs; the agent's full environment stays private.
        var environment: [String: String] = [
            "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
            "HOME": fm.homeDirectoryForCurrentUser.path,
        ]
        if let port = ProcessInfo.processInfo.environment["LVF_PORT"] { environment["LVF_PORT"] = port }
        process.environment = environment

        do {
            try process.run()
            AgentLog.info("core launcher started: \(script.lastPathComponent)")
            return .launched(script.path)
        } catch {
            AgentLog.error("core launcher failed: \(error.localizedDescription)")
            return .failed(error.localizedDescription)
        }
    }

    // MARK: - Helpers

    static func percentEncoded(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    static func errorMessage(from data: Data) -> String? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let error = root["error"] as? [String: Any]
        else { return nil }
        let code = error["code"] as? String
        let message = error["message"] as? String
        return [code, message].compactMap { $0 }.joined(separator: ": ")
    }

    static func parseEvent(_ json: String) -> ServerEvent? {
        guard let data = json.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = root["type"] as? String
        else { return nil }

        switch type {
        case "hello":
            return .hello(version: root["version"] as? String ?? "")
        case "pipeline":
            guard let id = root["dictationId"] as? String,
                  let rawStage = root["stage"] as? String,
                  let stage = PipelineStage(rawValue: rawStage)
            else { return nil }
            return .pipeline(dictationId: id, stage: stage, text: root["text"] as? String)
        case "stt-status":
            return .sttStatus(
                ready: root["ready"] as? Bool ?? false,
                state: root["state"] as? String ?? "unknown",
                error: root["error"] as? String
            )
        case "settings-changed":
            return .settingsChanged
        default:
            return nil
        }
    }
}

public enum AgentInfo {
    /// Kept in step with CFBundleShortVersionString in Resources/Info.plist.
    public static let version = "0.1.0"
}
