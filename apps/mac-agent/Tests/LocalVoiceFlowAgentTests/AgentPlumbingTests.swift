import Carbon.HIToolbox
import XCTest

@testable import LocalVoiceFlowAgent

/// The remaining pure pieces: shortcut parsing, the SSE frame decoder, the tolerant config decoder
/// and the WAV header. None of them need a device, a network or TCC.
final class AgentPlumbingTests: XCTestCase {
    // MARK: - HotkeySpec

    func testParsesTheDefaultFallbackHotkey() {
        let spec = HotkeySpec.parse("control+option+space")
        XCTAssertEqual(spec?.keyCode, UInt32(kVK_Space))
        XCTAssertEqual(spec?.carbonModifiers, UInt32(controlKey) | UInt32(optionKey))
        XCTAssertEqual(spec?.display, "⌃⌥Space")
    }

    func testParsesAliasesAndLetters() {
        let spec = HotkeySpec.parse("cmd+shift+d")
        XCTAssertEqual(spec?.keyCode, UInt32(kVK_ANSI_D))
        XCTAssertEqual(spec?.carbonModifiers, UInt32(cmdKey) | UInt32(shiftKey))
    }

    func testRejectsShortcutsWithoutModifiers() {
        // A bare key would swallow ordinary typing.
        XCTAssertNil(HotkeySpec.parse("space"))
    }

    func testRejectsUnknownKeys() {
        XCTAssertNil(HotkeySpec.parse("control+option+нечто"))
        XCTAssertNil(HotkeySpec.parse(""))
    }

    // MARK: - SSE frames

    func testParsesPipelineEvent() {
        let json = #"{"type":"pipeline","dictationId":"dct_1","stage":"correcting","status":"correcting","at":"x"}"#
        guard case .pipeline(let id, let stage, let text)? = CoreClient.parseEvent(json) else {
            return XCTFail("expected a pipeline event")
        }
        XCTAssertEqual(id, "dct_1")
        XCTAssertEqual(stage, .correcting)
        XCTAssertNil(text)
    }

    func testParsesTheTranscriptCarriedByTheTranscribedStage() {
        let json = #"{"type":"pipeline","dictationId":"dct_1","stage":"transcribed","status":"correcting","at":"x","text":"привет useEffect"}"#
        guard case .pipeline(_, let stage, let text)? = CoreClient.parseEvent(json) else {
            return XCTFail("expected a pipeline event")
        }
        XCTAssertEqual(stage, .transcribed)
        XCTAssertEqual(text, "привет useEffect")
    }

    func testParsesSttStatusAndHello() {
        guard case .sttStatus(let ready, let state, _)? = CoreClient.parseEvent(
            #"{"type":"stt-status","at":"x","ready":true,"state":"ready","model":"m"}"#
        ) else { return XCTFail("expected an stt-status event") }
        XCTAssertTrue(ready)
        XCTAssertEqual(state, "ready")

        guard case .hello(let version)? = CoreClient.parseEvent(#"{"type":"hello","at":"x","version":"0.1.0"}"#) else {
            return XCTFail("expected a hello event")
        }
        XCTAssertEqual(version, "0.1.0")
    }

    func testIgnoresUnknownAndMalformedFrames() {
        XCTAssertNil(CoreClient.parseEvent(#"{"type":"something-new"}"#))
        XCTAssertNil(CoreClient.parseEvent("not json"))
        XCTAssertNil(CoreClient.parseEvent(#"{"type":"pipeline","stage":"nope"}"#))
    }

    // MARK: - SSE framing

    func testFrameIsEmittedOnlyOnTheBlankLineThatTerminatesIt() {
        var parser = SSEFrameParser()
        XCTAssertNil(parser.feed(#"data: {"type":"hello","at":"x","version":"0.1.0"}"#))
        guard case .hello(let version)? = parser.feed("") else {
            return XCTFail("the blank line must flush the frame")
        }
        XCTAssertEqual(version, "0.1.0")
    }

    func testConsecutiveFramesDoNotBleedIntoEachOther() {
        var parser = SSEFrameParser()
        _ = parser.feed(#"data: {"type":"hello","at":"x","version":"0.1.0"}"#)
        _ = parser.feed("")
        XCTAssertNil(parser.feed(#"data: {"type":"settings-changed","at":"x"}"#))
        guard case .settingsChanged? = parser.feed("") else {
            return XCTFail("expected the second frame on its own")
        }
        XCTAssertNil(parser.feed(""), "an empty frame yields nothing")
    }

    func testHeartbeatCommentsAndMultiLineDataAreHandled() {
        var parser = SSEFrameParser()
        XCTAssertNil(parser.feed(": keep-alive"))
        XCTAssertNil(parser.feed(#"data: {"type":"pipeline","dictationId":"dct_2","#))
        XCTAssertNil(parser.feed(#"data: "stage":"completed","status":"completed","at":"x"}"#))
        guard case .pipeline(let id, let stage, _)? = parser.feed("") else {
            return XCTFail("a frame split across two data: lines must still parse")
        }
        XCTAssertEqual(id, "dct_2")
        XCTAssertEqual(stage, .completed)
    }

    // MARK: - Header encoding

    func testAppNameIsPercentEncodedForTheHeader() {
        // Header values must be ASCII; Cyrillic app names and spaces both have to survive.
        XCTAssertEqual(CoreClient.percentEncoded("Заметки 2"), "%D0%97%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B8%202")
        XCTAssertEqual(CoreClient.percentEncoded("Safari"), "Safari")
    }

    func testErrorMessageIsExtractedFromTheCoreErrorEnvelope() {
        let data = #"{"error":{"code":"llm_timeout","message":"took too long"}}"#.data(using: .utf8)!
        XCTAssertEqual(CoreClient.errorMessage(from: data), "llm_timeout: took too long")
        XCTAssertNil(CoreClient.errorMessage(from: Data("{}".utf8)))
    }

    // MARK: - AgentConfig

    func testDecodesTheFlatProjection() {
        let json = """
        {"enabled":true,"hudEnabled":false,"doubleTapWindowMs":220,"minRecordingMs":120,
         "maxRecordingSeconds":90,"endLockedRecordingWithEnter":true,
         "targetChangedBehavior":"paste-into-current-app","clipboardRestoreDelayMs":900}
        """
        let config = AgentConfig.decode(from: Data(json.utf8))
        XCTAssertFalse(config.hudEnabled)
        XCTAssertEqual(config.doubleTapWindowMs, 220)
        XCTAssertEqual(config.minRecordingMs, 120)
        XCTAssertEqual(config.maxRecordingSeconds, 90)
        XCTAssertTrue(config.endLockedRecordingWithEnter)
        XCTAssertEqual(config.targetChangedBehavior, .pasteIntoCurrentApp)
        XCTAssertEqual(config.clipboardRestoreDelayMs, 900)
        XCTAssertEqual(config.dictationConfig.doubleTapWindowMs, 220)
    }

    func testDecodesTheWholeSettingsObjectToo() {
        let json = """
        {"general":{"hudEnabled":false,"fallbackHotkey":"control+shift+d","minRecordingMs":200},
         "correction":{"sendWindowTitle":true}}
        """
        let config = AgentConfig.decode(from: Data(json.utf8))
        XCTAssertFalse(config.hudEnabled)
        XCTAssertEqual(config.fallbackHotkey, "control+shift+d")
        XCTAssertEqual(config.minRecordingMs, 200)
        XCTAssertTrue(config.sendWindowTitle)
    }

    func testUnknownOrBrokenPayloadFallsBackToDefaults() {
        let config = AgentConfig.decode(from: Data("[]".utf8))
        XCTAssertEqual(config, AgentConfig())
        XCTAssertEqual(config.fallbackHotkey, "control+option+space")
        XCTAssertEqual(config.doubleTapWindowMs, 350)
    }

    // MARK: - WAV

    func testWavHeaderDescribes16kHzMono16Bit() {
        let samples: [Int16] = [0, 1000, -1000, 32767, -32768]
        let data = AudioRecorder.wavData(samples: samples, sampleRate: 16_000)

        XCTAssertEqual(data.count, 44 + samples.count * 2)
        XCTAssertEqual(String(data: data.subdata(in: 0..<4), encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: data.subdata(in: 8..<12), encoding: .ascii), "WAVE")
        XCTAssertEqual(String(data: data.subdata(in: 12..<16), encoding: .ascii), "fmt ")
        XCTAssertEqual(String(data: data.subdata(in: 36..<40), encoding: .ascii), "data")

        func uint32(_ offset: Int) -> UInt32 {
            data.subdata(in: offset..<(offset + 4)).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
        }
        func uint16(_ offset: Int) -> UInt16 {
            data.subdata(in: offset..<(offset + 2)).withUnsafeBytes { $0.loadUnaligned(as: UInt16.self).littleEndian }
        }

        XCTAssertEqual(uint32(4), UInt32(36 + samples.count * 2), "RIFF chunk size")
        XCTAssertEqual(uint16(20), 1, "PCM format tag")
        XCTAssertEqual(uint16(22), 1, "mono")
        XCTAssertEqual(uint32(24), 16_000, "sample rate")
        XCTAssertEqual(uint32(28), 32_000, "byte rate")
        XCTAssertEqual(uint16(32), 2, "block align")
        XCTAssertEqual(uint16(34), 16, "bits per sample")
        XCTAssertEqual(uint32(40), UInt32(samples.count * 2), "data chunk size")
    }

    func testWavSamplesAreLittleEndianInOrder() {
        let data = AudioRecorder.wavData(samples: [0x0102, -2], sampleRate: 16_000)
        XCTAssertEqual([UInt8](data[44..<48]), [0x02, 0x01, 0xFE, 0xFF])
    }

    // MARK: - HUD

    func testDurationFormatting() {
        XCTAssertEqual(HUDController.formatDuration(0), "0:00")
        XCTAssertEqual(HUDController.formatDuration(9.9), "0:09")
        XCTAssertEqual(HUDController.formatDuration(65), "1:05")
        XCTAssertEqual(HUDController.formatDuration(-3), "0:00")
    }

    // MARK: - Launcher lookup

    func testLauncherCandidatesIncludeTheApplicationSupportFallback() {
        let candidates = CoreClient.launcherCandidates().map(\.path)
        XCTAssertTrue(
            candidates.contains { $0.hasSuffix("Library/Application Support/LocalVoiceFlow/start-core.sh") },
            "the agent must have a launcher location that does not depend on being bundled"
        )
    }
}
