// ClapListener — native macOS background listener.
// Two sharp claps within a short window → open JARVIS OS.app (by absolute path, never by name).
//
// Detection is GAIN-INDEPENDENT: a clap is a sharp spike relative to the room's
// background level, so it works on any mic at any input volume (built-in, USB,
// iPhone Continuity) instead of a fixed absolute threshold. The audio engine also
// SELF-HEALS — it restarts on device/config changes and if audio ever stops flowing,
// which is the usual cause of "it just stopped working".

import Foundation
import AVFoundation
import AppKit
import Speech

// ---- tunable config (env-overridable, no recompile needed) ----
func envDouble(_ key: String, _ fallback: Double) -> Double {
    if let s = ProcessInfo.processInfo.environment[key], let v = Double(s) { return v }
    return fallback
}
let DEBUG = ProcessInfo.processInfo.environment["CLAP_DEBUG"] == "1"

let CLAP_RATIO = envDouble("CLAP_RATIO", 8.0)        // a clap must exceed this × the background level
let CLAP_FLOOR = envDouble("CLAP_FLOOR", 4.5)        // …and this absolute minimum (stops silence false-fires)
let CLAP_COUNT  = Int(envDouble("CLAP_COUNT", 2))     // how many claps in the window to trigger
let MIN_GAP_MS  = envDouble("CLAP_MIN_GAP_MS", 120)   // ignore a single clap's ringing
let WINDOW_MS   = envDouble("CLAP_WINDOW_MS", 900)    // all claps must fall within this span
let COOLDOWN_MS = envDouble("CLAP_COOLDOWN_MS", 700)  // after a trigger fires
let LAUNCH_COOLDOWN_MS = envDouble("CLAP_LAUNCH_COOLDOWN_MS", 4000) // don't relaunch the target repeatedly

// ---- what a clap opens ----
// Resolved by ABSOLUTE PATH, with a bundle id as backup. `open -a <name>` was the old mechanism and
// it is the reason claps sometimes opened Claude: Launch Services name lookup is fuzzy, so when
// "JARVIS OS" failed to resolve for a moment (the bundle gets rewritten on every rebuild) it
// happily landed on a near-enough neighbour. A path either exists or it does not — nothing to
// mis-resolve. The old default was literally "Claude", so a single missing env var also sent every
// clap there; the default is now JARVIS, and Claude is not reachable from this file at all.
let CLAP_TARGET_PATH = ProcessInfo.processInfo.environment["CLAP_TARGET_PATH"]
    ?? (NSHomeDirectory() + "/JARVIS MK-1/jarvis-os/JARVIS OS.app")
let CLAP_TARGET_BUNDLE = ProcessInfo.processInfo.environment["CLAP_TARGET_BUNDLE"] ?? "com.jarvis.jarvisos.shell"
let CLAP_TARGET = (CLAP_TARGET_PATH as NSString).lastPathComponent   // for logging only

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
func log(_ msg: String) {
    FileHandle.standardError.write("[\(ISO8601DateFormatter().string(from: Date()))] \(msg)\n".data(using: .utf8)!)
}

// ============================================================================
// MARK: - Adaptive clap detector
// ============================================================================

final class ClapDetector {
    private var clapTimes: [Double] = []
    private var lastClapAt: Double = 0
    private var armed = true
    private var cooldownUntil: Double = 0
    private var lastLaunchAt: Double = 0
    private var background = 0.03            // slow estimate of the quiet-room level

    func process(peak: Double) {
        let t = nowMs()
        // Adapt the background using only non-clap (low) peaks so claps don't inflate it.
        if peak < background * 4 { background = background * 0.995 + peak * 0.005 }
        let floor = max(CLAP_FLOOR, background * CLAP_RATIO)   // scale-independent trigger level

        if peak >= floor && armed && t > cooldownUntil {
            if DEBUG { log(String(format: "clap-candidate peak=%.3f floor=%.3f bg=%.3f", peak, floor, background)) }
            registerClap(t)
            armed = false
        } else if peak < floor * 0.5 {
            armed = true                                       // re-arm once the transient decays
        }
    }

    private func registerClap(_ t: Double) {
        if t - lastClapAt < MIN_GAP_MS { return }
        lastClapAt = t
        clapTimes = clapTimes.filter { t - $0 <= WINDOW_MS }
        clapTimes.append(t)
        log("clap \(clapTimes.count)")
        if clapTimes.count >= CLAP_COUNT {
            clapTimes.removeAll()
            cooldownUntil = t + COOLDOWN_MS
            activate(t)
        }
    }

    private func activate(_ t: Double) {
        if t - lastLaunchAt < LAUNCH_COOLDOWN_MS {
            log("\(CLAP_COUNT) claps detected — within launch cooldown, ignoring"); return
        }
        lastLaunchAt = t
        // Exact path first, bundle id second, and NOTHING third — see openJarvis(). Shared with the
        // wake-word path so there is one definition of what opening JARVIS means; two copies is how
        // one of them ends up still saying "Claude".
        openJarvis(reason: "\(CLAP_COUNT) CLAPS")
    }
}

// ============================================================================
// MARK: - Wake word ("hey jarvis")
// ============================================================================
// Lives in THIS process, on the SAME microphone tap as the clap detector, for one reason: two
// processes fighting over the input device is what broke every previous voice agent here (~143
// audio restarts were logged against the last pair). One tap, fanned out to two consumers, cannot
// contend with itself.
//
// ON-DEVICE, ALWAYS. `requiresOnDeviceRecognition = true` keeps every sample on this Mac. The
// browser's Web Speech API — the obvious alternative — streams microphone audio to Google, which
// would put a 24/7 open channel to a third party inside a system deliberately built around a local
// model. If on-device recognition is unavailable, this feature turns ITSELF OFF rather than
// silently falling back to the cloud.
//
// NOT gated on the clap threshold. Claps must be loud to avoid false fires; a wake word must work
// at the volume a person actually speaks at. So the recogniser is fed every buffer regardless of
// level, and only the CLAP path keeps its high floor.

let WAKE_ENABLED = ProcessInfo.processInfo.environment["JARVIS_WAKE"] != "0"
// JARVIS_WAKE_DEBUG=1 logs every transcript the recogniser produces and every restart. Off by
// default because it writes what the microphone heard to a log file — fine for a minute of
// diagnosis, not something to leave running in the room he lives in.
let WAKE_DEBUG = ProcessInfo.processInfo.environment["JARVIS_WAKE_DEBUG"] == "1"
let WAKE_COOLDOWN_MS = envDouble("JARVIS_WAKE_COOLDOWN_MS", 6000)
// A recognition task is restarted on this cadence. Long-running tasks stop yielding results (and
// on-device tasks accumulate memory), and a recogniser that has quietly died is indistinguishable
// from a room that has gone quiet — which is how "it worked yesterday" happens.
let WAKE_RECYCLE_S = envDouble("JARVIS_WAKE_RECYCLE_S", 50)
let JARVIS_PORT = Int(envDouble("JARVIS_PORT", 8787))

// Heard loosely on purpose. On-device recognition mis-hears a short, unusual proper noun constantly
// — "hey jarvis" comes back as "hey jarvis", "hey jarvic", "hey service", "a jarvis". Requiring the
// exact string means a wake word that works for the person who wrote it and nobody else. False
// positives cost one window coming forward; false negatives cost the whole feature.

// Detection threshold — 0.5, the model's own default. It was lowered to 0.3 and that was WRONG,
// and the way it was wrong is worth keeping written down.
//
// The case for 0.3 was that the scores are bimodal: six of his recordings scored 0.362-0.989 while
// ten non-wake phrases scored 0.000, with nothing in between. Both halves of that were true and the
// conclusion still did not hold, because the negative set was ten phrases SYNTHESISED by a TTS voice
// — clean speech, one speaker, no room. It contained no music, no video audio, no television, and
// none of the ordinary noise a microphone in a room actually hears. That limitation was written down
// at the time and shipped anyway.
//
// The room then produced the measurement that mattered. Nineteen in-room wakes are now on record:
//
//   0.315 0.334 0.335 0.340 0.349 0.353 0.357 0.380 0.389 0.421   <- fired only under 0.3; false
//   0.522 0.559 0.631 0.647 0.649 0.655 0.910 0.942 0.974         <- genuine, all clear 0.5
//
// Seven false wakes in a single day, opening the window unasked, in a tight band from 0.33 to 0.38.
// The real gap in this room is 0.421 to 0.522, and 0.5 sits inside it. The lesson is not "0.3 was
// too low" but that a false-accept rate measured against synthesised speech says nothing about a
// room, and a threshold is a claim about the ROOM. If it is ever lowered again, lower it against
// recordings of this room with the television on — not against a TTS voice.
let WAKE_THRESHOLD = Float(envDouble("JARVIS_WAKE_THRESHOLD", 0.5))

final class WakeWord {
    // NEURAL, NOT TRANSCRIPTION. SFSpeechRecognizer held a localspeechrecognition XPC service at
    // ~112 MB for the life of this process — running full speech-to-text over the room, continuously,
    // to catch one phrase. This is openWakeWord's pretrained "hey jarvis": a 1.2 MB classifier on a
    // 2.3 MB frozen feature extractor, measured at 38.7 MB with all three graphs loaded IN THIS
    // PROCESS, so the second process disappears as well. It also cannot transcribe: the only thing
    // it can report is how much a sound resembled the phrase.
    private var detector: OnnxWakeDetector?
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000,
                                       channels: 1, interleaved: false)!
    private let lock = NSLock()
    private var pending: [Float] = []
    private var lastFireAt: Double = 0
    private var available = false
    // Inference runs OFF the audio thread. Three ONNX graphs per 80 ms chunk is not work for a
    // realtime callback — blocking it drops buffers, and the clap detector shares this same tap.
    private let infer = DispatchQueue(label: "jarvis.wake.infer", qos: .utility)

    func enable() {
        guard WAKE_ENABLED else { log("wake word disabled (JARVIS_WAKE=0)"); return }
        let dir = (Bundle.main.resourcePath ?? ".") + "/models"
        guard let d = OnnxWakeDetector(modelDir: dir) else {
            log("⚠ wake word off — could not load models from \(dir); ⌘ claps still work"); return
        }
        detector = d
        available = true
        log("wake word armed — “hey jarvis”, on-device neural, threshold \(WAKE_THRESHOLD)")
    }

    // AUDIO THREAD. Resamples to 16 kHz mono, queues the samples, returns. Never runs a model here.
    func feed(_ buffer: AVAudioPCMBuffer) {
        guard available, let s = resample(buffer) else { return }
        lock.lock(); pending.append(contentsOf: s); let ready = pending.count >= 1280; lock.unlock()
        if ready { infer.async { [weak self] in self?.drain() } }
    }

    // The tap runs at whatever the hardware gives (48 kHz here); the graphs want 16 kHz mono, and
    // they want int16 MAGNITUDES rather than normalised floats — feeding ±1.0 scores nothing at all.
    private func resample(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        if converter == nil || sourceFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: target)
            sourceFormat = buffer.format
        }
        guard let converter else { return nil }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return nil }
        var err: NSError?
        var handed = false
        converter.convert(to: out, error: &err) { _, status in
            if handed { status.pointee = .noDataNow; return nil }
            handed = true; status.pointee = .haveData; return buffer
        }
        guard err == nil, let ch = out.floatChannelData?[0] else { return nil }
        return (0..<Int(out.frameLength)).map { ch[$0] * 32767 }
    }

    private func drain() {
        while true {
            lock.lock()
            guard pending.count >= 1280 else { lock.unlock(); return }
            let chunk = Array(pending.prefix(1280))
            pending.removeFirst(1280)
            lock.unlock()
            if let score = detector?.feed(chunk), score > WAKE_THRESHOLD {
                DispatchQueue.main.async { [weak self] in self?.fired(score) }
            }
        }
    }

    private func fired(_ score: Float) {
        // JARVIS talking to himself. These speakers play into the same room this microphone listens
        // to, so his own voice saying the phrase would wake him, which opens the window, which
        // produces another reply — a loop with nothing to break it.
        if jarvisIsSpeaking() { log("wake ignored — that was my own voice"); return }
        let t = nowMs()
        // One utterance spans many 80 ms chunks and scores high across several of them. Without a
        // cooldown, saying it once launches the app repeatedly.
        guard t - lastFireAt > WAKE_COOLDOWN_MS else { return }
        lastFireAt = t
        log(String(format: "✦ WAKE — score %.3f", score))
        // The phrase is still inside the 16-embedding window; without clearing it the next chunks
        // keep scoring against the same utterance.
        detector?.reset()
        // Tell the running app to start listening, THEN bring it forward: the window collects the
        // flag when it gets focus, so posting second would race the focus event.
        postWake()
        openJarvis(reason: "wake word")
    }
}



// Is JARVIS mid-sentence on a line that contains his own name? The window writes an epoch-ms ceiling
// here when it starts such an utterance and zeroes it when the utterance ends. Absent, unreadable or
// stale all mean "not speaking" — a suppression flag that fails CLOSED would silently disable the
// wake word, which is the failure this feature has already had once.
func jarvisIsSpeaking() -> Bool {
    let p = NSHomeDirectory() + "/JARVIS MK-1/jarvis-os/state/.speaking"
    guard let s = try? String(contentsOfFile: p, encoding: .utf8),
          let until = Double(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
    return nowMs() < until
}

// The token the server wrote for its own API. Read fresh each time rather than cached — the server
// regenerates it, and a daemon holding a stale token fails silently and forever.
func apiToken() -> String? {
    let p = NSHomeDirectory() + "/JARVIS MK-1/jarvis-os/state/.apitoken"
    guard let s = try? String(contentsOfFile: p, encoding: .utf8) else { return nil }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
}

func postWake() {
    guard let token = apiToken() else { log("wake: no API token — cannot arm the window"); return }
    guard let url = URL(string: "http://127.0.0.1:\(JARVIS_PORT)/api/wake") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue(token, forHTTPHeaderField: "x-jarvis-token")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data("{}".utf8)
    req.timeoutInterval = 4
    URLSession.shared.dataTask(with: req) { _, resp, err in
        if let e = err { log("wake: could not reach JARVIS (\(e.localizedDescription)) — opening the app anyway") }
        else if let h = resp as? HTTPURLResponse, h.statusCode != 200 { log("wake: JARVIS answered \(h.statusCode)") }
    }.resume()
}

// Shared by the clap path and the wake path so there is ONE definition of what "open JARVIS" means —
// by absolute path, with a bundle id as backup, and nothing third. See the note on CLAP_TARGET_PATH.
func openJarvis(reason: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    if FileManager.default.fileExists(atPath: CLAP_TARGET_PATH) {
        log("✦ \(reason) → opening \(CLAP_TARGET) (by path)")
        p.arguments = [CLAP_TARGET_PATH]
    } else {
        log("✦ \(reason) → opening \(CLAP_TARGET_BUNDLE) (by bundle id — path missing: \(CLAP_TARGET_PATH))")
        p.arguments = ["-b", CLAP_TARGET_BUNDLE]
    }
    do { try p.run() } catch { log("failed to launch \(CLAP_TARGET): \(error) — opening nothing rather than guessing") }
}

// ============================================================================
// MARK: - Self-healing audio manager
// ============================================================================

final class AudioManager {
    let engine = AVAudioEngine()
    let detector = ClapDetector()
    let wake = WakeWord()
    private var lastBufferAt = Date()
    private var restarts = 0
    private var started = false
    // NO MICROPHONE IS A NORMAL STATE on a Mac mini, Studio or Pro with nothing plugged in. Retrying every
    // second forever wrote a log line a second; back off to 30 s and log sparsely. Plugging a mic in (or
    // connecting AirPods) fires AVAudioEngineConfigurationChange, which restarts at once regardless.
    private var noInputTries = 0
    private func retryLater(_ why: String) {
        noInputTries += 1
        let delay = min(30.0, pow(2.0, Double(min(noInputTries - 1, 5))))
        if noInputTries == 1 || noInputTries % 10 == 0 { log("\(why) — retrying in \(Int(delay))s (attempt \(noInputTries))") }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.startTap() }
    }

    func startTap() {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let format = input.inputFormat(forBus: 0)   // FRESH format every (re)start — survives device changes
        guard format.channelCount > 0, format.sampleRate > 0 else {
            retryLater("⚠ no microphone / no valid input device (fmt=\(format.sampleRate)/\(format.channelCount)ch)")
            return
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.handle(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
            let dev = AVCaptureDevice.default(for: .audio)?.localizedName ?? "?"
            log("ClapListener listening — device=\"\(dev)\" fmt=\(Int(format.sampleRate))Hz/\(format.channelCount)ch · ratio=\(CLAP_RATIO) floor=\(CLAP_FLOOR) · \(CLAP_COUNT) claps.")
            started = true
            noInputTries = 0
            lastBufferAt = Date()
        } catch {
            retryLater("engine start failed: \(error)")
        }
    }

    private func handle(_ buffer: AVAudioPCMBuffer) {
        lastBufferAt = Date()
        // ONE tap, two consumers. The wake recogniser gets every buffer unconditionally — a clap has
        // to be loud to avoid false fires, but speech has to be recognised at conversational volume,
        // so gating the recogniser on the clap threshold would mean only shouted wake words worked.
        wake.feed(buffer)

        guard let ch = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        var peak: Float = 0
        for i in 0..<n { let v = abs(ch[i]); if v > peak { peak = v } }
        if DEBUG && Double(peak) > CLAP_FLOOR * 0.5 { log(String(format: "peak=%.3f", peak)) }
        detector.process(peak: Double(peak))
    }

    func restart(_ reason: String) {
        restarts += 1
        log("↻ restarting audio (\(reason)) [#\(restarts)]")
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.startTap() }
    }

    func installWatchdogs() {
        // Device/format changed (mic added/removed, default switched) → the classic silent-input cause.
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restart("audio config changed")
        }
        // If buffers stop arriving (engine wedged), restart it.
        Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            guard let self = self, self.started else { return }
            if Date().timeIntervalSince(self.lastBufferAt) > 5 { self.restart("no audio for 5s") }
            else if !self.engine.isRunning { self.restart("engine stopped") }
        }
    }
}

// ============================================================================
// MARK: - main
// ============================================================================

let audio = AudioManager()

// ============================================================================
// MARK: - Single-instance guard
// ============================================================================
// A SECOND copy of this daemon is genuinely harmful, not merely wasteful. One was found running
// from the day before a rebuild: launched through Launch Services rather than by launchd, so it
// inherited none of the plist environment — no CLAP_TARGET (falling back to the old compiled
// default) and no CLAP_FLOOR (falling back to 0.08, sensitive enough that typing set it off).
// Two listeners shared the microphone and opened different apps, which is exactly what "it
// sometimes opens the wrong thing" looked like from outside.
//
// An advisory flock is the right tool: the lock dies with the process, so a crash cannot leave a
// stale lock that blocks the next honest start — which a pidfile would.
func claimSingleInstance() {
    let lockPath = (NSHomeDirectory() as NSString).appendingPathComponent("JARVIS MK-1/clap-daemon/.instance.lock")
    let fd = open(lockPath, O_CREAT | O_RDWR, 0o644)
    guard fd >= 0 else { return }               // cannot lock → carry on rather than refuse to run
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
        log("another ClapListener already holds the lock — exiting so the two do not fight over the mic")
        exit(0)
    }
    // Deliberately leaked: the descriptor must outlive this function or the lock is released.
    _ = fd
}

func boot() {
    claimSingleInstance()
    audio.installWatchdogs()
    audio.startTap()
    // Armed after the tap, so the first buffers it sees are real audio rather than none.
    audio.wake.enable()
}

switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    boot()
case .notDetermined:
    log("requesting microphone permission…")
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        if granted { DispatchQueue.main.async { boot() } }
        else { log("microphone permission denied"); exit(1) }
    }
case .denied, .restricted:
    log("microphone access denied/restricted — enable it in System Settings → Privacy & Security → Microphone")
    exit(1)
@unknown default:
    boot()
}

RunLoop.main.run()
