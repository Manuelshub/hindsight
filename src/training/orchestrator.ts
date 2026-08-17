/**
 * Fine-tuning orchestration.
 *
 * The platform makes this harder than it looks: there is a single fine-tuning provider
 * network-wide that handles one task at a time, delivery is known to hang, and a delivered
 * adapter is forfeited (along with 30% of fees) if not acknowledged within 48 hours.
 *
 * The orchestrator is therefore a persisted, crash-resumable state machine rather than a
 * straight-line script.
 */
import { NotImplementedError } from '../errors.js';

export type TaskState =
  | 'PENDING'
  | 'FUNDED'
  | 'SUBMITTED'
  | 'TRAINING'
  | 'DELIVERED'
  | 'ACKNOWLEDGED'
  | 'DECRYPTED'
  | 'SEALED'
  | 'FAILED'
  | 'FORFEITED';

export type TaskEvent =
  | 'FUND_CONFIRMED'
  | 'TASK_CREATED'
  | 'TRAINING_STARTED'
  | 'DELIVERY_OBSERVED'
  | 'ACKNOWLEDGED'
  | 'DECRYPTED'
  | 'SEAL_CONFIRMED'
  | 'ERROR'
  | 'WINDOW_EXPIRED';

/** Hours from `Delivered` before the adapter is forfeited. */
export const FORFEIT_WINDOW_HOURS = 48;

export interface TaskRecord {
  generation: number;
  state: TaskState;
  provider: string;
  taskId?: string;
  datasetPath: string;
  datasetRoot?: string;
  adapterPath?: string;
  adapterRoot?: string;
  /** Epoch ms when the task was first observed in `Delivered`. */
  deliveredAt?: number;
  updatedAt: number;
  error?: string;
}

/**
 * Pure transition function. Illegal transitions throw rather than silently no-op, so a
 * bug in the polling loop surfaces immediately instead of stalling a paid job.
 */
export function nextState(_current: TaskState, _event: TaskEvent): TaskState {
  throw new NotImplementedError('nextState');
}

export function isTerminal(_state: TaskState): boolean {
  throw new NotImplementedError('isTerminal');
}

/**
 * Hours remaining before a delivered adapter is forfeited. Negative once the window has
 * closed. Drives the watchdog.
 */
export function hoursUntilForfeit(_deliveredAt: number, _now: number): number {
  throw new NotImplementedError('hoursUntilForfeit');
}

/** True when the deliverable is at risk and the watchdog should act now. */
export function needsUrgentAcknowledgement(_record: TaskRecord, _now: number): boolean {
  throw new NotImplementedError('needsUrgentAcknowledgement');
}

export function loadTaskRecord(_path: string): Promise<TaskRecord | undefined> {
  throw new NotImplementedError('loadTaskRecord');
}

export function saveTaskRecord(_path: string, _record: TaskRecord): Promise<void> {
  throw new NotImplementedError('saveTaskRecord');
}
