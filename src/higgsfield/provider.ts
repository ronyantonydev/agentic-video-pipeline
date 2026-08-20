/**
 * Provider interfaces.
 *
 * One contract, two implementations: a fake that costs nothing (Phase 5) and
 * the real REST backend (Phase 6). Everything upstream - the scheduler, the
 * budget guard, the manifest - is written against this interface, so the
 * whole pipeline can be proven before a single credit is spent.
 */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'nsfw';

export type SubmitVideoRequest = {
  modelSlug: string;
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution?: string;
  /** Local path or URL. image2video models require a start image. */
  startImage?: string;
  endImage?: string;
  seed?: number;
  nativeAudio?: boolean;
  settings?: Record<string, unknown>;
};

export type SubmitImageRequest = {
  modelSlug: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: string;
  resolution?: string;
  referenceImages?: string[];
  seed?: number;
  settings?: Record<string, unknown>;
};

export type SubmitAudioRequest = {
  modelSlug: string;
  prompt: string;
  durationSeconds: number;
  settings?: Record<string, unknown>;
};

export type SubmitResult = {
  jobId: string;
  status: JobStatus;
  submittedAt: string;
};

export type PollResult = {
  jobId: string;
  status: JobStatus;
  /** Present once completed. */
  resultUrl?: string;
  /** Credits actually charged. Null until known; failures charge nothing. */
  actualCredits?: number | null;
  error?: string;
  progress?: number;
};

/**
 * A generation backend.
 *
 * Implementations must never enforce budget policy - that belongs to the
 * guard, which runs before submit is ever called.
 */
export interface GenerationProvider {
  readonly name: string;
  /** True when this provider spends real money. */
  readonly isPaid: boolean;

  submitVideo(req: SubmitVideoRequest): Promise<SubmitResult>;
  submitImage(req: SubmitImageRequest): Promise<SubmitResult>;
  submitAudio(req: SubmitAudioRequest): Promise<SubmitResult>;

  poll(jobId: string): Promise<PollResult>;

  /** Download a finished asset to a local path. */
  download(resultUrl: string, destPath: string): Promise<void>;

  /** Current credit balance, when the backend exposes one. */
  balance?(): Promise<number | null>;

  cancel?(jobId: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly jobId?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
