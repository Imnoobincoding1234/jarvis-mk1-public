// openWakeWord's inference pipeline, in Swift, hosted on onnxruntime's C API.
//
// WHY THIS EXISTS. The pretrained "hey jarvis" model detects, and the Python host that normally runs
// it costs 205 MB resident — against the 112 MB SFSpeechRecognizer XPC service it was supposed to
// replace. Measured, the model itself is only ~38 MB of that; the rest is Python, numpy and scipy.
// Loading the same three ONNX graphs from Swift measured 34.2 MB, and it can live INSIDE
// ClapListener, which already owns a microphone tap — so the second process disappears too.
//
// THE BUFFERING IS NOT MINE AND MUST NOT BE IMPROVISED. Every constant below is read out of
// openwakeword/utils.py rather than guessed, because a wake word with subtly wrong framing does not
// error — it just never fires, or fires at noise, and both look like "the model is bad".
//
//   audio        int16 @ 16 kHz, processed in whole 1280-sample (80 ms) chunks
//   melspec      fed the last (chunk + 160*3) samples; output scaled x/10 + 2
//   mel buffer   seeded with ones(76, 32), capped at 10*97 frames
//   embedding    76 mel frames x 32 bins -> 96 floats, stepping back 8 frames per chunk
//   classifier   the last 16 embeddings -> one score
import Foundation

final class OrtRunner {
    private let api: OrtApi
    private var env: OpaquePointer?
    private var opts: OpaquePointer?
    private var memInfo: OpaquePointer?

    init() {
        api = OrtGetApiBase().pointee.GetApi(UInt32(ORT_API_VERSION))!.pointee
        _ = api.CreateEnv(ORT_LOGGING_LEVEL_ERROR, "jarvis-wake", &env)
        _ = api.CreateSessionOptions(&opts)
        // One thread per graph. This runs forever in the background listening for one phrase; a
        // thread pool would cost more than the work it parallelises.
        _ = api.SetIntraOpNumThreads(opts, 1)
        _ = api.CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memInfo)
    }

    func session(_ path: String) -> OpaquePointer? {
        var s: OpaquePointer?
        if let err = api.CreateSession(env, path, opts, &s) {
            let m = api.GetErrorMessage(err).map { String(cString: $0) } ?? "?"
            FileHandle.standardError.write("wake: cannot load \(path): \(m)\n".data(using: .utf8)!)
            api.ReleaseStatus(err)
            return nil
        }
        return s
    }

    // One input tensor in, one float tensor out — which is the shape of all three graphs here.
    func run(_ session: OpaquePointer?, inputName: String, outputName: String,
             data: [Float], shape: [Int64]) -> [Float]? {
        guard let session else { return nil }
        var input: OpaquePointer?
        var out: [Float]?
        var mutable = data
        mutable.withUnsafeMutableBufferPointer { buf in
            var dims = shape
            _ = api.CreateTensorWithDataAsOrtValue(
                memInfo, buf.baseAddress, buf.count * MemoryLayout<Float>.size,
                &dims, dims.count, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &input)

            inputName.withCString { inC in
                outputName.withCString { outC in
                    var inNames: [UnsafePointer<CChar>?] = [inC]
                    var outNames: [UnsafePointer<CChar>?] = [outC]
                    var inputs: [OpaquePointer?] = [input]
                    var outputs: [OpaquePointer?] = [nil]
                    let status = api.Run(session, nil, &inNames, &inputs, 1, &outNames, 1, &outputs)
                    if status == nil, let o = outputs[0] {
                        var count = 0
                        var info: OpaquePointer?
                        _ = api.GetTensorTypeAndShape(o, &info)
                        _ = api.GetTensorShapeElementCount(info, &count)
                        api.ReleaseTensorTypeAndShapeInfo(info)
                        var raw: UnsafeMutableRawPointer?
                        _ = api.GetTensorMutableData(o, &raw)
                        if let raw {
                            let p = raw.assumingMemoryBound(to: Float.self)
                            out = Array(UnsafeBufferPointer(start: p, count: count))
                        }
                        api.ReleaseValue(o)
                    } else if let status {
                        api.ReleaseStatus(status)
                    }
                }
            }
            api.ReleaseValue(input)
        }
        return out
    }
}

final class OnnxWakeDetector {
    private let ort = OrtRunner()
    private let melspec: OpaquePointer?
    private let embedding: OpaquePointer?
    private let classifier: OpaquePointer?

    // Straight from openwakeword/utils.py — see the header note on why none of these are invented.
    private let chunk = 1280                 // 80 ms at 16 kHz
    private let melPad = 160 * 3             // extra context handed to the melspec graph
    private let melWindow = 76               // mel frames per embedding
    private let melStep = 8                  // frames stepped back per chunk
    private let melMaxLen = 10 * 97
    private let featureWindow = 16           // embeddings the classifier expects
    private let featureMaxLen = 120

    private var raw: [Float] = []            // int16 values held as Float, as the graph expects
    private var accumulated = 0
    private var mel: [[Float]]               // [frames][32]
    private var features: [[Float]] = []     // [n][96]

    init?(modelDir: String) {
        melspec = ort.session(modelDir + "/melspectrogram.onnx")
        embedding = ort.session(modelDir + "/embedding_model.onnx")
        classifier = ort.session(modelDir + "/hey_jarvis_v0.1.onnx")
        guard melspec != nil, embedding != nil, classifier != nil else { return nil }
        // Seeded with ones, exactly as the reference does — a zero-seeded buffer changes the first
        // second of scores.
        mel = Array(repeating: Array(repeating: Float(1), count: 32), count: melWindow)
    }

    /// Feed 16 kHz mono samples. Returns a score when a new prediction was produced.
    @discardableResult
    func feed(_ samples: [Float]) -> Float? {
        raw.append(contentsOf: samples)
        if raw.count > 16000 * 10 { raw.removeFirst(raw.count - 16000 * 10) }
        accumulated += samples.count
        guard accumulated >= chunk, accumulated % chunk == 0 else { return nil }

        // ---- melspectrogram over the newest audio, with the reference's extra 480 samples of context
        let take = min(raw.count, accumulated + melPad)
        let audio = Array(raw.suffix(take))
        guard let melOut = ort.run(melspec, inputName: "input", outputName: "output",
                                   data: audio, shape: [1, Int64(audio.count)]) else { return nil }
        // Output is [1, 1, frames, 32]; the transform x/10 + 2 is the reference's melspec_transform.
        let frames = melOut.count / 32
        for f in 0..<frames {
            var row = [Float](repeating: 0, count: 32)
            for b in 0..<32 { row[b] = melOut[f * 32 + b] / 10 + 2 }
            mel.append(row)
        }
        if mel.count > melMaxLen { mel.removeFirst(mel.count - melMaxLen) }

        // ---- embeddings: one per 1280-sample chunk, walking back 8 mel frames at a time
        let chunks = accumulated / chunk
        for i in stride(from: chunks - 1, through: 0, by: -1) {
            let end = (i == 0) ? mel.count : mel.count - melStep * i
            let start = end - melWindow
            guard start >= 0, end <= mel.count else { continue }
            var flat = [Float](); flat.reserveCapacity(melWindow * 32)
            for r in start..<end { flat.append(contentsOf: mel[r]) }
            if let emb = ort.run(embedding, inputName: "input_1", outputName: "conv2d_19",
                                 data: flat, shape: [1, Int64(melWindow), 32, 1]) {
                features.append(emb)
            }
        }
        if features.count > featureMaxLen { features.removeFirst(features.count - featureMaxLen) }
        accumulated = 0

        // ---- classifier over the last 16 embeddings
        guard features.count >= featureWindow else { return nil }
        var flat = [Float](); flat.reserveCapacity(featureWindow * 96)
        for row in features.suffix(featureWindow) { flat.append(contentsOf: row) }
        guard let score = ort.run(classifier, inputName: "x.1", outputName: "53",
                                  data: flat, shape: [1, Int64(featureWindow), 96]) else { return nil }
        return score.first
    }

    func reset() {
        raw.removeAll(); features.removeAll(); accumulated = 0
        mel = Array(repeating: Array(repeating: Float(1), count: 32), count: melWindow)
    }
}
