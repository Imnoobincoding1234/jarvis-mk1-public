// FocusGuard — context-aware Focus/notification agent.
//
//   • Watches gesture-control's log; when you ARM gesture control (two palms) it turns on
//     Do Not Disturb (via a Shortcut) and posts a banner; disarming turns it back off.
//   • Bonus: announces when the clap daemon summons Claude.
//
// Reads other agents' logs only — never modifies them. Needs only Notifications permission.
// (macOS has no API to read/suppress OTHER apps' notifications; Focus toggling is the
//  buildable "filter" — it silences everything while you're in hands-free mode.)

import Foundation
import AppKit
import UserNotifications

let env = ProcessInfo.processInfo.environment
let FOCUS_ON  = env["FOCUS_ON"]  ?? "AIC DND On"
let FOCUS_OFF = env["FOCUS_OFF"] ?? "AIC DND Off"
let POLL      = Double(env["POLL"] ?? "") ?? 1.0
// Defaults relative to THIS user's home — install.sh passes CLAP_LOG explicitly; these only apply when run by hand.
// (Gesture control was removed; its log path is kept so an old launchd plist that sets it still starts.)
let JARVIS_ROOT = NSHomeDirectory() + "/JARVIS MK-1"
let GESTURE_LOG = env["GESTURE_LOG"] ?? (JARVIS_ROOT + "/gesture-control/gesture.log")
let CLAP_LOG    = env["CLAP_LOG"]    ?? (JARVIS_ROOT + "/clap-daemon/clap.log")

func log(_ s: String) {
    FileHandle.standardError.write("[\(ISO8601DateFormatter().string(from: Date()))] \(s)\n".data(using: .utf8)!)
}

// ============================================================================
// MARK: - File helpers
// ============================================================================

func fileSize(_ path: String) -> UInt64 {
    ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? UInt64) ?? 0
}
func tailString(_ path: String, _ maxBytes: UInt64 = 65536) -> String? {
    guard let fh = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? fh.close() }
    let size = (try? fh.seekToEnd()) ?? 0
    let start = size > maxBytes ? size - maxBytes : 0
    try? fh.seek(toOffset: start)
    guard let d = try? fh.readToEnd() else { return nil }
    return String(data: d, encoding: .utf8)
}
func readFrom(_ path: String, _ offset: UInt64) -> String? {
    guard let fh = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? fh.close() }
    try? fh.seek(toOffset: offset)
    guard let d = try? fh.readToEnd() else { return nil }
    return String(data: d, encoding: .utf8)
}

// ============================================================================
// MARK: - Gesture-state machine (pure → testable)
// ============================================================================

enum GState: Equatable { case on, off, unknown }

// Latest ENABLED/DISABLED in the log wins.
func gestureState(from tail: String) -> GState {
    var st: GState = .unknown
    for line in tail.split(separator: "\n") {
        if line.contains("ENABLED") { st = .on }
        else if line.contains("DISABLED") { st = .off }
    }
    return st
}
// Returns the action to take on a transition, or nil if nothing changed.
func decide(prev: GState, cur: GState) -> GState? {
    if cur == .unknown || cur == prev { return nil }
    return cur
}

// ============================================================================
// MARK: - Actions
// ============================================================================

func runShortcut(_ name: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
    p.arguments = ["run", name]
    p.standardOutput = Pipe(); p.standardError = Pipe()
    do { try p.run() } catch { log("could not launch shortcuts: \(error)"); return false }
    p.waitUntilExit()
    if p.terminationStatus != 0 {
        log("⚠ shortcut \"\(name)\" not found or failed. Create it in Shortcuts.app (see README) — DND won't toggle until then.")
        return false
    }
    return true
}

func notify(_ title: String, _ body: String) {
    let c = UNMutableNotificationContent()
    c.title = title; c.body = body; c.sound = .default
    let req = UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)
    UNUserNotificationCenter.current().add(req) { err in
        if let err = err { log("notify failed: \(err)") }
    }
}

// ============================================================================
// MARK: - Agent
// ============================================================================

final class Guard: NSObject, UNUserNotificationCenterDelegate {
    var lastGesture: GState = .unknown
    var clapOffset: UInt64 = 0

    func start() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            log(granted ? "notifications authorized" : "⚠ notifications NOT authorized — enable FocusGuard under System Settings → Notifications")
        }
        // Seed state so we don't fire on startup.
        lastGesture = gestureState(from: tailString(GESTURE_LOG) ?? "")
        clapOffset = fileSize(CLAP_LOG)
        log("FocusGuard started. gesture=\(lastGesture) FOCUS_ON=\"\(FOCUS_ON)\" FOCUS_OFF=\"\(FOCUS_OFF)\"")

        Timer.scheduledTimer(withTimeInterval: POLL, repeats: true) { [weak self] _ in self?.poll() }
    }

    // Show banners even while our (background) app is frontmost.
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
        h([.banner, .sound])
    }

    func poll() {
        // ---- gesture arm/disarm → Focus ----
        let cur = gestureState(from: tailString(GESTURE_LOG) ?? "")
        if let action = decide(prev: lastGesture, cur: cur) {
            lastGesture = cur
            if action == .on {
                log("gesture ARMED → Focus ON")
                _ = runShortcut(FOCUS_ON)
                notify("🛡 Focus ON", "Gesture control armed — notifications silenced.")
            } else {
                log("gesture DISARMED → Focus OFF")
                _ = runShortcut(FOCUS_OFF)
                notify("Focus OFF", "Gesture control disarmed — you're back.")
            }
        }

        // ---- clap daemon summoned Claude ----
        let sz = fileSize(CLAP_LOG)
        if sz > clapOffset, let delta = readFrom(CLAP_LOG, clapOffset) {
            if delta.contains("opening Claude") { notify("👏 Claude summoned", "Opened by a clap.") }
        }
        if sz != clapOffset { clapOffset = sz }
    }
}

// ============================================================================
// MARK: - Self-test (FOCUSGUARD_SELFTEST=1)
// ============================================================================

if env["FOCUSGUARD_SELFTEST"] == "1" {
    var fails = 0
    func chk(_ n: String, _ c: Bool) { print(c ? "ok  \(n)" : "FAIL \(n)"); if !c { fails += 1 } }

    chk("parse ENABLED", gestureState(from: "x\n[..] ✦ ENABLED (two palms)\n") == .on)
    chk("parse DISABLED", gestureState(from: "✦ ENABLED\n✦ DISABLED\n") == .off)
    chk("latest wins", gestureState(from: "✦ DISABLED\n✦ ENABLED\n") == .on)
    chk("empty → unknown", gestureState(from: "") == .unknown)
    chk("off→on fires on", decide(prev: .off, cur: .on) == .on)
    chk("on→off fires off", decide(prev: .on, cur: .off) == .off)
    chk("on→on no-op", decide(prev: .on, cur: .on) == nil)
    chk("unknown cur no-op", decide(prev: .off, cur: .unknown) == nil)
    chk("seed from unknown→on fires", decide(prev: .unknown, cur: .on) == .on)
    print(fails == 0 ? "\nALL PASS" : "\n\(fails) FAILED")
    exit(fails == 0 ? 0 : 1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let guardian = Guard()
guardian.start()
app.run()
