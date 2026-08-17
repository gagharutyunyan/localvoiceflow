import Foundation
import os

/// Agent logging. Two sinks: the unified log (visible in Console.app) and a rolling text file next
/// to core's own logs.
///
/// Nothing here ever receives recognised text, clipboard contents or window titles — only ids,
/// lengths, durations and error codes. Call sites pass lengths instead of strings on purpose.
public enum AgentLog {
    public enum Level: Int, Comparable, Sendable {
        case debug = 0, info = 1, warn = 2, error = 3

        public static func < (lhs: Level, rhs: Level) -> Bool { lhs.rawValue < rhs.rawValue }

        var label: String {
            switch self {
            case .debug: return "DEBUG"
            case .info: return "INFO"
            case .warn: return "WARN"
            case .error: return "ERROR"
            }
        }
    }

    private static let subsystem = "com.localvoiceflow.agent"
    private static let osLog = os.Logger(subsystem: subsystem, category: "agent")
    private static let queue = DispatchQueue(label: "\(subsystem).log")
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _minimumLevel: Level = .info
    nonisolated(unsafe) private static var handle: FileHandle?
    nonisolated(unsafe) private static var handleOpened = false

    public static var minimumLevel: Level {
        get { lock.lock(); defer { lock.unlock() }; return _minimumLevel }
        set { lock.lock(); _minimumLevel = newValue; lock.unlock() }
    }

    public static var logFileURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/LocalVoiceFlow", isDirectory: true)
            .appendingPathComponent("agent.log", isDirectory: false)
    }

    public static func debug(_ message: String) { emit(.debug, message) }
    public static func info(_ message: String) { emit(.info, message) }
    public static func warn(_ message: String) { emit(.warn, message) }
    public static func error(_ message: String) { emit(.error, message) }

    private static func emit(_ level: Level, _ message: String) {
        guard level >= minimumLevel else { return }

        switch level {
        case .debug: osLog.debug("\(message, privacy: .public)")
        case .info: osLog.info("\(message, privacy: .public)")
        case .warn: osLog.warning("\(message, privacy: .public)")
        case .error: osLog.error("\(message, privacy: .public)")
        }

        let stamp = ISO8601DateFormatter.agent.string(from: Date())
        let line = "\(stamp) [\(level.label)] \(message)\n"
        queue.async { appendToFile(line) }
    }

    private static func appendToFile(_ line: String) {
        if !handleOpened {
            handleOpened = true
            let url = logFileURL
            let fm = FileManager.default
            try? fm.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            if !fm.fileExists(atPath: url.path) {
                fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            handle = try? FileHandle(forWritingTo: url)
            // Keep the file bounded; the agent runs for weeks at a time.
            if let opened = handle {
                let size = (try? opened.seekToEnd()) ?? 0
                if size > 4 * 1024 * 1024 {
                    try? opened.truncate(atOffset: 0)
                }
            }
        }
        guard let handle, let data = line.data(using: .utf8) else { return }
        try? handle.write(contentsOf: data)
    }
}

extension ISO8601DateFormatter {
    static let agent: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
