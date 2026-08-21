import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { CoreIpcClient } from './core_ipc_client';

export type DaemonStatus = 'OFFLINE' | 'STARTING' | 'ONLINE' | 'ERROR';

export class ProcessManager {
  private workspaceRoot: string;
  private ipcClient: CoreIpcClient;
  private coreProcess: ChildProcess | null = null;
  private workerProcess: ChildProcess | null = null;
  private coreOwned: boolean = false;
  private workerOwned: boolean = false;
  private coreStatusState: DaemonStatus = 'OFFLINE';
  private workerStatusState: DaemonStatus = 'OFFLINE';

  private coreOutput: vscode.OutputChannel;
  private workerOutput: vscode.OutputChannel;

  constructor(workspaceRoot: string, ipcClient: CoreIpcClient) {
    this.workspaceRoot = workspaceRoot;
    this.ipcClient = ipcClient;
    this.coreOutput = vscode.window.createOutputChannel('SwarmX Core');
    this.workerOutput = vscode.window.createOutputChannel('SwarmX Worker');
  }

  public get coreStatus(): DaemonStatus {
    return this.coreStatusState;
  }

  public get workerStatus(): DaemonStatus {
    return this.workerStatusState;
  }

  public get isCoreOwned(): boolean {
    return this.coreOwned;
  }

  public get isWorkerOwned(): boolean {
    return this.workerOwned;
  }

  /**
   * Probes /tmp/swarmx.sock and queries getStatus to determine if Core is genuinely healthy.
   */
  public async checkCoreHealth(): Promise<boolean> {
    const socketPath = '/tmp/swarmx.sock';
    if (!fs.existsSync(socketPath)) {
      this.coreStatusState = 'OFFLINE';
      return false;
    }

    try {
      if (!this.ipcClient.connected) {
        await this.ipcClient.connect();
      }
      const status = await this.ipcClient.request<any>('getStatus');
      if (status && status.enabled !== undefined) {
        this.coreStatusState = 'ONLINE';
        return true;
      }
    } catch (e) {
      // Socket exists but refused connection (stale socket)
    }

    this.coreStatusState = 'OFFLINE';
    return false;
  }

  /**
   * Starts the SwarmX Core daemon. Reuses existing Core if already healthy.
   */
  public async startCore(): Promise<boolean> {
    const isHealthy = await this.checkCoreHealth();
    if (isHealthy) {
      this.coreOwned = false; // Reusing externally managed Core
      this.coreStatusState = 'ONLINE';
      this.coreOutput.appendLine('✓ Reusing existing healthy SwarmX Core daemon at /tmp/swarmx.sock');
      return true;
    }

    if (this.coreProcess) {
      this.coreOutput.appendLine('⚠️ Core process is already starting or running under extension management.');
      return true;
    }

    const coreDir = path.join(this.workspaceRoot, 'core');
    if (!fs.existsSync(coreDir)) {
      this.coreStatusState = 'ERROR';
      this.coreOutput.appendLine(`❌ Core directory not found at: ${coreDir}`);
      return false;
    }

    // Clean up stale socket file if present
    const socketPath = '/tmp/swarmx.sock';
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch (e) {}
    }

    this.coreStatusState = 'STARTING';
    this.coreOutput.appendLine(`🚀 Spawning SwarmX Core daemon from ${coreDir}...`);

    try {
      this.coreProcess = spawn('npm', ['start'], {
        cwd: coreDir,
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.coreOwned = true;

      this.coreProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        this.coreOutput.append(text);
      });

      this.coreProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        this.coreOutput.append(text);
      });

      this.coreProcess.on('exit', (code, signal) => {
        this.coreOutput.appendLine(`🛑 SwarmX Core process exited (code: ${code}, signal: ${signal})`);
        this.coreProcess = null;
        this.coreOwned = false;
        this.coreStatusState = 'OFFLINE';
      });

      this.coreProcess.on('error', (err) => {
        this.coreOutput.appendLine(`❌ SwarmX Core spawn error: ${err.message}`);
        this.coreProcess = null;
        this.coreOwned = false;
        this.coreStatusState = 'ERROR';
      });

      // Poll for readiness up to 10 seconds
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const ready = await this.checkCoreHealth();
        if (ready) {
          this.coreStatusState = 'ONLINE';
          this.coreOutput.appendLine('✨ SwarmX Core is now ONLINE and ready.');
          return true;
        }
      }

      this.coreStatusState = 'ERROR';
      this.coreOutput.appendLine('⚠️ Timed out waiting for SwarmX Core to become ready.');
      return false;
    } catch (err: any) {
      this.coreStatusState = 'ERROR';
      this.coreOutput.appendLine(`❌ Failed to start Core: ${err.message}`);
      return false;
    }
  }

  /**
   * Stops Core daemon if owned by the extension.
   */
  public async stopCore(): Promise<void> {
    if (!this.coreOwned || !this.coreProcess) {
      this.coreOutput.appendLine('ℹ️ Core daemon was started externally or is not managed by this extension.');
      return;
    }

    this.coreOutput.appendLine('🛑 Stopping extension-managed SwarmX Core daemon...');
    this.coreProcess.kill('SIGTERM');
    this.coreProcess = null;
    this.coreOwned = false;
    this.coreStatusState = 'OFFLINE';
  }

  public async restartCore(): Promise<void> {
    await this.stopCore();
    await new Promise((r) => setTimeout(r, 1000));
    await this.startCore();
  }

  /**
   * Starts native macOS local worker process if supported.
   */
  public async startWorker(): Promise<boolean> {
    if (this.workerProcess) {
      this.workerOutput.appendLine('⚠️ Local worker is already starting or running.');
      return true;
    }

    const workerDir = path.join(this.workspaceRoot, 'worker-macos');
    if (!fs.existsSync(workerDir)) {
      this.workerStatusState = 'ERROR';
      this.workerOutput.appendLine(`❌ Worker directory not found at: ${workerDir}`);
      return false;
    }

    this.workerStatusState = 'STARTING';
    this.workerOutput.appendLine(`🍏 Spawning native SwarmX Worker from ${workerDir}...`);

    try {
      this.workerProcess = spawn('swift', ['run', 'swarmx-worker'], {
        cwd: workerDir,
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.workerOwned = true;
      this.workerStatusState = 'ONLINE';

      this.workerProcess.stdout?.on('data', (data) => {
        this.workerOutput.append(data.toString());
      });

      this.workerProcess.stderr?.on('data', (data) => {
        this.workerOutput.append(data.toString());
      });

      this.workerProcess.on('exit', (code, signal) => {
        this.workerOutput.appendLine(`🛑 SwarmX Worker exited (code: ${code}, signal: ${signal})`);
        this.workerProcess = null;
        this.workerOwned = false;
        this.workerStatusState = 'OFFLINE';
      });

      this.workerProcess.on('error', (err) => {
        this.workerOutput.appendLine(`❌ Worker spawn error: ${err.message}`);
        this.workerProcess = null;
        this.workerOwned = false;
        this.workerStatusState = 'ERROR';
      });

      return true;
    } catch (err: any) {
      this.workerStatusState = 'ERROR';
      this.workerOutput.appendLine(`❌ Failed to start worker: ${err.message}`);
      return false;
    }
  }

  public async stopWorker(): Promise<void> {
    if (this.workerProcess && this.workerOwned) {
      this.workerOutput.appendLine('🛑 Stopping local SwarmX worker...');
      this.workerProcess.kill('SIGTERM');
      this.workerProcess = null;
      this.workerOwned = false;
      this.workerStatusState = 'OFFLINE';
    }
  }

  public async restartWorker(): Promise<void> {
    await this.stopWorker();
    await new Promise((r) => setTimeout(r, 1000));
    await this.startWorker();
  }

  /**
   * Cleanup on extension deactivation: only terminates child processes spawned by this extension.
   * Never terminates externally-managed daemons.
   */
  public dispose(): void {
    if (this.coreOwned && this.coreProcess) {
      this.coreProcess.kill('SIGTERM');
      this.coreProcess = null;
      this.coreOwned = false;
    }
    if (this.workerOwned && this.workerProcess) {
      this.workerProcess.kill('SIGTERM');
      this.workerProcess = null;
      this.workerOwned = false;
    }
  }
}
