import Foundation

public struct TaskExecutionRequest: Codable {
    public let taskId: String
    public let computationDescriptor: String
    public let inputRef: String
}

public struct TaskExecutionResult: Codable {
    public let taskId: String
    public let status: String // "COMPLETED" or "FAILED"
    public let outputRef: String
    public let executionDurationMs: Int64
}

public class ExecutionStub {
    public static let shared = ExecutionStub()

    private init() {}

    /**
     * Phase 0 Stub: Accepts task, sleeps for simulated duration, and returns canned result.
     * Full OS-level sandboxed execution (sandbox-exec / Job Objects) will be implemented in later phases.
     */
    public func executeTask(request: TaskExecutionRequest, completion: @escaping (TaskExecutionResult) -> Void) {
        print("[ExecutionStub] Received task: \(request.taskId). Simulating execution...")

        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
            let result = TaskExecutionResult(
                taskId: request.taskId,
                status: "COMPLETED",
                outputRef: "data://results/\(request.taskId)/output.bin",
                executionDurationMs: 500
            )
            print("[ExecutionStub] Completed task: \(request.taskId)")
            completion(result)
        }
    }
}
