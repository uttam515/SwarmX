import * as vscode from 'vscode';
import { CoreIpcClient } from './core_ipc_client';
import { WorkersTreeProvider, DiscoveredTreeProvider, TasksTreeProvider, WorkerTreeItem } from './views/worker_tree_provider';

let ipcClient: CoreIpcClient;
let statusBarItem: vscode.StatusBarItem;
let refreshInterval: NodeJS.Timeout | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('SwarmX extension activated.');

  ipcClient = new CoreIpcClient('/tmp/swarmx.sock');

  const workersProvider = new WorkersTreeProvider(ipcClient);
  const discoveredProvider = new DiscoveredTreeProvider(ipcClient);
  const tasksProvider = new TasksTreeProvider(ipcClient);

  vscode.window.registerTreeDataProvider('swarmx.workersView', workersProvider);
  vscode.window.registerTreeDataProvider('swarmx.discoveredView', discoveredProvider);
  vscode.window.registerTreeDataProvider('swarmx.tasksView', tasksProvider);

  // Status Bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'swarmx.refresh';
  context.subscriptions.push(statusBarItem);

  async function updateStatusBar() {
    if (!ipcClient.connected) {
      statusBarItem.text = '$(server-process) SwarmX: Disconnected';
      statusBarItem.tooltip = 'SwarmX Core daemon not connected. Click to retry.';
      statusBarItem.show();
      return;
    }

    try {
      const status = await ipcClient.request<any>('getStatus');
      const icon = status.enabled ? '$(server-process)' : '$(circle-slash)';
      statusBarItem.text = `${icon} SwarmX: ${status.eligibleWorkerCount}/${status.activeWorkerCount} Workers`;
      statusBarItem.tooltip = `SwarmX Status: ${status.enabled ? 'Enabled' : 'Paused'}\nActive Tasks: ${status.runningTasks}\nCompleted: ${status.completedTasks}`;
      statusBarItem.show();
    } catch (e) {
      statusBarItem.text = '$(server-process) SwarmX: Error';
      statusBarItem.show();
    }
  }

  async function tryConnect() {
    try {
      await ipcClient.connect();
      vscode.window.showInformationMessage('Connected to SwarmX Core Daemon.');
    } catch (e) {
      // Daemon may not be running yet
    }
    workersProvider.refresh();
    discoveredProvider.refresh();
    tasksProvider.refresh();
    await updateStatusBar();
  }

  await tryConnect();

  // Periodic polling every 3 seconds
  refreshInterval = setInterval(async () => {
    if (!ipcClient.connected) {
      try {
        await ipcClient.connect();
      } catch (e) {}
    }
    workersProvider.refresh();
    discoveredProvider.refresh();
    tasksProvider.refresh();
    await updateStatusBar();
  }, 3000);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.refresh', async () => {
      if (!ipcClient.connected) {
        await tryConnect();
      }
      workersProvider.refresh();
      discoveredProvider.refresh();
      tasksProvider.refresh();
      await updateStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.toggleSwarm', async () => {
      try {
        const res = await ipcClient.request<any>('toggleSwarm');
        vscode.window.showInformationMessage(`Swarm execution ${res.enabled ? 'Enabled' : 'Paused'}.`);
        await updateStatusBar();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to toggle Swarm: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.connectWorker', async (item?: WorkerTreeItem) => {
      const deviceId = item?.deviceId || await vscode.window.showInputBox({ prompt: 'Enter Worker Device ID to Pair' });
      if (!deviceId) return;

      try {
        const initResult = await ipcClient.request<any>('initiatePairing', { workerDeviceId: deviceId });
        vscode.window.showInformationMessage(
          `Initiated pairing with ${deviceId}. Glance at worker prompt and verify comparison code.`,
          'OK'
        );
        workersProvider.refresh();
        discoveredProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Pairing failed: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swarmx.revokeWorker', async (item?: WorkerTreeItem) => {
      const deviceId = item?.deviceId;
      if (!deviceId) return;

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to revoke trust for worker ${deviceId}? This device will be disconnected and must re-pair to reconnect.`,
        'Revoke Trust',
        'Cancel'
      );

      if (confirm === 'Revoke Trust') {
        try {
          await ipcClient.request('revokeWorker', { deviceId });
          vscode.window.showInformationMessage(`Revoked trust for ${deviceId}.`);
          workersProvider.refresh();
          discoveredProvider.refresh();
          await updateStatusBar();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Revocation failed: ${e.message}`);
        }
      }
    })
  );
}

export function deactivate() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  if (ipcClient) {
    ipcClient.disconnect();
  }
}
