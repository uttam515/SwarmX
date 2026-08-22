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

  private extensionPath?: string;

  constructor(workspaceRoot: string, ipcClient: CoreIpcClient, extensionPath?: string) {
    this.workspaceRoot = workspaceRoot;
    this.ipcClient = ipcClient;
    this.extensionPath = extensionPath;
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
   * Constructs an augmented environment containing standard development tool paths (NVM, Homebrew, etc.)
   * so that child processes spawned in VS Code Extension Host have access to node, npm, and swift.
   */
  public getAugmentedEnv(): NodeJS.ProcessEnv {
    const home = process.env.HOME || '';
    const extraPaths: string[] = [];

    // 1. Discover active/installed NVM Node version bins (e.g. ~/.nvm/versions/node/v20.x.x/bin)
    if (home) {
      const nvmNodeDir = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmNodeDir)) {
        try {
          const versions = fs.readdirSync(nvmNodeDir).filter((v) => v.startsWith('v')).sort((a, b) => {
            return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
          });
          for (const v of versions) {
            const vBin = path.join(nvmNodeDir, v, 'bin');
            if (fs.existsSync(vBin)) {
              extraPaths.push(vBin);
            }
          }
        } catch (e) {}
      }

      // 2. FNM, Volta, Cargo, user local bin
      const fnmCurrent = path.join(home, '.local', 'share', 'fnm', 'current', 'bin');
      if (fs.existsSync(fnmCurrent)) extraPaths.push(fnmCurrent);

      const voltaBin = path.join(home, '.volta', 'bin');
      if (fs.existsSync(voltaBin)) extraPaths.push(voltaBin);

      const userLocalBin = path.join(home, '.local', 'bin');
      if (fs.existsSync(userLocalBin)) extraPaths.push(userLocalBin);

      const cargoBin = path.join(home, '.cargo', 'bin');
      if (fs.existsSync(cargoBin)) extraPaths.push(cargoBin);
    }

    // 3. Homebrew & Standard Mac / Linux CLI paths
    const standardCliPaths = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    ];
    for (const p of standardCliPaths) {
      if (fs.existsSync(p)) {
        extraPaths.push(p);
      }
    }

    const currentPath = process.env.PATH || '';
    const combinedPath = Array.from(new Set([...extraPaths, ...currentPath.split(':')])).filter(Boolean).join(':');

    return {
      ...process.env,
      PATH: combinedPath
    };
  }

  /**
   * Resolves the full path to an executable from the augmented PATH.
   */
  public resolveExecutable(name: string, env?: NodeJS.ProcessEnv): string {
    const activeEnv = env || this.getAugmentedEnv();
    const pathDirs = (activeEnv.PATH || '').split(':').filter(Boolean);

    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) {
          const stats = fs.statSync(candidate);
          if (stats.isFile()) {
            return candidate;
          }
        }
      } catch (e) {}
    }

    return name; // Fallback to raw command name
  }

  /**
   * Checks whether candidateDir is a valid SwarmX core directory by verifying
   * that its package.json contains "name": "@swarmx/core".
   */
  public isSwarmXCoreDir(candidateDir: string): boolean {
    if (!candidateDir) return false;
    try {
      const pkgPath = path.join(candidateDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const content = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (content && content.name === '@swarmx/core') {
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  /**
   * Checks whether candidateDir contains a valid SwarmX project root.
   */
  public isValidProjectRoot(candidateDir: string): boolean {
    if (!candidateDir) return false;
    try {
      if (!fs.existsSync(candidateDir)) return false;
      const coreDir = path.join(candidateDir, 'core');
      if (this.isSwarmXCoreDir(coreDir)) {
        return true;
      }
      if (this.isSwarmXCoreDir(candidateDir)) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  /**
   * Scans downward recursively (up to maxDepth) searching for a directory with package.json (@swarmx/core).
   */
  private scanDownwardForCore(
    dir: string,
    currentDepth: number,
    maxDepth: number,
    checkedPaths: string[]
  ): string | null {
    if (currentDepth > maxDepth || !fs.existsSync(dir)) return null;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      // 1. Prioritize check for a child directory named "core"
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name === 'core') {
          const corePath = path.join(dir, 'core');
          const pkgPath = path.join(corePath, 'package.json');
          if (!checkedPaths.includes(pkgPath)) {
            checkedPaths.push(pkgPath);
            if (this.isSwarmXCoreDir(corePath)) {
              return corePath;
            }
          }
        }
      }

      // 2. Check if current directory itself is core
      const directPkg = path.join(dir, 'package.json');
      if (!checkedPaths.includes(directPkg)) {
        checkedPaths.push(directPkg);
        if (this.isSwarmXCoreDir(dir)) {
          return dir;
        }
      }

      // 3. Recurse into candidate subdirectories
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== 'dist' &&
          entry.name !== '.git'
        ) {
          const subDir = path.join(dir, entry.name);
          const found = this.scanDownwardForCore(subDir, currentDepth + 1, maxDepth, checkedPaths);
          if (found) return found;
        }
      }
    } catch (e) {}

    return null;
  }

  /**
   * Discovers the actual SwarmX project root containing core/package.json (@swarmx/core).
   */
  public findProjectRoot(startDirs?: string[]): string | null {
    const checkedPaths: string[] = [];
    const candidates: string[] = [];

    if (startDirs && startDirs.length > 0) {
      candidates.push(...startDirs);
    } else {
      if (this.workspaceRoot) candidates.push(this.workspaceRoot);
      if (this.extensionPath) candidates.push(this.extensionPath);
    }

    const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean).map((p) => path.resolve(p))));

    this.coreOutput.appendLine('----------------------------------------------------');
    this.coreOutput.appendLine('🔎 [ROOT DISCOVERY] Starting SwarmX Project Root Discovery');
    this.coreOutput.appendLine(`🔎 [ROOT DISCOVERY] Candidate Seed Directories (${uniqueCandidates.length}):`);
    for (const seed of uniqueCandidates) {
      this.coreOutput.appendLine(`   • ${seed}`);
    }
    this.coreOutput.appendLine('🔎 [ROOT DISCOVERY] Checking paths:');

    // Step A: Direct & Upward Search from each candidate
    for (const seed of uniqueCandidates) {
      let curr = seed;
      for (let depth = 0; depth < 5; depth++) {
        const coreSub = path.join(curr, 'core');
        const pkg1 = path.join(coreSub, 'package.json');
        if (!checkedPaths.includes(pkg1)) {
          checkedPaths.push(pkg1);
          this.coreOutput.appendLine(`   🔍 Checking: ${pkg1}`);
          if (this.isSwarmXCoreDir(coreSub)) {
            this.coreOutput.appendLine(`✅ [ROOT DISCOVERY] Found SwarmX Core: ${coreSub}`);
            this.coreOutput.appendLine(`✅ [ROOT DISCOVERY] Project Root:     ${curr}`);
            this.coreOutput.appendLine('----------------------------------------------------');
            return curr;
          }
        }

        const pkg2 = path.join(curr, 'package.json');
        if (!checkedPaths.includes(pkg2)) {
          checkedPaths.push(pkg2);
          this.coreOutput.appendLine(`   🔍 Checking: ${pkg2}`);
          if (this.isSwarmXCoreDir(curr)) {
            const projectParent = path.dirname(curr);
            this.coreOutput.appendLine(`✅ [ROOT DISCOVERY] Found SwarmX Core directly at: ${curr}`);
            this.coreOutput.appendLine(`✅ [ROOT DISCOVERY] Project Root:     ${projectParent}`);
            this.coreOutput.appendLine('----------------------------------------------------');
            return projectParent;
          }
        }

        const parent = path.dirname(curr);
        if (!parent || parent === curr) break;
        curr = parent;
      }
    }

    // Step B: Downward Search into subdirectories (up to 3 levels deep)
    for (const seed of uniqueCandidates) {
      const found = this.scanDownwardForCore(seed, 0, 3, checkedPaths);
      if (found) {
        const projectRoot = path.basename(found) === 'core' ? path.dirname(found) : found;
        this.coreOutput.appendLine(`✅ [ROOT DISCOVERY] Found SwarmX Core via scan: ${found}`);
        this.coreOutput.appendLine(`✅ [ROOT DISCOVERY] Project Root:     ${projectRoot}`);
        this.coreOutput.appendLine('----------------------------------------------------');
        return projectRoot;
      }
    }

    this.coreOutput.appendLine('❌ [ROOT DISCOVERY] SwarmX project root could not be located.');
    this.coreOutput.appendLine('----------------------------------------------------');
    return null;
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

    const projectRoot = this.findProjectRoot();
    if (!projectRoot) {
      this.coreStatusState = 'ERROR';
      const errMsg = 'SwarmX project root could not be located.\nExpected core/, worker-macos/, sdk/, and vscode-extension/.';
      this.coreOutput.appendLine(`❌ ${errMsg}`);
      vscode.window.showErrorMessage(errMsg);
      return false;
    }

    const coreDir = path.join(projectRoot, 'core');

    // Clean up stale socket file if present
    const socketPath = '/tmp/swarmx.sock';
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch (e) {}
    }

    this.coreOutput.show(true);
    this.coreStatusState = 'STARTING';

    const env = this.getAugmentedEnv();
    env['SWARMX_DEMO_IGNORE_BATTERY'] = 'true';
    const npmExe = this.resolveExecutable('npm', env);
    const nodeExe = this.resolveExecutable('node', env);

    this.coreOutput.appendLine('----------------------------------------------------');
    this.coreOutput.appendLine('🚀 [SwarmX ProcessManager] Starting Core Daemon');
    this.coreOutput.appendLine(`📁 SwarmX Project Root:      ${projectRoot}`);
    this.coreOutput.appendLine(`📂 Core Directory:           ${coreDir}`);
    this.coreOutput.appendLine(`📦 [3] Resolved npm Path:     ${npmExe}`);
    this.coreOutput.appendLine(`🟢 [4] Resolved node Path:    ${nodeExe}`);
    this.coreOutput.appendLine(`🔍 [5] Augmented PATH Prefix: ${(env.PATH || '').split(':').slice(0, 6).join(':')}...`);
    this.coreOutput.appendLine(`⚙️ [6] Spawn Command:         ${npmExe} start (cwd: ${coreDir})`);
    this.coreOutput.appendLine('----------------------------------------------------');

    try {
      this.coreProcess = spawn(npmExe, ['start'], {
        cwd: coreDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.coreOwned = true;

      this.coreProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        this.coreOutput.append(text);
      });

      this.coreProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        this.coreOutput.append(`[STDERR] ${text}`);
      });

      this.coreProcess.on('exit', (code, signal) => {
        this.coreOutput.appendLine(`🛑 [EXIT] SwarmX Core process exited (code: ${code}, signal: ${signal})`);
        this.coreProcess = null;
        this.coreOwned = false;
        this.coreStatusState = 'OFFLINE';
      });

      this.coreProcess.on('close', (code, signal) => {
        this.coreOutput.appendLine(`🔒 [CLOSE] SwarmX Core stdio closed (code: ${code}, signal: ${signal})`);
      });

      this.coreProcess.on('error', (err: any) => {
        this.coreOutput.appendLine(`❌ [ERROR] SwarmX Core spawn error: ${err.message} (code: ${err.code || 'UNKNOWN'})`);
        if (err.stack) {
          this.coreOutput.appendLine(`   Stack: ${err.stack}`);
        }
        this.coreProcess = null;
        this.coreOwned = false;
        this.coreStatusState = 'ERROR';
      });

      // Poll for readiness up to 10 seconds (20 iterations * 500ms)
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const ready = await this.checkCoreHealth();
        if (ready) {
          this.coreStatusState = 'ONLINE';
          this.coreOutput.appendLine(`✨ [PROBE] Core health check PASSED on attempt ${i + 1}. Core is ONLINE.`);
          return true;
        }
        if (i % 4 === 0) {
          this.coreOutput.appendLine(`⏳ [PROBE] Waiting for /tmp/swarmx.sock... (attempt ${i + 1}/20)`);
        }
      }

      this.coreStatusState = 'ERROR';
      this.coreOutput.appendLine('⚠️ [PROBE] Timed out waiting for SwarmX Core socket /tmp/swarmx.sock to become ready.');
      return false;
    } catch (err: any) {
      this.coreStatusState = 'ERROR';
      this.coreOutput.appendLine(`❌ [FATAL] Exception in startCore: ${err.message}`);
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

    const projectRoot = this.findProjectRoot();
    if (!projectRoot) {
      this.workerStatusState = 'ERROR';
      const errMsg = 'SwarmX project root could not be located.\nExpected core/, worker-macos/, sdk/, and vscode-extension/.';
      this.workerOutput.appendLine(`❌ ${errMsg}`);
      vscode.window.showErrorMessage(errMsg);
      return false;
    }

    const workerDir = path.join(projectRoot, 'worker-macos');

    this.workerOutput.show(true);
    this.workerStatusState = 'STARTING';

    const env = this.getAugmentedEnv();
    env['SWARMX_AUTO_PAIR'] = '1';
    const swiftExe = this.resolveExecutable('swift', env);

    this.workerOutput.appendLine('----------------------------------------------------');
    this.workerOutput.appendLine('🍏 [SwarmX ProcessManager] Starting Native macOS Worker');
    this.workerOutput.appendLine(`📁 SwarmX Project Root:      ${projectRoot}`);
    this.workerOutput.appendLine(`📂 Worker Directory:         ${workerDir}`);
    this.workerOutput.appendLine(`📦 [3] Resolved swift Path:   ${swiftExe}`);
    this.workerOutput.appendLine(`⚙️ [4] Spawn Command:         ${swiftExe} run swarmx-worker (cwd: ${workerDir})`);
    this.workerOutput.appendLine('----------------------------------------------------');

    try {
      this.workerProcess = spawn(swiftExe, ['run', 'swarmx-worker'], {
        cwd: workerDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.workerOwned = true;
      this.workerStatusState = 'ONLINE';

      this.workerProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        this.workerOutput.append(text);
      });

      this.workerProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        this.workerOutput.append(`[STDERR] ${text}`);
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
