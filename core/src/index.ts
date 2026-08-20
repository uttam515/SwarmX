import * as path from 'path';
import { createDatabase } from './db/sqlite';
import { runMigrations } from './db/migrations';
import { TaskStore } from './db/task_store';
import { WorkerManager } from './worker_manager';
import { PairingService } from './pairing_service';
import { TransportServer } from './transport_server';
import { IpcServer } from './ipc_server';
import { ScoredScheduler } from './scheduler';
import { WorkloadPipeline } from './workload_pipeline';
import { Logger } from './logger';

async function main() {
  Logger.init(process.env.SWARMX_LOG_PATH || '/tmp/swarmx-core.log');
  console.log('----------------------------------------------------');
  console.log('🚀 Starting SwarmX Core Daemon (Phase 0 Foundations)');
  console.log('----------------------------------------------------');

  const dbPath = process.env.SWARMX_DB_PATH || path.join(process.env.HOME || '.', '.swarmx', 'swarmx.db');
  const socketPath = process.env.SWARMX_IPC_PATH || '/tmp/swarmx.sock';
  const transportPort = parseInt(process.env.SWARMX_PORT || '50051', 10);

  // 1. Initialize SQLite Store & Migrations
  const db = createDatabase(dbPath);
  runMigrations(db);
  const taskStore = new TaskStore(db);

  // 2. Perform Crash Recovery on Startup
  console.log('🔍 Checking for in-flight tasks from prior sessions...');
  const recoveryResult = taskStore.recoverInFlightTasks(3);
  if (recoveryResult.recovered.length > 0 || recoveryResult.failed.length > 0) {
    console.log(`⚠️  Crash Recovery Executed:`);
    console.log(`   - Reset to PENDING: ${recoveryResult.recovered.length} tasks`);
    console.log(`   - Marked as FAILED (Exceeded Retries): ${recoveryResult.failed.length} tasks`);
  } else {
    console.log('✅ No crashed/in-flight tasks detected.');
  }

  // 3. Initialize Worker Manager, Scheduler, Pipeline & Pairing Service
  const workerManager = new WorkerManager();
  const pairingService = new PairingService(db);
  const scheduler = new ScoredScheduler();
  const workloadPipeline = new WorkloadPipeline(taskStore, scheduler);

  // 4. Initialize & Start Transport Server (mDNS + WS/gRPC)
  const transportServer = new TransportServer(
    transportPort,
    pairingService,
    workerManager,
    taskStore,
    workloadPipeline
  );
  await transportServer.start();
  console.log(`📡 Transport Server active on port ${transportPort} (mDNS: _swarmx._tcp)`);

  // 5. Initialize & Start IPC Server (Unix domain socket / pipe)
  const ipcServer = new IpcServer(
    socketPath,
    taskStore,
    workerManager,
    pairingService,
    transportServer,
    workloadPipeline,
    scheduler
  );
  await ipcServer.start();
  console.log(`🔌 IPC Server listening on ${socketPath} (Owner-only 0600 mode)`);
  console.log('✨ SwarmX Core Daemon is ready.');

  // Handle graceful shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\n🛑 Shutting down SwarmX Core...');

    // Safety fallback: Unreferenced 2-second timer ensures process always exits
    const forceExitTimer = setTimeout(() => {
      console.warn('⚠️ Force terminating remaining handles.');
      process.exit(0);
    }, 2000);
    forceExitTimer.unref();

    try {
      await Promise.all([
        ipcServer.stop(),
        transportServer.stop()
      ]);
      db.close();
      Logger.close();
    } catch (err) {
      console.error('Error during shutdown:', err);
    }

    console.log('👋 SwarmX Core Daemon stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error starting SwarmX Core:', err);
    process.exit(1);
  });
}
