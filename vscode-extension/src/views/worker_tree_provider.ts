import * as vscode from 'vscode';
import { CoreIpcClient } from '../core_ipc_client';

export class WorkerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly deviceId?: string,
    public readonly iconName?: string,
    public readonly tooltipText?: string,
    public readonly telemetry?: any
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.contextValue = contextValue;

    if (iconName) {
      this.iconPath = new vscode.ThemeIcon(iconName);
    }
    if (tooltipText) {
      this.tooltip = tooltipText;
    }
  }
}

export class WorkersTreeProvider implements vscode.TreeDataProvider<WorkerTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<WorkerTreeItem | undefined | null | void> = new vscode.EventEmitter<WorkerTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<WorkerTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private ipcClient: CoreIpcClient) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: WorkerTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: WorkerTreeItem): Promise<WorkerTreeItem[]> {
    if (!this.ipcClient.connected) {
      return [
        new WorkerTreeItem(
          'Core Daemon Offline',
          'Run ./bin/swarmx start to activate',
          vscode.TreeItemCollapsibleState.None,
          'offline',
          undefined,
          'circle-slash',
          'Core socket at /tmp/swarmx.sock is not connected'
        )
      ];
    }

    try {
      const workers = await this.ipcClient.request<any[]>('listConnectedWorkers') || [];

      const clusterItems: WorkerTreeItem[] = [];
      clusterItems.push(
        new WorkerTreeItem(
          'Local Host (Host Controller)',
          'Apple Silicon • Certified Kernel Host',
          vscode.TreeItemCollapsibleState.None,
          'hostNode',
          'localhost',
          'laptop',
          'SwarmX Core daemon running on local host'
        )
      );

      if (workers.length === 0) {
        clusterItems.push(
          new WorkerTreeItem(
            'No Remote Workers Connected',
            'Run swift run swarmx-worker on Mac #2',
            vscode.TreeItemCollapsibleState.None,
            'emptyWorker',
            undefined,
            'radio-tower',
            'Waiting for Bonjour mDNS discovery on local network'
          )
        );
      } else {
        for (const w of workers) {
          const prof = w.capabilityProfile;
          const telem = w.latestTelemetry;
          const battery = telem ? `${Math.round(telem.batteryLevel * 100)}%` : '100%';
          const thermal = telem ? `T:${telem.thermalState}` : 'Nominal';
          const gpuBadge = prof?.hasGpu ? '⚡ GPU' : 'CPU';
          const statusBadge = w.isEligible ? '🟢 Eligible' : '🟡 Ineligible';

          clusterItems.push(
            new WorkerTreeItem(
              `${prof?.deviceName || w.deviceId} [${gpuBadge}]`,
              `${statusBadge} | 🔋 ${battery} | 🌡️ ${thermal}`,
              vscode.TreeItemCollapsibleState.None,
              'connectedWorker',
              w.deviceId,
              w.isEligible ? 'server-environment' : 'warning',
              `Platform: ${prof?.osType} ${prof?.cpuArch}\nCores: ${prof?.cpuCores}\nRAM: ${prof?.totalRamMb} MB`,
              telem
            )
          );
        }
      }

      clusterItems.push(
        new WorkerTreeItem(
          'Certified Kernel: image_filter_box_blur_v1',
          'Domain: Image Processing • Pure & Idempotent',
          vscode.TreeItemCollapsibleState.None,
          'kernelInfo',
          undefined,
          'verified',
          'Tolerance validator: Δmax <= 2, MSE <= 0.5'
        )
      );

      return clusterItems;
    } catch (err: any) {
      return [
        new WorkerTreeItem(
          'Error loading SwarmX dashboard',
          err.message,
          vscode.TreeItemCollapsibleState.None,
          'error',
          undefined,
          'error'
        )
      ];
    }
  }
}

export class DiscoveredTreeProvider implements vscode.TreeDataProvider<WorkerTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<WorkerTreeItem | undefined | null | void> = new vscode.EventEmitter<WorkerTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<WorkerTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private ipcClient: CoreIpcClient) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: WorkerTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: WorkerTreeItem): Promise<WorkerTreeItem[]> {
    if (!this.ipcClient.connected) return [];
    try {
      const discovered = await this.ipcClient.request<any[]>('listDiscoveredWorkers') || [];
      if (discovered.length === 0) {
        return [
          new WorkerTreeItem(
            'No Devices Discovered',
            'Listening on _swarmx._tcp...',
            vscode.TreeItemCollapsibleState.None,
            'empty',
            undefined,
            'broadcast'
          )
        ];
      }

      return discovered.map(d => new WorkerTreeItem(
        d.deviceName || d.deviceId,
        `${d.host}:${d.port} (mDNS)`,
        vscode.TreeItemCollapsibleState.None,
        'discoveredWorker',
        d.deviceId,
        'radio-tower',
        `Discovered via Bonjour mDNS beacon from ${d.host}`
      ));
    } catch (e: any) {
      return [];
    }
  }
}

export class TasksTreeProvider implements vscode.TreeDataProvider<WorkerTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<WorkerTreeItem | undefined | null | void> = new vscode.EventEmitter<WorkerTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<WorkerTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private ipcClient: CoreIpcClient) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: WorkerTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: WorkerTreeItem): Promise<WorkerTreeItem[]> {
    if (!this.ipcClient.connected) return [];
    try {
      const status = await this.ipcClient.request<any>('getStatus');
      return [
        new WorkerTreeItem(
          `Tasks: ${status?.runningTasks ?? 0} Active / ${status?.completedTasks ?? 0} Done`,
          `Cost Gating: ${status?.enabled ? 'Adaptive Swarm Active' : 'Local Only'}`,
          vscode.TreeItemCollapsibleState.None,
          'taskSummary',
          undefined,
          'pulse'
        )
      ];
    } catch (e: any) {
      return [];
    }
  }
}
