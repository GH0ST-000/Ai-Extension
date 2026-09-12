import type {
  ExecutionHealthBand,
  ExecutionHealthSignals,
  WorkflowHealthScore,
} from '@project-x/types';

/**
 * Deterministic health scoring from execution signals.
 * Score is 0–100; higher is healthier.
 */
export function computeWorkflowHealthScore(signals: ExecutionHealthSignals): WorkflowHealthScore {
  let score = 100;

  score -= Math.min(40, signals.failedStages * 15);
  score -= Math.min(20, signals.retries * 5);
  score -= Math.min(15, signals.warnings * 3);
  score -= Math.min(15, signals.partialFailures * 5);
  score -= Math.min(20, signals.staleArtifacts * 10);
  score -= Math.min(15, signals.timeouts * 8);
  score -= Math.min(10, signals.cancelled ? 10 : 0);

  if (signals.completedStages > 0 && signals.failedStages === 0 && !signals.cancelled) {
    score = Math.min(100, score + Math.min(5, signals.completedStages));
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    band: healthBandForScore(score),
    signals,
  };
}

export function healthBandForScore(score: number): ExecutionHealthBand {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 55) return 'Warning';
  if (score >= 30) return 'Poor';
  return 'Critical';
}

export function emptyHealthSignals(): ExecutionHealthSignals {
  return {
    completedStages: 0,
    failedStages: 0,
    retries: 0,
    warnings: 0,
    partialFailures: 0,
    staleArtifacts: 0,
    timeouts: 0,
    cancelled: false,
  };
}
