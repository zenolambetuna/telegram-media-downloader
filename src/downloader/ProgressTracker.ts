import { logger } from '../logger/logger';
import { DownloadStage, ProgressListener, ProgressUpdate } from '../types/download';

const STAGE_ORDER: DownloadStage[] = [
  'fetching_metadata',
  'resolving_formats',
  'downloading',
  'merging',
  'processing',
  'uploading',
  'finished',
];

/**
 * ProgressTracker is a reusable, listener-based progress system. The engine
 * pushes stage transitions and download ratios through it. Consumers (the bot,
 * or future Telegram Drive services) subscribe without knowing engine internals.
 */
export class ProgressTracker {
  private readonly listeners = new Set<ProgressListener>();
  private currentStage: DownloadStage = 'fetching_metadata';

  constructor(private readonly jobId: string) {}

  subscribe(listener: ProgressListener): void {
    this.listeners.add(listener);
  }

  setStage(stage: DownloadStage, detail?: string): void {
    this.currentStage = stage;
    this.emit({ stage, detail });
  }

  reportRatio(ratio: number, detail?: string): void {
    this.emit({ stage: this.currentStage, ratio, detail });
  }

  get stage(): DownloadStage {
    return this.currentStage;
  }

  static order(): DownloadStage[] {
    return [...STAGE_ORDER];
  }

  private emit(update: ProgressUpdate): void {
    logger.debug({ jobId: this.jobId, ...update }, 'progress update');
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (error) {
        logger.warn({ jobId: this.jobId, error }, 'progress listener failed');
      }
    }
  }
}
