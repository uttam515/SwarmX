import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class EnvironmentManager {
  private context: vscode.ExtensionContext;
  private isEnabled: boolean = true;
  private isForceSwarmDemo: boolean = false;
  private isSimulationMode: boolean = false;
  private pythonSdkPath: string = '';
  private activeInterpreter: string = 'python3';

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.initPaths();
    this.loadConfiguration();
    this.applyEnvironment();
  }

  private initPaths(): void {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders && wsFolders.length > 0) {
      const root = wsFolders[0].uri.fsPath;
      const candidateSdk = path.join(root, 'sdk', 'python');
      if (fs.existsSync(candidateSdk)) {
        this.pythonSdkPath = candidateSdk;
      } else {
        // Search subdirectories for SwarmX project (e.g. opened in Demo/ containing swarmx/)
        try {
          const entries = fs.readdirSync(root, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              const subSdk = path.join(root, entry.name, 'sdk', 'python');
              if (fs.existsSync(subSdk)) {
                this.pythonSdkPath = subSdk;
                break;
              }
            }
          }
        } catch (e) {}
      }
    }

    if (!this.pythonSdkPath) {
      // Fallback relative to extension folder
      const fallback = path.resolve(this.context.extensionPath, '..', 'sdk', 'python');
      this.pythonSdkPath = fs.existsSync(fallback) ? fallback : path.join(this.context.extensionPath, 'sdk', 'python');
    }

    // Determine interpreter setting
    const pyConfig = vscode.workspace.getConfiguration('python');
    this.activeInterpreter = pyConfig.get<string>('defaultInterpreterPath') || 'python3';
  }

  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('swarmx');
    this.isEnabled = config.get<boolean>('enableWorkspaceIntegration', true);
    this.isForceSwarmDemo = config.get<boolean>('forceSwarmDemoMode', false);
    this.isSimulationMode = config.get<boolean>('enableSimulationMode', false);
  }

  public applyEnvironment(): void {
    const collection = this.context.environmentVariableCollection;
    collection.description = 'SwarmX Transparent Distributed Runtime Environment';

    if (this.isEnabled && this.pythonSdkPath) {
      // Inject PYTHONPATH into all workspace terminals and execution contexts
      collection.replace('PYTHONPATH', this.pythonSdkPath);
      collection.replace('SWARMX_IPC_PATH', '/tmp/swarmx.sock');

      if (this.isForceSwarmDemo) {
        collection.replace('SWARMX_FORCE_SWARM', '1');
      } else {
        collection.delete('SWARMX_FORCE_SWARM');
      }

      // Also ensure workspace settings for terminal & Python extension are synced
      this.syncWorkspaceSettings(true);
    } else {
      collection.clear();
      this.syncWorkspaceSettings(false);
    }
  }

  private async syncWorkspaceSettings(enable: boolean): Promise<void> {
    try {
      const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated.env');
      const osxEnv = terminalConfig.get<Record<string, string>>('osx') || {};
      const updated: Record<string, string> = { ...osxEnv };

      if (enable && this.pythonSdkPath) {
        updated['PYTHONPATH'] = this.pythonSdkPath;
        updated['SWARMX_IPC_PATH'] = '/tmp/swarmx.sock';
        if (this.isForceSwarmDemo) {
          updated['SWARMX_FORCE_SWARM'] = '1';
        } else {
          delete updated['SWARMX_FORCE_SWARM'];
        }
      } else {
        delete updated['PYTHONPATH'];
        delete updated['SWARMX_IPC_PATH'];
        delete updated['SWARMX_FORCE_SWARM'];
      }

      await terminalConfig.update('osx', updated, vscode.ConfigurationTarget.Workspace);
    } catch (e) {
      // Non-critical if settings update fails (e.g. no workspace folder open)
    }
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    this.isEnabled = enabled;
    const config = vscode.workspace.getConfiguration('swarmx');
    await config.update('enableWorkspaceIntegration', enabled, vscode.ConfigurationTarget.Workspace);
    this.applyEnvironment();
  }

  public async setForceSwarmDemo(enabled: boolean): Promise<void> {
    this.isForceSwarmDemo = enabled;
    const config = vscode.workspace.getConfiguration('swarmx');
    await config.update('forceSwarmDemoMode', enabled, vscode.ConfigurationTarget.Workspace);
    this.applyEnvironment();
  }

  public async setSimulationMode(enabled: boolean): Promise<void> {
    this.isSimulationMode = enabled;
    const config = vscode.workspace.getConfiguration('swarmx');
    await config.update('enableSimulationMode', enabled, vscode.ConfigurationTarget.Workspace);
    this.applyEnvironment();
  }

  public get active(): boolean {
    return this.isEnabled;
  }

  public get forceSwarmDemo(): boolean {
    return this.isForceSwarmDemo;
  }

  public get simulationMode(): boolean {
    return this.isSimulationMode;
  }

  public get sdkPath(): string {
    return this.pythonSdkPath;
  }

  public get interpreter(): string {
    return this.activeInterpreter;
  }
}
