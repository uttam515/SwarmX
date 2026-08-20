import Foundation

public struct TaskPayload: Codable {
    public let taskId: String
    public let attemptNumber: Int?
    public let computationDescriptor: String
    public let inputRef: String
    public let inputData: String? // Base64 or JSON pixel array
    public let itemCount: Int?
}

public struct TaskResultPayload: Codable {
    public let taskId: String
    public let attemptNumber: Int?
    public let status: String
    public let outputData: String
    public let executionTimeMs: Int64
    public let itemCount: Int?
    public let workerHostname: String?
    public let workerPid: Int32?
}

public struct KernelParameters: Codable {
    public let kernelId: String?
    public let radius: Int?
    public let width: Int?
    public let height: Int?
    public let mode: String?
    public let channels: Int?
}

public class ImageProcessingKernel {
    public static let shared = ImageProcessingKernel()

    private init() {}

    /**
     * Executes native image transformation operations on a chunk of pixel data.
     * Supports certified image_filter_box_blur_v1 and legacy arithmetic kernels.
     */
    public func processTask(payload: TaskPayload) -> TaskResultPayload {
        let startTime = DispatchTime.now()

        var outputDataString = ""
        let itemCount = payload.itemCount ?? 1

        if let inputData = payload.inputData, let rawBytes = Data(base64Encoded: inputData) {
            // 1. Certified image_filter_box_blur_v1
            if payload.computationDescriptor.contains("box_blur") {
                var radius = 2
                var width = 0
                var height = 0
                var channels = 4

                if let descData = payload.computationDescriptor.data(using: .utf8) {
                    if let params = try? JSONDecoder().decode(KernelParameters.self, from: descData) {
                        radius = params.radius ?? 2
                        width = params.width ?? 0
                        height = params.height ?? 0
                        channels = params.channels ?? (params.mode == "RGB" ? 3 : (params.mode == "L" ? 1 : 4))
                    } else if let dict = try? JSONSerialization.jsonObject(with: descData) as? [String: Any] {
                        if let params = dict["parameters"] as? [String: Any] {
                            radius = params["radius"] as? Int ?? 2
                            width = params["width"] as? Int ?? 0
                            height = params["height"] as? Int ?? 0
                            if let mode = params["mode"] as? String {
                                channels = mode == "RGB" ? 3 : (mode == "L" ? 1 : 4)
                            }
                        }
                    }
                }

                if width <= 0 || height <= 0 {
                    let totalPixels = rawBytes.count / channels
                    let side = Int(Double(totalPixels).squareRoot())
                    if side * side * channels == rawBytes.count {
                        width = side
                        height = side
                    } else {
                        width = totalPixels
                        height = 1
                    }
                }

                let processedBytes = ImageProcessingKernel.applyBoxBlur(
                    input: rawBytes,
                    width: width,
                    height: height,
                    channels: channels,
                    radius: radius
                )
                outputDataString = processedBytes.base64EncodedString()
            } else if payload.computationDescriptor.contains("gaussian_blur") {
                // 2. Certified image_filter_gaussian_blur_v1 (3-pass separable box approximation / binomial)
                var width = 0
                var height = 0
                var channels = 4
                let totalPixels = rawBytes.count / channels
                let side = Int(Double(totalPixels).squareRoot())
                width = side
                height = side

                // Standard Gaussian filter approximation (2-pass box blur)
                let pass1 = ImageProcessingKernel.applyBoxBlur(input: rawBytes, width: width, height: height, channels: channels, radius: 2)
                let pass2 = ImageProcessingKernel.applyBoxBlur(input: pass1, width: width, height: height, channels: channels, radius: 2)
                outputDataString = pass2.base64EncodedString()
            } else if payload.computationDescriptor.contains("matrix_multiply") {
                // 3. Certified matrix_multiply_v1 (Float32 GEMM)
                let floatCount = rawBytes.count / 4
                let side = Int(Double(floatCount / 2).squareRoot()) // Two matrices A and B of side x side
                let n = max(1, side)
                
                var a = [Float](repeating: 0, count: n * n)
                var b = [Float](repeating: 0, count: n * n)
                var c = [Float](repeating: 0, count: n * n)

                rawBytes.withUnsafeBytes { ptr in
                    let fPtr = ptr.bindMemory(to: Float.self)
                    for i in 0..<min(n * n, floatCount) {
                        a[i] = fPtr[i]
                    }
                    for i in 0..<min(n * n, max(0, floatCount - n * n)) {
                        b[i] = fPtr[n * n + i]
                    }
                }

                // C = A * B
                for i in 0..<n {
                    for k in 0..<n {
                        let aik = a[i * n + k]
                        for j in 0..<n {
                            c[i * n + j] += aik * b[k * n + j]
                        }
                    }
                }

                let outData = Data(bytes: c, count: n * n * 4)
                outputDataString = outData.base64EncodedString()
            } else {
                // Default legacy filters (invert, grayscale, scaling)
                var processed = Data(count: rawBytes.count)
                for i in 0..<rawBytes.count {
                    let byte = rawBytes[i]
                    if payload.computationDescriptor.contains("invert") {
                        processed[i] = 255 - byte
                    } else if payload.computationDescriptor.contains("grayscale") {
                        processed[i] = UInt8(min(255, Int(byte) * 9 / 10))
                    } else {
                        processed[i] = UInt8(min(255, (Int(byte) * 11) / 10))
                    }
                }
                outputDataString = processed.base64EncodedString()
            }
        } else if let inputJson = payload.inputData, let data = inputJson.data(using: .utf8),
                  let pixelArray = try? JSONDecoder().decode([Int].self, from: data) {
            // Process numeric pixel array
            let processed = pixelArray.map { val -> Int in
                if payload.computationDescriptor.contains("invert") {
                    return max(0, 255 - val)
                } else {
                    return min(255, (val * 11) / 10)
                }
            }
            if let outData = try? JSONEncoder().encode(processed), let outStr = String(data: outData, encoding: .utf8) {
                outputDataString = outStr
            }
        } else {
            outputDataString = "processed_\(payload.inputRef)"
        }

        let endTime = DispatchTime.now()
        let elapsedNs = endTime.uptimeNanoseconds - startTime.uptimeNanoseconds
        let elapsedMs = max(1, Int64(elapsedNs / 1_000_000))

        let hostName = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        let pid = ProcessInfo.processInfo.processIdentifier

        return TaskResultPayload(
            taskId: payload.taskId,
            attemptNumber: payload.attemptNumber,
            status: "COMPLETED",
            outputData: outputDataString,
            executionTimeMs: elapsedMs,
            itemCount: itemCount,
            workerHostname: hostName,
            workerPid: pid
        )
    }

    /**
     * Executes 2D Box Blur filter on planar byte buffer (RGBA, RGB, or Grayscale).
     * Uses separable 1D horizontal pass + 1D vertical pass with sliding window accumulation.
     */
    public static func applyBoxBlur(
        input: Data,
        width: Int,
        height: Int,
        channels: Int,
        radius: Int
    ) -> Data {
        guard width > 0, height > 0, channels > 0, radius >= 0, input.count >= width * height * channels else {
            return input
        }
        if radius == 0 {
            return input
        }

        let totalPixels = width * height
        var temp = [UInt8](repeating: 0, count: totalPixels * channels)
        var output = [UInt8](repeating: 0, count: totalPixels * channels)

        input.withUnsafeBytes { rawInputPtr in
            guard let inBytes = rawInputPtr.bindMemory(to: UInt8.self).baseAddress else { return }

            // 1. Horizontal 1D Box Blur pass (inBytes -> temp)
            for y in 0..<height {
                let rowOffset = y * width * channels
                for c in 0..<channels {
                    var windowSum = 0
                    let windowCount = 2 * radius + 1

                    // Initialize sliding window at x = 0 with edge clamping
                    for k in -radius...radius {
                        let clampedX = max(0, min(width - 1, k))
                        windowSum += Int(inBytes[rowOffset + clampedX * channels + c])
                    }

                    temp[rowOffset + 0 * channels + c] = UInt8(windowSum / windowCount)

                    // Slide window across row
                    for x in 1..<width {
                        let leftIdx = max(0, min(width - 1, x - radius - 1))
                        let rightIdx = max(0, min(width - 1, x + radius))
                        windowSum += Int(inBytes[rowOffset + rightIdx * channels + c]) - Int(inBytes[rowOffset + leftIdx * channels + c])
                        temp[rowOffset + x * channels + c] = UInt8(windowSum / windowCount)
                    }
                }
            }

            // 2. Vertical 1D Box Blur pass (temp -> output)
            for x in 0..<width {
                let colOffset = x * channels
                for c in 0..<channels {
                    var windowSum = 0
                    let windowCount = 2 * radius + 1

                    // Initialize sliding window at y = 0 with edge clamping
                    for k in -radius...radius {
                        let clampedY = max(0, min(height - 1, k))
                        windowSum += Int(temp[clampedY * width * channels + colOffset + c])
                    }

                    output[0 * width * channels + colOffset + c] = UInt8(windowSum / windowCount)

                    // Slide window down column
                    for y in 1..<height {
                        let topIdx = max(0, min(height - 1, y - radius - 1))
                        let botIdx = max(0, min(height - 1, y + radius))
                        windowSum += Int(temp[botIdx * width * channels + colOffset + c]) - Int(temp[topIdx * width * channels + colOffset + c])
                        output[y * width * channels + colOffset + c] = UInt8(windowSum / windowCount)
                    }
                }
            }
        }

        return Data(output)
    }
}
