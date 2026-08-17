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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

/**
 * Raise the alarm with this many hours still on the clock. Deliberately generous: the
 * provider can hang, acknowledgement can fail, and a retry needs room. Discovering the
 * problem at hour 47 leaves no time to fix it.
 */
export const URGENT_THRESHOLD_HOURS = 24;

const HOUR_MS = 3_600_000;

const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(['SEALED', 'FAILED', 'FORFEITED']);

/** Legal transitions. Anything absent is a bug, not a no-op. */
const TRANSITIONS: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  PENDING: { FUND_CONFIRMED: 'FUNDED', ERROR: 'FAILED' },
  FUNDED: { TASK_CREATED: 'SUBMITTED', ERROR: 'FAILED' },
  SUBMITTED: { TRAINING_STARTED: 'TRAINING', ERROR: 'FAILED' },
  TRAINING: { DELIVERY_OBSERVED: 'DELIVERED', ERROR: 'FAILED' },
  DELIVERED: { ACKNOWLEDGED: 'ACKNOWLEDGED', WINDOW_EXPIRED: 'FORFEITED', ERROR: 'FAILED' },
  ACKNOWLEDGED: { DECRYPTED: 'DECRYPTED', ERROR: 'FAILED' },
  DECRYPTED: { SEAL_CONFIRMED: 'SEALED', ERROR: 'FAILED' },
  SEALED: {},
  FAILED: {},
  FORFEITED: {},
};

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

export class IllegalTransitionError extends Error {
  constructor(state: TaskState, event: TaskEvent) {
    super(`illegal transition: ${event} is not valid from ${state}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Pure transition function. Illegal transitions throw rather than silently no-op, so a
 * bug in the polling loop surfaces immediately instead of stalling a paid job.
 */
export function nextState(current: TaskState, event: TaskEvent): TaskState {
  const target = TRANSITIONS[current][event];
  if (!target) throw new IllegalTransitionError(current, event);
  return target;
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

/**
 * Hours remaining before a delivered adapter is forfeited. Negative once the window has
 * closed. Drives the watchdog.
 */
export function hoursUntilForfeit(deliveredAt: number, now: number): number {
  return FORFEIT_WINDOW_HOURS - (now - deliveredAt) / HOUR_MS;
}

/** True when the deliverable is at risk and the watchdog should act now. */
export function needsUrgentAcknowledgement(record: TaskRecord, now: number): boolean {
  if (record.state !== 'DELIVERED' || record.deliveredAt === undefined) return false;
  return hoursUntilForfeit(record.deliveredAt, now) <= URGENT_THRESHOLD_HOURS;
}

export async function loadTaskRecord(path: string): Promise<TaskRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as TaskRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function saveTaskRecord(path: string, record: TaskRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** Applies an event and persists the result — the crash-resumable step. */
export async function transition(
  path: string,
  record: TaskRecord,
  event: TaskEvent,
  patch: Partial<TaskRecord> = {},
): Promise<TaskRecord> {
  const updated: TaskRecord = {
    ...record,
    ...patch,
    state: nextState(record.state, event),
    updatedAt: Date.now(),
  };
  await saveTaskRecord(path, updated);
  return updated;
}
