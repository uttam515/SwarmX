export enum TaskStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  ABANDONED = 'ABANDONED',
  FAILED = 'FAILED'
}

export interface TaskResources {
  minCpuCores?: number;
  minRamMb?: number;
  requiresGpu?: boolean;
  minBatteryLevel?: number; // 0.0 - 1.0 (e.g. 0.20 for 20%)
}

export interface TaskAttempt {
  timestampMs: number;
  workerId?: string;
  previousStatus: TaskStatus;
  reason: string;
  details?: Record<string, any>;
}

export interface Task {
  id: string;
  inputRef: string;
  computationDescriptor: string; // Base64 or stringified descriptor
  requiredResources: TaskResources;
  dependencies: string[]; // Parent task IDs for DAG
  executionConstraints: Record<string, string>;
  resultDestination: string;
  retryCount: number;
  attemptHistory: TaskAttempt[];
  status: TaskStatus;
  assignedWorkerId?: string;
  leaseExpiresAtMs?: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export enum ThermalState {
  NOMINAL = 0,
  FAIR = 1,
  SERIOUS = 2,
  CRITICAL = 3
}

export interface CapabilityProfile {
  capabilitySchemaVersion: number; // Must match CAPABILITY_SCHEMA_VERSION = 1
  deviceId: string;
  deviceName: string;
  osType: 'darwin' | 'windows' | 'linux' | 'ios' | 'android';
  osVersion: string;
  cpuArch: string;
  cpuCores: number;
  totalRamMb: number;
  hasGpu: boolean;
  gpuModel?: string;
  gpuAccelerationType?: string; // e.g. 'Metal', 'DirectML', 'Vulkan', 'CUDA'
  supportedKernels?: string[]; // e.g. ['image_filter_box_blur_v1']
  transferBandwidthBytesPerSec?: number;
}

export const CAPABILITY_SCHEMA_VERSION = 1;

export interface WorkerTelemetry {
  deviceId: string;
  timestampMs: number;
  batteryLevel: number; // 0.0 to 1.0
  isCharging: boolean;
  thermalState: ThermalState;
  cpuUtilization: number; // 0.0 to 1.0
  availableRamMb: number;
  isEligible?: boolean;
}

export interface TrustedWorker {
  deviceId: string;
  deviceName: string;
  publicKey: string; // Hex or base64
  sharedSecretHash: string;
  pairedAtMs: number;
  lastSeenAtMs: number;
}

export interface DiscoveredWorker {
  deviceId: string;
  deviceName: string;
  host: string;
  port: number;
  lastSeenMs: number;
  capabilityProfile?: CapabilityProfile;
}

export interface EncryptedEnvelope {
  sessionId: string;
  sequenceNum: number;
  ivNonce: string; // Base64
  ciphertext: string; // Base64
  authTag: string; // Base64
}

export enum WorkerExecutionStage {
  OFFLINE = 'OFFLINE',
  STARTING = 'STARTING',
  CONNECTING = 'CONNECTING',
  AUTHENTICATING = 'AUTHENTICATING',
  REGISTERING = 'REGISTERING',
  READY = 'READY',
  FETCHING = 'FETCHING',
  DECRYPTING = 'DECRYPTING',
  DECODING = 'DECODING',
  EXECUTING = 'EXECUTING',
  TRANSMITTING = 'TRANSMITTING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING'
}

export interface WorkerPipelineChecklist {
  fetching: boolean;
  decrypting: boolean;
  decoding: boolean;
  executing: boolean;
  transmitting: boolean;
}

export interface WorkerLiveState {
  deviceId: string;
  deviceName: string;
  connectionState: 'CONNECTED' | 'DISCOVERED' | 'PAIRING' | 'OFFLINE';
  stage: WorkerExecutionStage;
  currentTaskId?: string;
  currentChunkIndex?: number;
  totalChunks?: number;
  startFrameIndex?: number;
  frameCount?: number;
  executionTimeMs?: number;
  stageStartTimeMs?: number;
  completedChunks: number;
  failedChunks: number;
  retryCount: number;
  pipelineStages: WorkerPipelineChecklist;
  lastHeartbeatMs: number;
  isEligible: boolean;
  lastCompletedTaskId?: string;
}

export interface SwarmStatus {
  enabled: boolean;
  hostDeviceId: string;
  hostDeviceName: string;
  activeWorkerCount: number;
  eligibleWorkerCount: number;
  totalTasks: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
}

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  details?: Record<string, any>;
}

export interface IResultValidator {
  validate(task: Task, resultData: Buffer | string): Promise<ValidationResult> | ValidationResult;
}

export interface ComputationDescriptor {
  domain: string;
  kernelId: string;
  parameters: Record<string, any>;
}

export interface WorkloadDataSpec {
  itemCount: number;
  totalPayloadBytes: number;
  format: string;
  payloadBase64?: string;
  locator?: {
    type: 'INLINE_BASE64' | 'SHARED_FILE' | 'CONTENT_HASH';
    uri: string;
  };
}

export interface WorkloadConstraints {
  isPure: boolean;
  isIdempotent: boolean;
  toleranceValidator: 'PASS_THROUGH' | 'EXACT_MATCH' | 'IMAGE_PIXEL_DELTA';
  maxDelta?: number;
  maxMse?: number;
  preferredAcceleration?: 'ANY' | 'METAL' | 'CUDA' | 'DIRECTCOMPUTE' | 'CPU';
}

export interface WorkloadDescriptor {
  workloadId: string;
  version: string;
  computation: ComputationDescriptor;
  data: WorkloadDataSpec;
  constraints: WorkloadConstraints;
}

export interface KernelDefinition {
  kernelId: string;
  version: string;
  domain: string;
  description: string;
  inputFormat: string;
  outputFormat: string;
  minBeneficialBytes: number;
  defaultToleranceValidator: string;
  supportedPlatforms: ('darwin' | 'windows' | 'linux' | 'ios' | 'android')[];
  estimatedComplexityFlopsPerByte: number;
}

export type DagStageStatus = 'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface DagStage {
  stageId: string;
  kernelId: string;
  parameters?: Record<string, any>;
  dependencies: string[]; // Parent stage IDs
  inputArtifactRefs: string[];
  outputArtifactRef: string;
  status: DagStageStatus;
  assignedWorkerId?: string;
  attemptNumber: number;
  executionTimeMs?: number;
  error?: string;
}

export interface DagArtifact {
  artifactId: string;
  producingStageId: string;
  sizeBytes: number;
  format: string;
  checksumSha256?: string;
  dataBuffer?: Buffer | string;
  referenceCount: number;
  isCleanedUp: boolean;
  createdAtMs: number;
}

export interface WorkloadDagDescriptor {
  dagId: string;
  version: string;
  stages: DagStage[];
  inputArtifacts: {
    artifactId: string;
    format: string;
    sizeBytes: number;
    dataBuffer?: Buffer | string;
  }[];
  outputArtifactRefs: string[];
}

export interface DagProgress {
  dagId: string;
  totalStages: number;
  completedStages: number;
  runningStages: number;
  pendingStages: number;
  failedStages: number;
  percentComplete: number;
  isCancelled: boolean;
  isCompleted: boolean;
}


