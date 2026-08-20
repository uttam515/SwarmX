// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SwarmXWorker",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "swarmx-worker",
            targets: ["SwarmXWorker"]
        )
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "SwarmXWorker",
            dependencies: [],
            path: "Sources/SwarmXWorker"
        ),
        .testTarget(
            name: "SwarmXWorkerTests",
            dependencies: ["SwarmXWorker"],
            path: "Tests/SwarmXWorkerTests"
        )
    ]
)
