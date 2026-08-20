/**
 * Typed errors. HardStop is deliberately distinct: it means "stop spending
 * immediately", and nothing in the codebase may catch-and-continue past it.
 */

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Budget or credit ceiling reached. Architecture section 19.
 * Never swallow this - it is the last line of defence over real money.
 */
export class HardStop extends PipelineError {
  constructor(
    message: string,
    readonly details: {
      spentUSD?: number;
      attemptedUSD?: number;
      maxBudgetUSD?: number;
      creditsRemaining?: number;
    } = {},
  ) {
    super(message, 'HARD_STOP');
  }
}

/** A planning artifact failed Zod validation. Must fire before any paid call. */
export class ValidationError extends PipelineError {
  constructor(
    message: string,
    readonly artifact: string,
    readonly issues: string[] = [],
  ) {
    super(message, 'VALIDATION_ERROR');
  }
}

/** Cost could not be established from any trusted source. Refuse rather than guess. */
export class UnknownCostError extends PipelineError {
  constructor(modelId: string, reason: string) {
    super(
      `Cannot determine cost for "${modelId}": ${reason}. ` +
        `Refusing to spend against an unknown price.`,
      'UNKNOWN_COST',
    );
  }
}

/** Requested capability the chosen model cannot provide (e.g. end-frame support). */
export class CapabilityError extends PipelineError {
  constructor(
    message: string,
    readonly modelId: string,
    readonly capability: string,
  ) {
    super(message, 'CAPABILITY_ERROR');
  }
}

/** A gate is awaiting human approval. Not a failure - the run exits cleanly. */
export class GatePending extends PipelineError {
  constructor(
    readonly gate: string,
    readonly resumeCommand: string,
  ) {
    super(`Gate "${gate}" awaiting approval. Resume with: ${resumeCommand}`, 'GATE_PENDING');
  }
}
