import AVFoundation
import Foundation

public struct AudioCapture: Sendable {
    public var fileURL: URL
    public var durationMs: Int
    public var peakAmplitude: Float
    public var sampleCount: Int
}

public enum AudioRecorderError: Error, CustomStringConvertible {
    case engineStartFailed(String)
    case converterUnavailable
    case noSamples
    case writeFailed(String)

    public var description: String {
        switch self {
        case .engineStartFailed(let reason): return "audio engine failed to start: \(reason)"
        case .converterUnavailable: return "cannot convert input format to 16 kHz mono"
        case .noSamples: return "no audio samples captured"
        case .writeFailed(let reason): return "cannot write WAV: \(reason)"
        }
    }
}

/// Captures the microphone into a 16 kHz mono 16-bit PCM WAV — exactly the format the MLX Whisper
/// worker wants, so core never has to re-encode.
///
/// The tap runs on a real-time audio thread; everything it touches is guarded by `lock` and the
/// conversion happens inline so no unbounded queue can build up.
public final class AudioRecorder {
    public static let targetSampleRate: Double = 16_000

    /// Fired when `maxDurationSeconds` is hit. Delivered on the main queue.
    public var onMaxDurationReached: (() -> Void)?
    /// Live peak level for the HUD, 0...1. Delivered on the main queue, throttled.
    public var onLevel: ((Float) -> Void)?

    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private let targetFormat: AVAudioFormat

    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private var samples: [Int16] = []
    private var peak: Float = 0
    private var isRecording = false
    private var maxSamples: Int = Int(targetSampleRate) * 180
    private var maxDurationFired = false
    private var configurationObserver: NSObjectProtocol?
    private var lastLevelReport: Double = 0

    public init() {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Self.targetSampleRate,
            channels: 1,
            interleaved: false
        ) else {
            preconditionFailure("16 kHz mono Float32 is always representable")
        }
        targetFormat = format

        // An input device appearing, disappearing or changing sample rate invalidates the tap.
        // Rebuild it in place instead of dying, and keep every sample captured so far.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            self?.handleConfigurationChange()
        }
    }

    deinit {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
        }
        if engine.isRunning { engine.stop() }
    }

    public var recording: Bool {
        lock.lock(); defer { lock.unlock() }
        return isRecording
    }

    /// Current capture duration in milliseconds, derived from the sample count so it stays exact
    /// even when the engine was restarted mid-capture.
    public var currentDurationMs: Int {
        lock.lock(); defer { lock.unlock() }
        return Int(Double(samples.count) / Self.targetSampleRate * 1000)
    }

    public func start(maxDurationSeconds: Double) throws {
        lock.lock()
        guard !isRecording else { lock.unlock(); return }
        samples.removeAll(keepingCapacity: true)
        samples.reserveCapacity(Int(Self.targetSampleRate * min(maxDurationSeconds, 300)))
        peak = 0
        maxDurationFired = false
        maxSamples = Int(Self.targetSampleRate * max(1, maxDurationSeconds))
        isRecording = true
        lock.unlock()

        do {
            try installTapAndStart()
        } catch {
            lock.lock(); isRecording = false; lock.unlock()
            throw error
        }
        AgentLog.debug("audio capture started")
    }

    /// Stops the engine and writes the WAV. Returns nil when nothing usable was captured.
    @discardableResult
    public func stopAndWriteWav(to directory: URL? = nil) throws -> AudioCapture {
        lock.lock()
        let wasRecording = isRecording
        isRecording = false
        lock.unlock()

        if wasRecording { teardownEngine() }

        lock.lock()
        let captured = samples
        let capturedPeak = peak
        samples.removeAll(keepingCapacity: false)
        peak = 0
        lock.unlock()

        guard !captured.isEmpty else { throw AudioRecorderError.noSamples }

        let dir = directory ?? FileManager.default.temporaryDirectory
        let url = dir.appendingPathComponent("lvf-\(UUID().uuidString).wav", isDirectory: false)
        let data = Self.wavData(samples: captured, sampleRate: Int(Self.targetSampleRate))
        do {
            try data.write(to: url, options: [.atomic])
        } catch {
            throw AudioRecorderError.writeFailed(error.localizedDescription)
        }

        let durationMs = Int(Double(captured.count) / Self.targetSampleRate * 1000)
        AgentLog.info("audio capture finished: \(durationMs) ms, peak \(String(format: "%.3f", capturedPeak))")
        return AudioCapture(
            fileURL: url,
            durationMs: durationMs,
            peakAmplitude: capturedPeak,
            sampleCount: captured.count
        )
    }

    /// Aborts without writing anything.
    public func discard() {
        lock.lock()
        let wasRecording = isRecording
        isRecording = false
        samples.removeAll(keepingCapacity: false)
        peak = 0
        lock.unlock()
        if wasRecording {
            teardownEngine()
            AgentLog.debug("audio capture discarded")
        }
    }

    public static func deleteTempFile(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - Engine plumbing

    private func installTapAndStart() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw AudioRecorderError.engineStartFailed("input device reports an empty format")
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw AudioRecorderError.converterUnavailable
        }
        converter.sampleRateConverterQuality = AVAudioQuality.high.rawValue
        self.converter = converter
        converterInputFormat = inputFormat

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            self?.append(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw AudioRecorderError.engineStartFailed(error.localizedDescription)
        }
    }

    private func teardownEngine() {
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        converter = nil
        converterInputFormat = nil
    }

    private func handleConfigurationChange() {
        lock.lock()
        let active = isRecording
        lock.unlock()
        guard active else { return }

        AgentLog.warn("audio configuration changed; restarting engine, keeping captured samples")
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        converter = nil
        converterInputFormat = nil

        do {
            try installTapAndStart()
        } catch {
            // The device is gone for good. Keep what we have and let the caller finalise it;
            // dropping the whole dictation because a headset was unplugged is worse.
            AgentLog.error("audio engine restart failed: \(error)")
        }
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard isRecording, let converter, let inputFormat = converterInputFormat else {
            lock.unlock()
            return
        }
        lock.unlock()

        // A format change can race the tap; converting a mismatched buffer would corrupt the audio.
        guard buffer.format.sampleRate == inputFormat.sampleRate,
              buffer.format.channelCount == inputFormat.channelCount
        else { return }

        let ratio = Self.targetSampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard capacity > 0, let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            return
        }

        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }

        guard status != .error, output.frameLength > 0, let channel = output.floatChannelData?[0] else {
            if let conversionError { AgentLog.error("audio conversion failed: \(conversionError.code)") }
            return
        }

        let frames = Int(output.frameLength)
        var converted = [Int16](repeating: 0, count: frames)
        var localPeak: Float = 0
        for index in 0..<frames {
            let sample = channel[index]
            let clamped = max(-1, min(1, sample))
            // The peak is measured on the clamped sample, not the raw one. Core Audio hands
            // out Float32 that legitimately overshoots 1.0 (a hot USB mic, AGC), and the
            // longer the capture the likelier one such sample is — reporting 3.18 as a
            // "0...1 level" made core reject the whole upload and the recording was gone.
            let magnitude = abs(clamped)
            if magnitude > localPeak { localPeak = magnitude }
            // 32767 rather than 32768 so +1.0 maps to Int16.max instead of wrapping.
            converted[index] = Int16(clamped * 32767)
        }

        lock.lock()
        guard isRecording else { lock.unlock(); return }
        samples.append(contentsOf: converted)
        if localPeak > peak { peak = localPeak }
        let total = samples.count
        let reachedMax = total >= maxSamples && !maxDurationFired
        if reachedMax { maxDurationFired = true }
        let now = ProcessInfo.processInfo.systemUptime
        let shouldReportLevel = now - lastLevelReport > 0.08
        if shouldReportLevel { lastLevelReport = now }
        lock.unlock()

        if shouldReportLevel, let onLevel {
            DispatchQueue.main.async { onLevel(localPeak) }
        }
        if reachedMax, let onMaxDurationReached {
            AgentLog.warn("audio capture hit the maximum duration")
            DispatchQueue.main.async { onMaxDurationReached() }
        }
    }

    // MARK: - WAV

    /// Canonical 44-byte RIFF/WAVE header followed by little-endian Int16 samples.
    static func wavData(samples: [Int16], sampleRate: Int, channels: Int = 1) -> Data {
        let bitsPerSample = 16
        let byteRate = sampleRate * channels * bitsPerSample / 8
        let blockAlign = channels * bitsPerSample / 8
        let dataBytes = samples.count * MemoryLayout<Int16>.size

        var data = Data(capacity: 44 + dataBytes)
        func appendASCII(_ value: String) { data.append(contentsOf: Array(value.utf8)) }
        func appendUInt32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func appendUInt16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }

        appendASCII("RIFF")
        appendUInt32(UInt32(36 + dataBytes))
        appendASCII("WAVE")
        appendASCII("fmt ")
        appendUInt32(16)
        appendUInt16(1) // PCM
        appendUInt16(UInt16(channels))
        appendUInt32(UInt32(sampleRate))
        appendUInt32(UInt32(byteRate))
        appendUInt16(UInt16(blockAlign))
        appendUInt16(UInt16(bitsPerSample))
        appendASCII("data")
        appendUInt32(UInt32(dataBytes))

        // Int16 in memory is already little-endian on every Apple Silicon Mac, which is what the
        // WAV data chunk requires, so the samples can go out as raw bytes.
        samples.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }
}
