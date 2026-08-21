import * as vscode from 'vscode';
import * as fs from 'fs';
import { CoreIpcClient } from './core_ipc_client';
import { EnvironmentManager } from './environment_manager';
import { ProcessManager } from './process_manager';
import { DashboardViewProvider } from './views/dashboard_view_provider';
import { WorkersTreeProvider, DiscoveredTreeProvider, TasksTreeProvider, WorkerTreeItem } from './views/worker_tree_provider';

let ipcClient: CoreIpcClient;
let envManager: EnvironmentManager;
let processManager: ProcessManager;
let dashboardProvider: DashboardViewProvider;
let statusBarItem: vscode.StatusBarItem;
let refreshInterval: NodeJS.Timeout | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('🐝 SwarmX Distributed Runtime extension activating...');

  const workspaceRoot = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : context.extensionPath;

  // 1. Initialize IPC Client, Environment Manager, and Process Manager
  ipcClient = new CoreIpcClient('/tmp/swarmx.sock');
  envManager = new EnvironmentManager(context);
  processManager = new ProcessManager(workspaceRoot, ipcClient, context.extensionPath);

  // 2. Register Dashboard Webview Provider
  dashboardProvider = new DashboardViewProvider(context.extensionUri, ipcClient, envManager, processManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboardProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 3. Register Tree Data Providers
  const workersProvider = new WorkersTreeProvider(ipcClient);
  const discoveredProvider = new DiscoveredTreeProvider(ipcClient);
  const tasksProvider = new TasksTreeProvider(ipcClient);

  vscode.window.registerTreeDataProvider('swarmx.workersView', workersProvider);
  vscode.window.registerTreeDataProvider('swarmx.discoveredView', discoveredProvider);
  vscode.window.registerTreeDataProvider('swarmx.tasksView', tasksProvider);

  // 4. Status Bar Configuration
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'swarmx.refresh';
  context.subscriptions.push(statusBarItem);

  async function updateStatusBar() {
    if (!ipcClient.connected) {
      statusBarItem.text = '$(circle-slash) SwarmX: Core Offline';
      statusBarItem.tooltip = 'SwarmX Core daemon offline. Click to start or reconnect.';
      statusBarItem.show();
      return;
    }

    try {
      const status = await ipcClient.request<any>('getStatus');
      const icon = status.enabled ? '$(server-process)' : '$(circle-slash)';
      const demoTag = envManager.forceSwarmDemo ? ' [DEMO: FORCED]' : '';
      const simTag = envManager.simulationMode ? ' [🧪 SIMULATION]' : '';
      statusBarItem.text = `${icon} SwarmX: ${status.eligibleWorkerCount}/${status.activeWorkerCount} Workers${demoTag}${simTag}`;
      statusBarItem.tooltip = `SwarmX Status: ${status.enabled ? 'Enabled' : 'Paused'}\nSimulation Mode: ${envManager.simulationMode ? 'Active (Virtual Worker)' : 'Disabled'}\nActive Tasks: ${status.runningTasks}\nCompleted: ${status.completedTasks}\nWorkspace Integration: ${envManager.active ? 'Active' : 'Inactive'}`;
      statusBarItem.show();
    } catch (e) {
      statusBarItem.text = '$(server-process) SwarmX: Connected';
      statusBarItem.show();
    }
  }

  async function tryConnect() {
    try {
      await ipcClient.connect();
      if (envManager.simulationMode) {
        await ipcClient.request('setSimulationMode', { enabled: true }).catch(() => {});
      }
      if (envManager.forceSwarmDemo) {
        await ipcClient.request('setForceSwarmMode', { enabled: true }).catch(() => {});
      }
    } catch (e) {
      // Daemon may not be running yet
    }
    workersProvider.refresh();
    discoveredProvider.refresh();
    tasksProvider.refresh();
    await dashboardProvider.update();
    await updateStatusBar();
  }

  // Initial connection probe
  await tryConnect();

  // 5. Periodic Polling (every 2 seconds)
  refreshInterval = setInterval(async () => {
    if (!ipcClient.connected) {
      try {
        await ipcClient.connect();
      } catch (e) {}
    }
    workersProvider.refresh();
    discoveredProvider.refresh();
    tasksProvider.refresh();
    await dashboardProvider.update();
    await updateStatusBar();
  }, 2000);

  // 6. Register Lifecycle Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.startCore', async () => {
      vscode.window.showInformationMessage('🐝 Starting SwarmX Core Daemon...');
      const ok = await processManager.startCore();
      if (ok) {
        await tryConnect();
        vscode.window.showInformationMessage('✨ SwarmX Core is ONLINE.');
      } else {
        vscode.window.showErrorMessage('❌ Failed to start SwarmX Core. Check Output channel for details.');
      }
      await dashboardProvider.update();
      await updateStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.stopCore', async () => {
      await processManager.stopCore();
      await tryConnect();
      vscode.window.showInformationMessage('🛑 SwarmX Core stopped.');
      await dashboardProvider.update();
      await updateStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.restartCore', async () => {
      vscode.window.showInformationMessage('🔄 Restarting SwarmX Core...');
      await processManager.restartCore();
      await tryConnect();
      vscode.window.showInformationMessage('✨ SwarmX Core restarted.');
      await dashboardProvider.update();
      await updateStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.startLocalWorker', async () => {
      vscode.window.showInformationMessage('🍏 Starting local SwarmX Worker...');
      const ok = await processManager.startWorker();
      if (ok) {
        vscode.window.showInformationMessage('🍏 SwarmX Local Worker process spawned.');
      } else {
        vscode.window.showErrorMessage('❌ Failed to start local worker.');
      }
      await dashboardProvider.update();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.stopLocalWorker', async () => {
      await processManager.stopWorker();
      vscode.window.showInformationMessage('🛑 Local SwarmX Worker stopped.');
      await dashboardProvider.update();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.restartLocalWorker', async () => {
      await processManager.restartWorker();
      vscode.window.showInformationMessage('🔄 Local SwarmX Worker restarted.');
      await dashboardProvider.update();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.refresh', async () => {
      if (!ipcClient.connected) {
        await tryConnect();
      }
      workersProvider.refresh();
      discoveredProvider.refresh();
      tasksProvider.refresh();
      await dashboardProvider.update();
      await updateStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.enableWorkspace', async () => {
      await envManager.setEnabled(true);
      await dashboardProvider.update();
      await updateStatusBar();
      vscode.window.showInformationMessage('🐝 SwarmX Workspace Integration ENABLED. PYTHONPATH configured.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.disableWorkspace', async () => {
      await envManager.setEnabled(false);
      await dashboardProvider.update();
      await updateStatusBar();
      vscode.window.showInformationMessage('SwarmX Workspace Integration DISABLED.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.toggleForceSwarmDemo', async () => {
      const newForce = !envManager.forceSwarmDemo;
      await envManager.setForceSwarmDemo(newForce);
      try {
        await ipcClient.request('setForceSwarmMode', { enabled: newForce });
      } catch (e) {}
      await dashboardProvider.update();
      await updateStatusBar();
      if (newForce) {
        vscode.window.showWarningMessage('⚡ SwarmX DEMO MODE Active: Force Swarm is ON.');
      } else {
        vscode.window.showInformationMessage('SwarmX: Returned to Production Adaptive Cost Model.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.toggleSimulation', async () => {
      const newSim = !envManager.simulationMode;
      await envManager.setSimulationMode(newSim);
      try {
        await ipcClient.request('setSimulationMode', { enabled: newSim });
      } catch (e) {}
      await dashboardProvider.update();
      await updateStatusBar();
      if (newSim) {
        vscode.window.showInformationMessage('🧪 SwarmX Development Simulation Mode ENABLED (Virtual Apple Silicon Worker active).');
      } else {
        vscode.window.showInformationMessage('SwarmX Development Simulation Mode DISABLED.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.enableSimulation', async () => {
      await envManager.setSimulationMode(true);
      try {
        await ipcClient.request('setSimulationMode', { enabled: true });
      } catch (e) {}
      await dashboardProvider.update();
      await updateStatusBar();
      vscode.window.showInformationMessage('🧪 SwarmX Development Simulation Mode ENABLED (Virtual Apple Silicon Worker active).');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.disableSimulation', async () => {
      await envManager.setSimulationMode(false);
      try {
        await ipcClient.request('setSimulationMode', { enabled: false });
      } catch (e) {}
      await dashboardProvider.update();
      await updateStatusBar();
      vscode.window.showInformationMessage('SwarmX Development Simulation Mode DISABLED.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.viewLogs', async () => {
      const logPath = '/tmp/swarmx-core.log';
      if (fs.existsSync(logPath)) {
        const doc = await vscode.workspace.openTextDocument(logPath);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      } else {
        vscode.window.showWarningMessage(`No log file found at ${logPath}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.toggleSwarm', async () => {
      try {
        const res = await ipcClient.request<any>('toggleSwarm');
        vscode.window.showInformationMessage(`Swarm execution ${res.enabled ? 'Enabled' : 'Paused'}.`);
        await updateStatusBar();
        await dashboardProvider.update();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to toggle Swarm: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.connectWorker', async (item?: WorkerTreeItem | { deviceId: string }) => {
      const deviceId = item?.deviceId || await vscode.window.showInputBox({ prompt: 'Enter Worker Device ID to Pair' });
      if (!deviceId) return;

      try {
        await ipcClient.request<any>('initiatePairing', { workerDeviceId: deviceId });
        vscode.window.showInformationMessage(
          `🔔 Initiated pairing with [${deviceId}]. Glance at worker screen and verify comparison code.`,
          'OK'
        );
        workersProvider.refresh();
        discoveredProvider.refresh();
        await dashboardProvider.update();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Pairing failed: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.revokeWorker', async (item?: WorkerTreeItem | { deviceId: string }) => {
      const deviceId = item?.deviceId;
      if (!deviceId) return;

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to revoke trust for worker ${deviceId}? The worker will be disconnected immediately and must re-pair.`,
        'Revoke Trust',
        'Cancel'
      );

      if (confirm === 'Revoke Trust') {
        try {
          await ipcClient.request('revokeWorker', { deviceId });
          vscode.window.showInformationMessage(`Revoked trust for ${deviceId}.`);
          workersProvider.refresh();
          discoveredProvider.refresh();
          await dashboardProvider.update();
          await updateStatusBar();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Revocation failed: ${e.message}`);
        }
      }
    })
  );

  console.log('🐝 SwarmX Distributed Runtime extension activated successfully.');
}

export function deactivate() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  if (processManager) {
    processManager.dispose(); // Only terminates extension-owned processes
  }
  if (ipcClient) {
    ipcClient.disconnect();
  }
}
