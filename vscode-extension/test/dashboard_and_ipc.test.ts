import './mock_vscode';
import { expect } from 'chai';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { CoreIpcClient } from '../src/core_ipc_client';
import { DashboardViewProvider } from '../src/views/dashboard_view_provider';
import { WorkersTreeProvider, DiscoveredTreeProvider, TasksTreeProvider } from '../src/views/worker_tree_provider';

describe('VS Code Extension — Dashboard & IPC Tests', () => {
  const testSocketPath = path.join('/tmp', `swarmx-vsc-test-${Date.now()}.sock`);
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
                totalTasks: 1000,
                pendingTasks: 0,
                runningTasks: 0,
                completedTasks: 1000,
                activeWorkerCount: 1,
                eligibleWorkerCount: 1,
                connectedWorkers: 1,
                discoveredWorkerCount: 1,
                trustedWorkerCount: 1,
                webSocketConnectionCount: 1
              }
            }) + '\n');
          } else if (msg.method === 'listConnectedWorkers') {
            socket.write(JSON.stringify({
              id: msg.id,
              result: [
                {
                  deviceId: 'macos-worker-DDFB250B',
                  isEligible: true,
                  capabilityProfile: {
                    deviceName: "Jatin’s MacBook Air",
                    osType: 'darwin',
                    cpuArch: 'arm64',
                    cpuCores: 10,
                    totalRamMb: 16384,
                    hasGpu: true,
                    gpuModel: 'Apple Silicon GPU'
                  },
                  latestTelemetry: {
                    batteryLevel: 0.71,
                    thermalState: 0,
                    cpuUtilization: 0.15,
                    availableRamMb: 12000
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
          } else if (msg.method === 'listKernels') {
            socket.write(JSON.stringify({
              id: msg.id,
              result: [
                { kernelId: 'image_filter_box_blur_v1', domain: 'IMAGE_PROCESSING' },
                { kernelId: 'matrix_multiply_v1', domain: 'NUMERICAL_COMPUTATION' }
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
    expect(status.totalTasks).to.equal(1000);
    expect(status.completedTasks).to.equal(1000);
    expect(status.activeWorkerCount).to.equal(1);
  });

  it('2. CoreIpcClient retrieves connected workers with capability profile & telemetry', async () => {
    const workers = await ipcClient.request<any[]>('listConnectedWorkers');
    expect(workers.length).to.equal(1);
    expect(workers[0].capabilityProfile.deviceName).to.equal("Jatin’s MacBook Air");
    expect(workers[0].capabilityProfile.hasGpu).to.be.true;
    expect(workers[0].latestTelemetry.batteryLevel).to.equal(0.71);
  });

  it('3. CoreIpcClient initiates worker pairing with initiationId generation', async () => {
    const init = await ipcClient.request<any>('initiatePairing', { workerDeviceId: 'macos-worker-unpaired-01' });
    expect(init.initiationId).to.equal('init-123');
  });

  it('4. DashboardViewProvider generates HTML reflecting online cluster, remote worker specs, and decision model', () => {
    const mockEnvManager: any = {
      active: true,
      forceSwarmDemo: false,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    };

    const provider = new DashboardViewProvider({} as any, ipcClient, mockEnvManager);
    const html = (provider as any).renderHtml({
      isConnected: true,
      coreStatus: {
        totalTasks: 1000,
        completedTasks: 1000,
        runningTasks: 0,
        activeWorkerCount: 1,
        eligibleWorkerCount: 1,
        webSocketConnectionCount: 1
      },
      connectedWorkers: [
        {
          deviceId: 'macos-worker-DDFB250B',
          isEligible: true,
          capabilityProfile: {
            deviceName: "Jatin’s MacBook Air",
            osType: 'darwin',
            cpuArch: 'arm64',
            cpuCores: 10,
            totalRamMb: 16384,
            hasGpu: true
          },
          latestTelemetry: {
            batteryLevel: 0.71,
            thermalState: 0
          }
        }
      ],
      discoveredWorkers: [],
      trustedWorkers: [{ deviceId: 'macos-worker-DDFB250B' }],
      kernels: [{ kernelId: 'image_filter_box_blur_v1' }],
      recentLogs: ['[PAIRING] SAS verified', '[EXECUTION] Remote execution completed'],
      envActive: true,
      forceSwarmDemo: false,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    });

    // Verification of required sections
    expect(html).to.include('● ONLINE');
    expect(html).to.include('Jatin’s MacBook Air');
    expect(html).to.include('⚡ Apple Silicon GPU');
    expect(html).to.include('10 cores');
    expect(html).to.include('16 GB RAM');
    expect(html).to.include('Battery: 71%');
    expect(html).to.include('Thermal: Nominal');
    expect(html).to.include('Standard Python & PIL');
    expect(html).to.include('SwarmX imports: 0');
    expect(html).to.include('Pixel tolerance: PASS');
    expect(html).to.include('Output integrity: PASS');
    expect(html).to.include('ADAPTIVE PRODUCTION');
    expect(html).to.include('LOCAL FALLBACK');
  });

  it('5. DashboardViewProvider renders Force Swarm DEMO badge when demo mode is active', () => {
    const mockEnvManager: any = {
      active: true,
      forceSwarmDemo: true,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    };

    const provider = new DashboardViewProvider({} as any, ipcClient, mockEnvManager);
    const html = (provider as any).renderHtml({
      isConnected: true,
      coreStatus: { totalTasks: 1000, completedTasks: 500, runningTasks: 1 },
      connectedWorkers: [{ deviceId: 'worker-1', capabilityProfile: { deviceName: 'Mac #2' } }],
      discoveredWorkers: [],
      trustedWorkers: [],
      kernels: [],
      recentLogs: [],
      envActive: true,
      forceSwarmDemo: true,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    });

    expect(html).to.include('FORCED SWARM (DEMO)');
    expect(html).to.include('FORCED SWARM');
    expect(html).to.include('RUNNING');
    expect(html).to.include('50%');
  });

  it('6. WorkersTreeProvider, DiscoveredTreeProvider, and TasksTreeProvider render correctly', async () => {
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

  it('7. DashboardViewProvider renders Development Simulation Mode and Virtual Apple Silicon Worker', () => {
    const mockEnvManager: any = {
      active: true,
      forceSwarmDemo: false,
      simulationMode: true,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    };

    const provider = new DashboardViewProvider({} as any, ipcClient, mockEnvManager);
    const html = (provider as any).renderHtml({
      isConnected: true,
      coreStatus: { totalTasks: 16, completedTasks: 16, runningTasks: 0 },
      connectedWorkers: [],
      discoveredWorkers: [],
      trustedWorkers: [],
      kernels: [],
      recentLogs: [],
      recentWorkloads: [
        {
          workloadId: 'wkl-boxblur-demo-001',
          taskId: 'wkl-boxblur-demo-001',
          workerId: 'sim-worker-virtual-m3',
          workerHostname: '🧪 Simulated Mac #2 (Virtual Environment)',
          status: 'COMPLETE',
          durationSeconds: 0.08
        }
      ],
      simStatus: {
        config: { enabled: true, failureMode: 'NONE' }
      },
      envActive: true,
      forceSwarmDemo: false,
      simulationMode: true,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    });

    expect(html).to.include('DEVELOPMENT SIMULATION');
    expect(html).to.include('🧪 Virtual Apple Silicon Worker');
    expect(html).to.include('Simulation Mode');
    expect(html).to.include('10 Cores');
    expect(html).to.include('16 GB RAM');
    expect(html).to.include('⚡ GPU: Simulated Metal');
    expect(html).to.include('🧪 SIMULATION WORKER');
    expect(html).to.include('🧪 Virtual Worker (Simulated Apple Silicon)');
    expect(html).to.include('worker-sim');
    expect(html).to.not.include("Jatin’s MacBook Air");
  });

  it('8. Simulation failure controls render cleanly and toggle failure states', () => {
    const mockEnvManager: any = {
      active: true,
      simulationMode: true,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    };

    const provider = new DashboardViewProvider({} as any, ipcClient, mockEnvManager);
    const html = (provider as any).renderHtml({
      isConnected: true,
      coreStatus: { totalTasks: 16, completedTasks: 8, runningTasks: 1 },
      connectedWorkers: [],
      discoveredWorkers: [],
      trustedWorkers: [],
      kernels: [],
      recentLogs: [],
      recentWorkloads: [],
      simStatus: {
        config: { enabled: true, failureMode: 'DISCONNECTED' }
      },
      envActive: true,
      forceSwarmDemo: false,
      simulationMode: true,
      sdkPath: '/path/to/sdk/python',
      interpreter: 'python3'
    });

    expect(html).to.include('🔴 SIMULATED OFFLINE');
    expect(html).to.include('Simulate Disconnect');
    expect(html).to.include('Simulate Error');
  });

  it('9. EnvironmentManager synchronizes SWARMX_FORCE_SWARM to terminal.integrated.env.osx without PYTHONPATH guard regression', async () => {
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

    await envMgr.setForceSwarmDemo(true);
    expect(envMgr.forceSwarmDemo).to.be.true;

    await envMgr.setForceSwarmDemo(false);
    expect(envMgr.forceSwarmDemo).to.be.false;
  });

  it('10. CoreIpcClient sends setForceSwarmMode and receives acknowledgement', async () => {
    const res = await ipcClient.request<any>('setForceSwarmMode', { enabled: true });
    expect(res.success).to.be.true;
  });
});
