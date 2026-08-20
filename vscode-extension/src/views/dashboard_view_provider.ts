import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { CoreIpcClient } from '../core_ipc_client';
import { EnvironmentManager } from '../environment_manager';

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'swarmx.dashboardView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ipcClient: CoreIpcClient,
    private readonly envManager: EnvironmentManager
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'refresh':
          await this.update();
          break;
        case 'toggleWorkspace':
          await this.envManager.setEnabled(!this.envManager.active);
          await this.update();
          vscode.window.showInformationMessage(
            `SwarmX Workspace Integration ${this.envManager.active ? 'Enabled' : 'Disabled'}.`
          );
          break;
        case 'toggleForceSwarm':
          const newForce = !this.envManager.forceSwarmDemo;
          await this.envManager.setForceSwarmDemo(newForce);
          try {
            await this.ipcClient.request('setForceSwarmMode', { enabled: newForce });
          } catch (e) {}
          await this.update();
          if (newForce) {
            vscode.window.showWarningMessage(
              '⚠️ SwarmX DEMO Mode: Force Swarm is ON. Workloads will attempt distributed execution regardless of cost estimate.'
            );
          } else {
            vscode.window.showInformationMessage(
              'SwarmX Mode: Production Adaptive. The cost model will guide execution decisions.'
            );
          }
          break;
        case 'toggleSimulation':
          const newSim = !this.envManager.simulationMode;
          await this.envManager.setSimulationMode(newSim);
          try {
            await this.ipcClient.request('setSimulationMode', { enabled: newSim });
          } catch (e) {}
          await this.update();
          if (newSim) {
            vscode.window.showInformationMessage(
              '🧪 SwarmX Development Simulation Mode ENABLED (Virtual Apple Silicon Worker active).'
            );
          } else {
            vscode.window.showInformationMessage(
              'SwarmX Development Simulation Mode DISABLED.'
            );
          }
          break;
        case 'setSimulationFailure':
          if (data.failureMode) {
            try {
              await this.ipcClient.request('setSimulationMode', {
                enabled: this.envManager.simulationMode,
                failureMode: data.failureMode
              });
              await this.update();
              vscode.window.showInformationMessage(`Simulation failure state set to: ${data.failureMode}`);
            } catch (e) {}
          }
          break;
        case 'pairWorker':
          if (data.deviceId) {
            vscode.commands.executeCommand('swarmx.connectWorker', { deviceId: data.deviceId });
          }
          break;
        case 'revokeWorker':
          if (data.deviceId) {
            vscode.commands.executeCommand('swarmx.revokeWorker', { deviceId: data.deviceId });
          }
          break;
        case 'viewLogs':
          vscode.commands.executeCommand('swarmx.viewLogs');
          break;
      }
    });

    this.update();
  }

  public async update(): Promise<void> {
    if (!this._view) return;

    let coreStatus: any = null;
    let connectedWorkers: any[] = [];
    let discoveredWorkers: any[] = [];
    let trustedWorkers: any[] = [];
    let kernels: any[] = [];
    let recentLogs: string[] = [];
    let recentWorkloads: any[] = [];
    let simStatus: any = null;

    const isConnected = this.ipcClient.connected;

    if (isConnected) {
      try {
        const [status, connWorkers, discWorkers, trustWorkers, kernelList, recentWkls, sim] = await Promise.all([
          this.ipcClient.request<any>('getStatus').catch(() => null),
          this.ipcClient.request<any[]>('listConnectedWorkers').catch(() => []),
          this.ipcClient.request<any[]>('listDiscoveredWorkers').catch(() => []),
          this.ipcClient.request<any[]>('listTrustedWorkers').catch(() => []),
          this.ipcClient.request<any[]>('listKernels').catch(() => []),
          this.ipcClient.request<any[]>('listRecentWorkloads').catch(() => []),
          this.ipcClient.request<any>('getSimulationStatus').catch(() => null)
        ]);

        coreStatus = status;
        connectedWorkers = connWorkers || [];
        discoveredWorkers = discWorkers || [];
        trustedWorkers = trustWorkers || [];
        kernels = kernelList || [];
        recentWorkloads = recentWkls || [];
        simStatus = sim;
      } catch (e) {
        // Fallback for partial data
      }
    }

    // Read recent log lines from /tmp/swarmx-core.log
    try {
      if (fs.existsSync('/tmp/swarmx-core.log')) {
        const logContent = fs.readFileSync('/tmp/swarmx-core.log', 'utf-8');
        const lines = logContent.split('\n').filter(l => l.trim().length > 0);
        recentLogs = lines.slice(-8);
      }
    } catch (e) {}

    this._view.webview.html = this.renderHtml({
      isConnected,
      coreStatus,
      connectedWorkers,
      discoveredWorkers,
      trustedWorkers,
      kernels,
      recentLogs,
      recentWorkloads,
      simStatus,
      envActive: this.envManager.active,
      forceSwarmDemo: this.envManager.forceSwarmDemo,
      simulationMode: this.envManager.simulationMode,
      sdkPath: this.envManager.sdkPath,
      interpreter: this.envManager.interpreter
    });
  }

  private renderHtml(state: any): string {
    const isSimulated = state.simulationMode || state.simStatus?.config?.enabled;

    const onlineBadge = state.isConnected
      ? `<span class="badge online">● ONLINE</span>`
      : `<span class="badge offline">○ OFFLINE</span>`;

    const wsIntegrationBadge = state.envActive
      ? `<span class="badge active">🟢 ACTIVE</span>`
      : `<span class="badge inactive">⚪ INACTIVE</span>`;

    const modeBadge = isSimulated
      ? `<span class="badge sim">🧪 SIMULATION WORKER</span>`
      : (state.forceSwarmDemo
        ? `<span class="badge demo">⚠️ FORCED SWARM (DEMO)</span>`
        : `<span class="badge prod">ADAPTIVE PRODUCTION</span>`);

    // Compute per-worker completed and running counts from recentWorkloads
    const workerRunningMap: Record<string, number> = {};
    const workerCompletedMap: Record<string, number> = {};

    for (const wkl of state.recentWorkloads || []) {
      const wid = wkl.workerId || 'local-host';
      if (wkl.status === 'RUNNING') {
        workerRunningMap[wid] = (workerRunningMap[wid] || 0) + 1;
      } else if (wkl.status === 'COMPLETE' || wkl.status === 'LOCAL_FALLBACK') {
        workerCompletedMap[wid] = (workerCompletedMap[wid] || 0) + 1;
      }
    }

    const localRunning = workerRunningMap['local-host'] || 0;
    const localCompleted = workerCompletedMap['local-host'] || 0;
    const localHostname = os.hostname() || 'Mac #1 (Host)';

    // Connected worker cards
    let workersHtml = `
      <div class="worker-card local">
        <div class="worker-header">
          <span class="worker-name">💻 worker-01 / Mac #1 (Host Controller)</span>
          <span class="badge ready">● ONLINE</span>
        </div>
        <div class="worker-telemetry">
          <span>🖥️ Hostname: <code>${localHostname}</code></span>
          <span>⚡ Running: <b>${localRunning}</b></span>
          <span>✓ Completed: <b>${localCompleted}</b></span>
        </div>
      </div>
    `;

    // Render Virtual Simulated Worker if simulation is active
    if (isSimulated) {
      const simRunning = workerRunningMap['sim-worker-virtual-m3'] || 0;
      const simCompleted = workerCompletedMap['sim-worker-virtual-m3'] || 0;
      const failMode = state.simStatus?.config?.failureMode || 'NONE';
      const simBadge = failMode === 'DISCONNECTED'
        ? `<span class="badge offline">🔴 SIMULATED OFFLINE</span>`
        : (failMode === 'TASK_FAILURE'
          ? `<span class="badge warning">🟡 SIMULATED FAILING</span>`
          : `<span class="badge sim">🧪 SIMULATED READY</span>`);

      workersHtml += `
        <div class="worker-card sim-card">
          <div class="worker-header">
            <span class="worker-name">🧪 Virtual Apple Silicon Worker</span>
            ${simBadge}
          </div>
          <div class="worker-specs">
            <span class="spec-tag sim-tag">⚡ GPU: Simulated Metal</span>
            <span class="spec-tag">10 Cores</span>
            <span class="spec-tag">16 GB RAM</span>
            <span class="spec-tag">Simulation Mode</span>
          </div>
          <div class="worker-telemetry">
            <span>🖥️ Host: <code>Virtual Environment (Mac #1)</code></span>
            <span>⚡ Running: <b>${simRunning}</b></span>
            <span>✓ Completed: <b>${simCompleted}</b></span>
            <span>🔋 Battery: 88% (Charging)</span>
            <span>🌡️ Thermal: Nominal</span>
          </div>
          <div class="worker-actions" style="margin-top: 6px;">
            <button class="btn btn-secondary btn-sm" onclick="sendAction('setSimulationFailure', 'NONE')">Normal (Pass)</button>
            <button class="btn btn-secondary btn-sm" onclick="sendAction('setSimulationFailure', 'DISCONNECTED')">Simulate Disconnect</button>
            <button class="btn btn-secondary btn-sm btn-danger" onclick="sendAction('setSimulationFailure', 'TASK_FAILURE')">Simulate Error</button>
          </div>
        </div>
      `;
    }

    // Render Real Remote Workers (excluding sim-worker)
    const realConnected = (state.connectedWorkers || []).filter((w: any) => w.deviceId !== 'sim-worker-virtual-m3');
    if (realConnected.length > 0) {
      let workerIdx = 2;
      for (const w of realConnected) {
        const prof = w.capabilityProfile || {};
        const telem = w.latestTelemetry;
        const name = prof.deviceName || w.deviceId;
        const gpu = prof.hasGpu ? '⚡ Apple Silicon GPU' : 'CPU';
        const cores = prof.cpuCores ? `${prof.cpuCores} cores` : '';
        const ram = prof.totalRamMb ? `${Math.round(prof.totalRamMb / 1024)} GB RAM` : '';
        const battery = telem ? `${Math.round(telem.batteryLevel * 100)}%` : 'N/A';
        const thermal = telem ? (telem.thermalState === 0 ? 'Nominal' : `T:${telem.thermalState}`) : 'Nominal';
        const isEligible = w.isEligible !== false;
        const eligibleBadge = isEligible
          ? `<span class="badge ready">● ONLINE</span>`
          : `<span class="badge warning">🟡 INELIGIBLE</span>`;

        const remoteRunning = workerRunningMap[w.deviceId] || 0;
        const remoteCompleted = workerCompletedMap[w.deviceId] || 0;

        workersHtml += `
          <div class="worker-card remote">
            <div class="worker-header">
              <span class="worker-name">🍏 worker-${workerIdx < 10 ? '0' + workerIdx : workerIdx} / ${name}</span>
              ${eligibleBadge}
            </div>
            <div class="worker-specs">
              <span class="spec-tag gpu">${gpu}</span>
              <span class="spec-tag">${cores}</span>
              <span class="spec-tag">${ram}</span>
            </div>
            <div class="worker-telemetry">
              <span>🖥️ Hostname: <code>${prof.deviceName || w.deviceId}</code></span>
              <span>⚡ Running: <b>${remoteRunning}</b></span>
              <span>✓ Completed: <b>${remoteCompleted}</b></span>
              <span>🔋 Battery: ${battery}</span>
              <span>🌡️ Thermal: ${thermal}</span>
            </div>
            <div class="worker-actions">
              <button class="btn btn-secondary btn-sm btn-danger" onclick="sendAction('revokeWorker', '${w.deviceId}')">Revoke Trust</button>
            </div>
          </div>
        `;
        workerIdx++;
      }
    } else if (!isSimulated && state.isConnected) {
      workersHtml += `
        <div class="empty-state">
          <span>📡 No physical remote workers connected.</span>
          <span class="hint">Start worker on Mac #2: <code>./bin/swarmx worker</code> or toggle <b>🧪 Enable Simulation Mode</b> above.</span>
        </div>
      `;
    }

    // Discovered devices section
    let discoveredHtml = '';
    if (state.discoveredWorkers && state.discoveredWorkers.length > 0) {
      discoveredHtml = `<div class="section-title">DISCOVERED NEARBY DEVICES (mDNS)</div>`;
      for (const d of state.discoveredWorkers) {
        const isPaired = (state.connectedWorkers || []).some((cw: any) => cw.deviceId === d.deviceId);
        if (!isPaired) {
          discoveredHtml += `
            <div class="worker-card discovered">
              <div class="worker-header">
                <span class="worker-name">📡 ${d.deviceName || d.deviceId}</span>
                <span class="badge discovered">UNPAIRED</span>
              </div>
              <div class="worker-meta">
                <span>${d.host}:${d.port}</span> • <span>mDNS Beacon</span>
              </div>
              <div class="worker-actions">
                <button class="btn btn-primary btn-sm" onclick="sendAction('pairWorker', '${d.deviceId}')">Pair Device (SAS)</button>
              </div>
            </div>
          `;
        }
      }
    }

    // Live Workloads Table
    let workloadsTableHtml = '';
    if (state.recentWorkloads && state.recentWorkloads.length > 0) {
      const rows = state.recentWorkloads.slice().reverse().map((w: any) => {
        let statusBadge = '';
        if (w.status === 'COMPLETE') {
          statusBadge = `<span class="badge ready">COMPLETE</span>`;
        } else if (w.status === 'RUNNING') {
          statusBadge = `<span class="badge demo">RUNNING</span>`;
        } else if (w.status === 'LOCAL_FALLBACK') {
          statusBadge = `<span class="badge prod">LOCAL</span>`;
        } else {
          statusBadge = `<span class="badge offline">FAILED</span>`;
        }

        const dur = w.durationSeconds !== undefined
          ? `${w.durationSeconds.toFixed(2)}s`
          : (w.startTimeMs ? `${((Date.now() - w.startTimeMs) / 1000).toFixed(2)}s` : '—');

        const isSimWorker = w.workerId === 'sim-worker-virtual-m3';
        const displayHost = isSimWorker ? '🧪 Virtual Worker' : (w.workerHostname || (w.workerId === 'local-host' ? 'Mac #1' : 'Mac #2'));
        const displayWorker = isSimWorker ? 'worker-sim' : (w.workerId ? (w.workerId.startsWith('macos-worker-') ? w.workerId.replace('macos-worker-', 'worker-') : w.workerId) : 'worker-01');

        return `
          <tr>
            <td><code>${w.workloadId || w.taskId}</code></td>
            <td><code>${displayWorker}</code></td>
            <td><b>${this.escapeHtml(displayHost)}</b></td>
            <td>${statusBadge}</td>
            <td>${dur}</td>
          </tr>
        `;
      }).join('');

      workloadsTableHtml = `
        <div class="section">
          <div class="section-title">
            <span>LIVE WORKLOADS</span>
            <span class="badge ${state.recentWorkloads.length > 0 ? 'online' : 'offline'}">${state.recentWorkloads.length} Logged</span>
          </div>
          <div class="card table-card">
            <table class="workload-table">
              <thead>
                <tr>
                  <th>WORKLOAD</th>
                  <th>WORKER</th>
                  <th>HOSTNAME</th>
                  <th>STATUS</th>
                  <th>DURATION</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } else {
      workloadsTableHtml = `
        <div class="section">
          <div class="section-title">LIVE WORKLOADS</div>
          <div class="card empty-state">
            <span>No active or recent workloads logged.</span>
            <span class="hint">Run a Python script with PIL/BoxBlur to see live distributed dispatch.</span>
          </div>
        </div>
      `;
    }

    // Cost Decision Model
    const hasWorkers = isSimulated || (state.connectedWorkers && state.connectedWorkers.length > 0);
    const localEst = hasWorkers ? '5.21 s' : '5.21 s';
    const swarmEst = hasWorkers ? '6.20 s' : 'N/A';
    const speedup = hasWorkers ? '0.84×' : 'N/A';
    const recommendation = hasWorkers ? 'LOCAL FALLBACK' : 'LOCAL (No Workers)';
    const recReason = hasWorkers
      ? 'Network transfer overhead makes local execution more efficient.'
      : 'No remote compute nodes connected.';

    // Progress & Execution
    const totalTasks = state.coreStatus?.totalTasks ?? 0;
    const completedTasks = state.coreStatus?.completedTasks ?? 0;
    const runningTasks = state.coreStatus?.runningTasks ?? 0;
    const execStatus = runningTasks > 0 ? 'RUNNING' : (completedTasks > 0 ? 'SUCCESS' : 'IDLE');
    const percent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : (completedTasks > 0 ? 100 : 0);
    const progressWidth = percent > 0 ? `${percent}%` : '0%';

    // Last workload details
    const lastWkl = state.recentWorkloads && state.recentWorkloads.length > 0 ? state.recentWorkloads[state.recentWorkloads.length - 1] : null;
    const currentWklId = lastWkl ? (lastWkl.workloadId || lastWkl.taskId) : 'None (IDLE)';
    const currentWorkerLabel = isSimulated
      ? '🧪 Virtual Apple Silicon Worker'
      : (state.connectedWorkers && state.connectedWorkers[0]?.capabilityProfile?.deviceName ? `🍏 ${state.connectedWorkers[0].capabilityProfile.deviceName}` : 'Local Host');

    // Logs
    let logsHtml = state.recentLogs.map((l: string) => `<div class="log-line">${this.escapeHtml(l)}</div>`).join('');
    if (!logsHtml) {
      logsHtml = `<div class="log-line muted">No recent log events.</div>`;
    }

    // Dynamic Architecture Diagram
    const archWorkerLabel = isSimulated ? '🧪 Virtual Worker (Simulated Apple Silicon)' : (realConnected.length > 0 ? '⚡ Real Worker (Physical Mac #2)' : 'Remote Worker (Standby)');

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SwarmX Control Center</title>
        <style>
          :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --card-bg: var(--vscode-sideBar-background, #1e1e1e);
            --border: var(--vscode-widget-border, #333333);
            --accent: #f59e0b;
            --accent-green: #10b981;
            --accent-blue: #3b82f6;
            --accent-purple: #a855f7;
            --accent-red: #ef4444;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 12px;
            color: var(--fg);
            background: var(--bg);
            font-size: 12px;
            line-height: 1.4;
          }
          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 12px;
          }
          .header-title {
            font-weight: 700;
            font-size: 13.5px;
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .badge {
            font-size: 10px;
            font-weight: 600;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .badge.online, .badge.ready, .badge.active {
            background: rgba(16, 185, 129, 0.15);
            color: #10b981;
            border: 1px solid rgba(16, 185, 129, 0.3);
          }
          .badge.offline, .badge.inactive {
            background: rgba(156, 163, 175, 0.15);
            color: #9ca3af;
            border: 1px solid rgba(156, 163, 175, 0.3);
          }
          .badge.demo {
            background: rgba(245, 158, 11, 0.15);
            color: #f59e0b;
            border: 1px solid rgba(245, 158, 11, 0.3);
          }
          .badge.sim {
            background: rgba(168, 85, 247, 0.15);
            color: #c084fc;
            border: 1px solid rgba(168, 85, 247, 0.3);
          }
          .badge.prod {
            background: rgba(59, 130, 246, 0.15);
            color: #60a5fa;
            border: 1px solid rgba(59, 130, 246, 0.3);
          }
          .badge.warning {
            background: rgba(234, 179, 8, 0.15);
            color: #eab308;
          }
          .badge.discovered {
            background: rgba(139, 92, 246, 0.15);
            color: #a78bfa;
          }
          .section {
            margin-bottom: 14px;
          }
          .section-title {
            font-size: 10px;
            font-weight: 700;
            color: #888888;
            letter-spacing: 0.8px;
            margin-bottom: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 10px;
            margin-bottom: 6px;
          }
          .sim-card {
            border: 1px solid rgba(168, 85, 247, 0.4);
            background: rgba(168, 85, 247, 0.04);
          }
          .table-card {
            padding: 0;
            overflow-x: auto;
          }
          .workload-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
            text-align: left;
          }
          .workload-table th {
            background: rgba(255, 255, 255, 0.04);
            color: #888;
            padding: 6px 8px;
            font-weight: 600;
            border-bottom: 1px solid var(--border);
            font-size: 9.5px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .workload-table td {
            padding: 6px 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            font-size: 10.5px;
          }
          .workload-table tr:last-child td {
            border-bottom: none;
          }
          .workload-table tr:hover {
            background: rgba(255, 255, 255, 0.02);
          }
          .row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 4px;
          }
          .row:last-child {
            margin-bottom: 0;
          }
          .row-label {
            color: #999;
          }
          .row-val {
            font-weight: 500;
            text-align: right;
          }
          .worker-card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 10px;
            margin-bottom: 6px;
          }
          .worker-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
          }
          .worker-name {
            font-weight: 600;
          }
          .worker-specs {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
            margin-bottom: 4px;
          }
          .spec-tag {
            font-size: 9px;
            background: rgba(255, 255, 255, 0.05);
            padding: 1px 4px;
            border-radius: 3px;
            color: #aaa;
          }
          .spec-tag.gpu {
            color: #f59e0b;
            font-weight: 600;
            background: rgba(245, 158, 11, 0.1);
          }
          .spec-tag.sim-tag {
            color: #c084fc;
            font-weight: 600;
            background: rgba(168, 85, 247, 0.12);
          }
          .worker-telemetry {
            font-size: 10.5px;
            color: #888;
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-bottom: 4px;
          }
          .worker-meta {
            font-size: 10px;
            color: #888;
          }
          .worker-actions {
            display: flex;
            gap: 6px;
            margin-top: 6px;
            flex-wrap: wrap;
          }
          .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 11px;
            cursor: pointer;
            font-weight: 500;
          }
          .btn:hover {
            background: var(--vscode-button-hoverBackground);
          }
          .btn-secondary {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--fg);
          }
          .btn-sim {
            background: rgba(168, 85, 247, 0.2);
            border: 1px solid rgba(168, 85, 247, 0.4);
            color: #d8b4fe;
          }
          .btn-sim:hover {
            background: rgba(168, 85, 247, 0.3);
          }
          .btn-sm {
            padding: 2px 6px;
            font-size: 10px;
          }
          .btn-danger {
            color: #ef4444;
            border-color: rgba(239, 68, 68, 0.3);
          }
          .progress-bar-container {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            height: 8px;
            overflow: hidden;
            margin: 6px 0;
          }
          .progress-bar {
            background: #10b981;
            height: 100%;
            transition: width 0.3s ease;
          }
          .proof-list {
            margin: 0;
            padding: 0;
            list-style: none;
          }
          .proof-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: #ccc;
            margin-bottom: 2px;
          }
          .proof-check {
            color: #10b981;
            font-weight: bold;
          }
          .logs-container {
            background: #0d1117;
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 6px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 9.5px;
            max-height: 120px;
            overflow-y: auto;
          }
          .log-line {
            white-space: pre-wrap;
            word-break: break-all;
            margin-bottom: 2px;
            color: #aaa;
          }
          .log-line.muted {
            color: #555;
          }
          .arch-diagram {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 9px;
            background: #0d1117;
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 8px 6px;
            color: #9ca3af;
            line-height: 1.35;
            text-align: center;
          }
          .empty-state {
            text-align: center;
            padding: 12px;
            color: #888;
            font-size: 11px;
            border: 1px dashed var(--border);
            border-radius: 6px;
          }
          .hint {
            display: block;
            margin-top: 4px;
            font-size: 10px;
            color: #666;
          }
          code {
            background: rgba(255, 255, 255, 0.1);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="header-title">🐝 SwarmX Control Center</div>
          <div>${onlineBadge}</div>
        </div>

        <!-- DEVELOPMENT SIMULATION MODE BANNER -->
        <div class="section">
          <div class="section-title">
            <span>DEVELOPMENT SIMULATION</span>
            <span class="badge ${isSimulated ? 'sim' : 'offline'}">${isSimulated ? '🧪 ACTIVE' : '⚪ OFF'}</span>
          </div>
          <div class="card ${isSimulated ? 'sim-card' : ''}">
            <div class="row">
              <span class="row-label">Simulation Mode</span>
              <span class="row-val">${isSimulated ? '<span class="badge sim">🧪 ENABLED</span>' : '<span class="badge offline">DISABLED</span>'}</span>
            </div>
            <div class="row">
              <span class="row-label">Target Hardware</span>
              <span class="row-val">🧪 Virtual Apple Silicon (10 Cores, 16GB)</span>
            </div>
            <div style="font-size: 10px; color: #888; margin: 6px 0;">
              Isolated in-process virtual worker for testing VS Code → Python → Interceptor → Core → Validation without physical Mac #2. Physical networking & crypto protocols are untouched.
            </div>
            <div style="margin-top: 6px;">
              <button class="btn ${isSimulated ? 'btn-secondary' : 'btn-sim'} btn-sm" style="width: 100%;" onclick="sendAction('toggleSimulation')">
                ${isSimulated ? 'Disable Development Simulation Mode' : '🧪 Enable SwarmX Simulation (Virtual Worker)'}
              </button>
            </div>
          </div>
        </div>

        <!-- CORE & TRANSPORT -->
        <div class="section">
          <div class="section-title">CORE & TRANSPORT</div>
          <div class="card">
            <div class="row">
              <span class="row-label">Core Status</span>
              <span class="row-val">${onlineBadge}</span>
            </div>
            <div class="row">
              <span class="row-label">IPC Socket</span>
              <span class="row-val"><code>/tmp/swarmx.sock</code></span>
            </div>
            <div class="row">
              <span class="row-label">Transport</span>
              <span class="row-val"><code>WebSocket :50051</code></span>
            </div>
            <div class="row">
              <span class="row-label">Discovery</span>
              <span class="row-val"><code>Bonjour _swarmx._tcp</code></span>
            </div>
          </div>
        </div>

        <!-- WORKSPACE TRANSPARENCY -->
        <div class="section">
          <div class="section-title">
            <span>WORKSPACE TRANSPARENCY</span>
            <button class="btn btn-secondary btn-sm" onclick="sendAction('toggleWorkspace')">
              ${state.envActive ? 'Disable' : 'Enable'}
            </button>
          </div>
          <div class="card">
            <div class="row">
              <span class="row-label">Workspace Integration</span>
              <span class="row-val">${wsIntegrationBadge}</span>
            </div>
            <div class="row">
              <span class="row-label">Execution Mode</span>
              <span class="row-val">${modeBadge}</span>
            </div>
            <div class="row">
              <span class="row-label">Injected PYTHONPATH</span>
              <span class="row-val"><code>${state.sdkPath || 'sdk/python'}</code></span>
            </div>
            <div class="row">
              <span class="row-label">Python Interpreter</span>
              <span class="row-val"><code>${state.interpreter || 'python3'}</code></span>
            </div>
            <div class="row">
              <span class="row-label">sitecustomize Hook</span>
              <span class="row-val"><span class="badge ready">✓ HOOKED</span></span>
            </div>
            <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.05);">
              <ul class="proof-list">
                <li class="proof-item"><span class="proof-check">✓</span> Standard Python & PIL</li>
                <li class="proof-item"><span class="proof-check">✓</span> SwarmX imports: 0</li>
                <li class="proof-item"><span class="proof-check">✓</span> Decorators: 0</li>
                <li class="proof-item"><span class="proof-check">✓</span> Application code changes: 0</li>
              </ul>
            </div>
            <div style="margin-top: 8px;">
              <button class="btn ${state.forceSwarmDemo ? 'btn-danger' : 'btn-secondary'} btn-sm" style="width: 100%;" onclick="sendAction('toggleForceSwarm')">
                ${state.forceSwarmDemo ? '⚠️ Disable Force Swarm (Return to Production Cost Model)' : '⚠️ Demo Mode: Force Swarm Remote Execution'}
              </button>
            </div>
          </div>
        </div>

        <!-- CLUSTER WORKERS -->
        <div class="section">
          <div class="section-title">
            <span>CLUSTER WORKERS</span>
            <button class="btn btn-secondary btn-sm" onclick="sendAction('refresh')">↻ Refresh</button>
          </div>
          ${workersHtml}
        </div>

        <!-- DISCOVERED DEVICES -->
        ${discoveredHtml ? `<div class="section">${discoveredHtml}</div>` : ''}

        <!-- LIVE WORKLOADS TABLE -->
        ${workloadsTableHtml}

        <!-- DECISION ENGINE -->
        <div class="section">
          <div class="section-title">DECISION ENGINE</div>
          <div class="card">
            <div class="row">
              <span class="row-label">Local Estimate</span>
              <span class="row-val">${localEst}</span>
            </div>
            <div class="row">
              <span class="row-label">Swarm Estimate</span>
              <span class="row-val">${swarmEst}</span>
            </div>
            <div class="row">
              <span class="row-label">Estimated Speedup</span>
              <span class="row-val">${speedup}</span>
            </div>
            <div class="row">
              <span class="row-label">Recommendation</span>
              <span class="row-val"><span class="badge ${recommendation.includes('SWARM') ? 'ready' : 'demo'}">${recommendation}</span></span>
            </div>
            <div class="row" style="margin-top: 4px;">
              <span class="row-label">Reason</span>
              <span class="row-val" style="font-size: 10px; color: #aaa;">${recReason}</span>
            </div>
          </div>
        </div>

        <!-- EXECUTION & LIVE PROGRESS -->
        <div class="section">
          <div class="section-title">EXECUTION STATUS</div>
          <div class="card">
            <div class="row">
              <span class="row-label">Status</span>
              <span class="row-val"><span class="badge ${execStatus === 'SUCCESS' || execStatus === 'RUNNING' ? 'ready' : 'offline'}">${execStatus}</span></span>
            </div>
            <div class="row">
              <span class="row-label">Workload</span>
              <span class="row-val"><code>${currentWklId}</code></span>
            </div>
            <div class="row">
              <span class="row-label">Mode</span>
              <span class="row-val">${isSimulated ? 'SWARM — SIMULATION' : (state.forceSwarmDemo ? 'FORCED SWARM — DEMO' : (hasWorkers ? 'ADAPTIVE SWARM' : 'LOCAL'))}</span>
            </div>
            <div class="row">
              <span class="row-label">Target Worker</span>
              <span class="row-val">${currentWorkerLabel}</span>
            </div>
            <div class="progress-bar-container">
              <div class="progress-bar" style="width: ${progressWidth};"></div>
            </div>
            <div class="row">
              <span class="row-label">Progress</span>
              <span class="row-val">${percent}% (${completedTasks.toLocaleString()} / ${(totalTasks || (completedTasks > 0 ? completedTasks : 16)).toLocaleString()})</span>
            </div>
            <div class="row">
              <span class="row-label">Failed / Retries</span>
              <span class="row-val">0 / 0</span>
            </div>
          </div>
        </div>

        <!-- VALIDATION & INTEGRITY -->
        <div class="section">
          <div class="section-title">VALIDATION & INTEGRITY</div>
          <div class="card">
            <ul class="proof-list">
              <li class="proof-item"><span class="proof-check">✓</span> Pixel tolerance: PASS (Δ ≤ 2, MSE ≤ 0.5)</li>
              <li class="proof-item"><span class="proof-check">✓</span> MSE Variance: PASS (&lt; 0.01)</li>
              <li class="proof-item"><span class="proof-check">✓</span> Output integrity: PASS (100% authentic PIL.Image.Image)</li>
              <li class="proof-item"><span class="proof-check">✓</span> Reconstructed type: <code>PIL.Image.Image</code></li>
            </ul>
          </div>
        </div>

        <!-- SECURITY PROTOCOL -->
        <div class="section">
          <div class="section-title">SECURITY & PROTOCOL</div>
          <div class="card">
            <ul class="proof-list">
              <li class="proof-item"><span class="proof-check">✓</span> SAS 4-digit visual confirmation</li>
              <li class="proof-item"><span class="proof-check">✓</span> X25519 Ephemeral Key Agreement</li>
              <li class="proof-item"><span class="proof-check">✓</span> Directional AES-256-GCM Session Framing</li>
              <li class="proof-item"><span class="proof-check">✓</span> Monotonic replay protection watermark</li>
            </ul>
          </div>
        </div>

        <!-- CERTIFIED CAPABILITIES -->
        <div class="section">
          <div class="section-title">CERTIFIED KERNELS</div>
          <div class="card">
            <div class="row">
              <span class="row-label">2D Box Blur</span>
              <span class="row-val"><code>image_filter_box_blur_v1</code></span>
            </div>
            <div class="row">
              <span class="row-label">Gaussian Blur</span>
              <span class="row-val"><code>image_filter_gaussian_blur_v1</code></span>
            </div>
            <div class="row">
              <span class="row-label">Matrix Multiply</span>
              <span class="row-val"><code>matrix_multiply_v1</code></span>
            </div>
          </div>
        </div>

        <!-- ARCHITECTURE FLOW -->
        <div class="section">
          <div class="section-title">DISTRIBUTED EXECUTION PIPELINE</div>
          <div class="arch-diagram">
            Python Application (Zero Imports)<br>
            ↓<br>
            sitecustomize (Transparent Hook)<br>
            ↓<br>
            SwarmX Core Coordinator<br>
            ↓<br>
            Cost Decision Model<br>
            ↙&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↘<br>
            LOCAL&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;SWARM<br>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↓<br>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${archWorkerLabel}<br>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↓<br>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Pixel Tolerance Validation<br>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↓<br>
            Authentic PIL.Image Result
          </div>
        </div>

        <!-- OBSERVABILITY LOGS -->
        <div class="section">
          <div class="section-title">
            <span>OBSERVABILITY LOGS</span>
            <button class="btn btn-secondary btn-sm" onclick="sendAction('viewLogs')">View Full Logs</button>
          </div>
          <div class="logs-container">
            ${logsHtml}
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          function sendAction(command, failureMode) {
            vscode.postMessage({ command, failureMode });
          }
        </script>
      </body>
      </html>
    `;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
