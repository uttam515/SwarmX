import './mock_vscode';
import { expect } from 'chai';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { CoreIpcClient } from '../src/core_ipc_client';
import { ProcessManager } from '../src/process_manager';
import { DashboardViewProvider } from '../src/views/dashboard_view_provider';
import { WorkersTreeProvider, DiscoveredTreeProvider, TasksTreeProvider } from '../src/views/worker_tree_provider';

describe('VS Code Extension — Lifecycle & Dashboard Tests (Phase 4)', () => {
  const testSocketPath = '/tmp/swarmx.sock';
  let server: net.Server;
  let ipcClient: CoreIpcClient;

  before((done) => {
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }

    server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);

          if (msg.method === 'getStatus') {
            socket.write(JSON.stringify({
              id: msg.id,
              result: {
                enabled: true,
                totalTasks: 16,
                pendingTasks: 0,
                runningTasks: 0,
                completedTasks: 16,
                activeWorkerCount: 1,
                eligibleWorkerCount: 1,
                connectedWorkers: 1,
                discoveredWorkerCount: 0,
                trustedWorkerCount: 1,
                webSocketConnectionCount: 1
              }
            }) + '\n');
          } else if (msg.method === 'listWorkers' || msg.method === 'listConnectedWorkers') {
            socket.write(JSON.stringify({
              id: msg.id,
              result: [
                {
                  deviceId: 'macos-worker-01',
                  isEligible: true,
                  capabilityProfile: {
                    deviceName: "MacBook Pro M3",
                    osType: 'darwin',
                    cpuArch: 'arm64',
                    cpuCores: 12,
                    totalRamMb: 16384,
                    hasGpu: true,
                    gpuModel: 'Apple M3 GPU'
                  },
                  latestTelemetry: {
                    batteryLevel: 0.85,
                    thermalState: 0,
                    cpuUtilization: 0.10,
                    availableRamMb: 14000
                  }
                }
              ]
            }) + '\n');
          } else if (msg.method === 'listDiscoveredWorkers') {
            socket.write(JSON.stringify({
              id: msg.id,
              result: [
                {
                  deviceId: 'macos-worker-unpaired-01',
                  deviceName: 'Nearby MacBook',
                  host: '10.246.127.99',
                  port: 50051
                }
              ]
            }) + '\n');
          } else if (msg.method === 'listRecentWorkloads') {
            socket.write(JSON.stringify({
              id: msg.id,
              result: [
                {
                  workloadId: 'wkl-matmul-001',
                  kernelId: 'matrix_multiply_v1',
                  workerId: 'macos-worker-01',
                  localVsRemote: 'REMOTE',
                  status: 'COMPLETE',
                  durationSeconds: 0.045,
                  executionTimeMs: 45,
                  workerComputeTimeMs: 2.5,
                  transferTimeMs: 1.2,
                  queueTimeMs: 0.0,
                  validationTimeMs: 0.3,
                  estimatedGain: 2.8,
                  estimatedLocalTimeMs: 120,
                  estimatedSwarmTimeMs: 45,
                  decisionReason: 'Accelerate GEMM on M3 is 2.8x faster than Host CPU'
                }
              ]
            }) + '\n');
          } else if (msg.method === 'initiatePairing') {
            socket.write(JSON.stringify({
              id: msg.id,
              result: {
                initiationId: 'init-123',
                hostPublicKeyHex: 'abcdef0123456789'
              }
            }) + '\n');
          } else {
            socket.write(JSON.stringify({ id: msg.id, result: { success: true } }) + '\n');
          }
        }
      });
    });

    server.listen(testSocketPath, () => {
      done();
    });
  });

  after((done) => {
    if (ipcClient) {
      ipcClient.disconnect();
    }
    server.close(() => {
      if (fs.existsSync(testSocketPath)) {
        fs.unlinkSync(testSocketPath);
      }
      done();
    });
  });

  it('1. CoreIpcClient connects to Unix socket and processes JSON-RPC requests', async () => {
    ipcClient = new CoreIpcClient(testSocketPath);
    await ipcClient.connect();
    expect(ipcClient.connected).to.be.true;

    const status = await ipcClient.request<any>('getStatus');
    expect(status.totalTasks).to.equal(16);
    expect(status.completedTasks).to.equal(16);
    expect(status.activeWorkerCount).to.equal(1);
  });

  it('2. ProcessManager: Detects healthy existing Core and preserves external ownership', async () => {
    const procMgr = new ProcessManager('/tmp/test-ws', ipcClient);
    const isHealthy = await procMgr.checkCoreHealth();
    expect(isHealthy).to.be.true;
    expect(procMgr.coreStatus).to.equal('ONLINE');

    // Calling startCore on existing healthy daemon reuses it without spawning duplicate
    const started = await procMgr.startCore();
    expect(started).to.be.true;
    expect(procMgr.isCoreOwned).to.be.false; // External daemon ownership preserved

    // Attempting stopCore on externally-owned daemon does nothing destructive
    await procMgr.stopCore();
    expect(procMgr.isCoreOwned).to.be.false;

    // Dispose preserves external process
    procMgr.dispose();
    expect(fs.existsSync(testSocketPath)).to.be.true;
  });

  it('3. ProcessManager: Local worker lifecycle and ownership tracking', async () => {
    const procMgr = new ProcessManager('/tmp/test-ws', ipcClient);
    expect(procMgr.workerStatus).to.equal('OFFLINE');
    expect(procMgr.isWorkerOwned).to.be.false;

    await procMgr.stopWorker();
    expect(procMgr.isWorkerOwned).to.be.false;
  });

  it('4. DashboardViewProvider: Generates simplified 4-card UI with collapsible diagnostics', () => {
    const mockEnvManager: any = {
      active: true,
      forceSwarmDemo: false,
      simulationMode: false,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    };

    const mockProcessManager: any = {
      isCoreOwned: false,
      isWorkerOwned: false,
      workerStatus: 'OFFLINE'
    };

    const provider = new DashboardViewProvider({} as any, ipcClient, mockEnvManager, mockProcessManager);
    const html = (provider as any).getHtmlForWebview({
      connected: true,
      coreStatus: {
        totalTasks: 16,
        completedTasks: 16,
        runningTasks: 0,
        activeWorkerCount: 1,
        eligibleWorkerCount: 1
      },
      connectedWorkers: [
        {
          deviceId: 'macos-worker-01',
          isEligible: true,
          capabilityProfile: {
            deviceName: "MacBook Pro M3",
            osType: 'darwin',
            cpuArch: 'arm64',
            cpuCores: 12,
            totalRamMb: 16384,
            hasGpu: true,
            gpuModel: 'Apple M3 GPU'
          },
          latestTelemetry: {
            batteryLevel: 0.85,
            thermalState: 0
          }
        }
      ],
      discoveredWorkers: [],
      recentWorkloads: [
        {
          workloadId: 'wkl-matmul-001',
          kernelId: 'matrix_multiply_v1',
          workerId: 'macos-worker-01',
          localVsRemote: 'REMOTE',
          status: 'COMPLETE',
          durationSeconds: 0.045,
          executionTimeMs: 45,
          workerComputeTimeMs: 2.5,
          transferTimeMs: 1.2,
          queueTimeMs: 0.0,
          validationTimeMs: 0.3,
          estimatedGain: 2.8,
          estimatedLocalTimeMs: 120,
          estimatedSwarmTimeMs: 45,
          decisionReason: 'Accelerate GEMM on M3 is 2.8x faster than Host CPU'
        }
      ],
      recentLogs: ['[PAIRING] SAS verified', '[EXECUTION] Remote execution completed'],
      envActive: true,
      forceSwarmDemo: false,
      simulationMode: false,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3',
      isCoreOwned: false,
      isWorkerOwned: false,
      workerStatus: 'OFFLINE'
    });

    // Verification of the 4 Simplified Cards
    expect(html).to.include('1. CLUSTER');
    expect(html).to.include('● ONLINE (External Daemon)');
    expect(html).to.include('Host Node (Mac #1)');
    expect(html).to.include('MacBook Pro M3');

    expect(html).to.include('2. CURRENT EXECUTION');
    expect(html).to.include('NumPy MatMul (GEMM Float32)');
    expect(html).to.include('<b>1</b> / 1 complete (100%)');

    expect(html).to.include('3. PERFORMANCE');
    expect(html).to.include('2.80x SPEEDUP');
    expect(html).to.include('SWARM CLUSTER');

    expect(html).to.include('4. LAST WORKLOAD');
    expect(html).to.include('wkl-matmul-001');
    expect(html).to.include('PASS (Tolerance-Aware) ✓');

    // Verification of Collapsible Diagnostics
    expect(html).to.include('<details class="diag-details">');
    expect(html).to.include('▸ Live Chunk & Task Activity');
    expect(html).to.include('▸ Queue & Scheduling Breakdown');
    expect(html).to.include('▸ Worker Details & Telemetry');
    expect(html).to.include('▸ Validation & Integrity');
    expect(html).to.include('▸ Security & Cryptography');
    expect(html).to.include('▸ Observability & Diagnostic Logs');
    expect(html).to.include('▸ Architecture & Pipeline Flow');
  });

  it('5. DashboardViewProvider: Renders Development Simulation Mode clearly', () => {
    const mockEnvManager: any = {
      active: true,
      forceSwarmDemo: false,
      simulationMode: true,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    };

    const provider = new DashboardViewProvider({} as any, ipcClient, mockEnvManager);
    const html = (provider as any).getHtmlForWebview({
      connected: true,
      coreStatus: { totalTasks: 16, completedTasks: 8, runningTasks: 2 },
      connectedWorkers: [],
      discoveredWorkers: [],
      recentWorkloads: [
        {
          workloadId: 'wkl-boxblur-sim-01',
          kernelId: 'image_filter_box_blur_v1',
          workerId: 'sim-worker-virtual-m3',
          localVsRemote: 'REMOTE',
          status: 'RUNNING',
          inputBytes: 4194304
        }
      ],
      recentLogs: [],
      envActive: true,
      forceSwarmDemo: false,
      simulationMode: true,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3',
      isCoreOwned: true,
      isWorkerOwned: false,
      workerStatus: 'OFFLINE'
    });

    expect(html).to.include('● ONLINE (Extension Managed)');
    expect(html).to.include('🧪 SIMULATION (Virtual Worker)');
    expect(html).to.include('1 Virtual');
    expect(html).to.include('2D BoxBlur');
    expect(html).to.include('🧪 Virtual Worker — Simulation Mode');
  });

  it('8. DashboardViewProvider: Multi-Worker Chunked Execution & Dynamic Distribution', () => {
    const mockEnvManager: any = {
      active: true,
      forceSwarmDemo: true,
      simulationMode: false
    };

    const provider = new DashboardViewProvider({} as any, ipcClient, mockEnvManager);
    const html = (provider as any).getHtmlForWebview({
      connected: true,
      coreStatus: { totalTasks: 16, completedTasks: 12, runningTasks: 4 },
      connectedWorkers: [
        {
          deviceId: 'worker-studio-01',
          isEligible: true,
          capabilityProfile: { deviceName: 'Mac Studio M2 Ultra', cpuCores: 24, totalRamMb: 65536, hasGpu: true, gpuModel: 'Apple M2 Ultra GPU' }
        },
        {
          deviceId: 'worker-mbp-02',
          isEligible: true,
          capabilityProfile: { deviceName: 'MacBook Pro M3 Max', cpuCores: 16, totalRamMb: 36864, hasGpu: true, gpuModel: 'Apple M3 Max GPU' }
        }
      ],
      discoveredWorkers: [],
      recentWorkloads: [
        {
          workloadId: 'wkl-matmul-chunked-001',
          taskId: 'wkl-matmul-chunked-001',
          kernelId: 'matrix_multiply_v1',
          totalChunks: 16,
          completedChunks: 12,
          failedChunks: 0,
          parameters: { M: 2048, K: 2048, N: 2048, totalChunks: 16 },
          status: 'RUNNING',
          workerHostname: 'Mac Studio M2 Ultra',
          localVsRemote: 'REMOTE',
          estimatedGain: 3.4
        }
      ],
      recentLogs: []
    });

    // Validates dynamic N-worker rendering
    expect(html).to.include('2 Physical');
    expect(html).to.include('Mac Studio M2 Ultra');
    expect(html).to.include('MacBook Pro M3 Max');

    // Validates Parent Workload & Progress Bar
    expect(html).to.include('2048 × 2048 × 2048');
    expect(html).to.include('<b>12</b> / 16 complete (75%)');
    expect(html).to.include('style="width: 75%;"');

    // Validates live chunk activity
    expect(html).to.include('▸ Live Chunk & Task Activity');
  });

  it('6. Tree Providers: Workers, Discovered, Tasks render correctly', async () => {
    const workersProvider = new WorkersTreeProvider(ipcClient);
    const discoveredProvider = new DiscoveredTreeProvider(ipcClient);
    const tasksProvider = new TasksTreeProvider(ipcClient);

    const workerItems = await workersProvider.getChildren();
    expect(workerItems.length).to.be.greaterThan(0);
    expect(workerItems[0].label).to.include('Local Host');

    const discoveredItems = await discoveredProvider.getChildren();
    expect(discoveredItems.length).to.equal(1);
    expect(discoveredItems[0].label).to.include('Nearby MacBook');

    const taskItems = await tasksProvider.getChildren();
    expect(taskItems.length).to.equal(1);
    expect(taskItems[0].label).to.include('Tasks:');
  });

  it('7. EnvironmentManager: Synchronizes SWARMX_FORCE_SWARM and PYTHONPATH automatically', async () => {
    const mockContext: any = {
      extensionPath: '/test/ext',
      environmentVariableCollection: {
        description: '',
        replace: () => {},
        delete: () => {},
        clear: () => {}
      }
    };

    const { EnvironmentManager } = await import('../src/environment_manager');
    const envMgr = new EnvironmentManager(mockContext);

    await envMgr.setEnabled(true);
    expect(envMgr.active).to.be.true;

    await envMgr.setForceSwarmDemo(true);
    expect(envMgr.forceSwarmDemo).to.be.true;

    await envMgr.setSimulationMode(true);
    expect(envMgr.simulationMode).to.be.true;
  });
});
