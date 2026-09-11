import type {
  AgentDesiredOutcome,
  AgentGoalConstraint,
  DeveloperAgentGoal,
} from '@project-x/types';
import { WORKFLOW_MAX_GOAL_CHARS } from '@project-x/types';

const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const PR_NUMBER_RE = /\b(?:PR\s*#?|#)(\d+)\b/i;

const UNSUPPORTED_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bmerge\b/i, label: 'merge the PR' },
  { pattern: /\bforce[- ]?push\b/i, label: 'force push' },
  { pattern: /\bdeploy\b/i, label: 'deploy' },
  { pattern: /\bshell\b|\bterminal\b|\brm\s+-rf\b/i, label: 'shell execution' },
  {
    pattern: /\brerun\b.*\bci\b|\bci\b.*\brerun\b|\bre-?run\s+(?:the\s+)?(?:checks?|workflows?)/i,
    label: 'CI re-run',
  },
  {
    pattern: /\bupdate\s+jira\b|\bjira\s+(?:comment|transition|assign|edit|write)\b/i,
    label: 'Jira write',
  },
  {
    pattern: /\bskip\s+confirmation\b|\bno[_ ]?confirmation\b|\bwithout\s+confirmation\b/i,
    label: 'bypass write confirmation',
  },
];

export type NormalizeAgentGoalInput = {
  text: string;
  trustedScope?: {
    jiraIssue?: string;
    repository?: string;
    pullRequestNumber?: number;
    apiOperation?: string;
    ciCheck?: string;
  };
  createdAt?: string;
  id?: string;
};

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `goal-${crypto.randomUUID()}`;
  }
  return `goal-${Date.now()}`;
}

function detectDesiredOutcome(
  text: string,
  constraints: AgentGoalConstraint[],
): AgentDesiredOutcome {
  const lower = text.toLowerCase();
  const noApply = constraints.some((c) => c.type === 'NO_PATCH_APPLY' || c.type === 'NO_WRITE');

  if (
    /\bverif(?:y|ication)\b|\bci\s+passes?\b|\bcheck\s+(?:that\s+)?(?:it\s+)?passes?\b/i.test(text)
  ) {
    if (/\bfix\b|\bpatch\b|\bcommit\b/i.test(text)) {
      return noApply ? 'PREPARE_FIX' : 'APPLY_FIX';
    }
    return 'VERIFY';
  }

  if (
    /\bprepare\s+(?:a\s+)?(?:fix|patch)\b|\bdon'?t\s+apply\b|\bdo\s+not\s+apply\b|\bwithout\s+(?:applying|committing)\b/i.test(
      text,
    )
  ) {
    return 'PREPARE_FIX';
  }

  if (
    /\bapply\b|\bcommit\b|\bfix\s+(?:it|this|the|ci|failure)\b/i.test(text) &&
    /\bfix\b|\bpatch\b/i.test(text)
  ) {
    return noApply ? 'PREPARE_FIX' : 'APPLY_FIX';
  }

  if (/\bfix\b|\bpatch\b/i.test(lower) && !noApply) {
    return 'APPLY_FIX';
  }

  if (/\bfix\b|\bpatch\b/i.test(lower) && noApply) {
    return 'PREPARE_FIX';
  }

  if (/\bprepare\s+(?:a\s+)?review\b|\breview\s+draft\b|\bready\s+for\s+review\b/i.test(text)) {
    return 'PREPARE_REVIEW';
  }

  if (/\breview\b/i.test(lower)) {
    return 'REVIEW';
  }

  if (
    /\balign\b|\bimplement(?:ed|s|ation)?\b|\bcover(?:s|ed|age)?\b|\bdoes\s+this\s+pr\b|\bwhether\b.*\bimplement/i.test(
      text,
    )
  ) {
    return 'ASSESS';
  }

  if (/\bexplain\b|\bunderstand\b|\bwhy\b|\bwhat\s+failed\b/i.test(text)) {
    return 'UNDERSTAND';
  }

  return 'CUSTOM_ALLOWED_GOAL';
}

function extractConstraints(text: string): AgentGoalConstraint[] {
  const constraints: AgentGoalConstraint[] = [];

  if (
    /\bdon'?t\s+create\s+a\s+commit\b|\bno\s+commit\b|\bdo\s+not\s+commit\b|\bdon'?t\s+apply\b|\bdo\s+not\s+apply\b|\bprepare\s+(?:a\s+)?fix\s+but\b|\bwithout\s+committing\b/i.test(
      text,
    )
  ) {
    constraints.push({ type: 'NO_PATCH_APPLY' });
  }

  if (
    /\bno\s+writes?\b|\bread[- ]?only\b|\bdon'?t\s+modify\b.*\brepo\b|\bdo\s+not\s+write\b/i.test(
      text,
    )
  ) {
    constraints.push({ type: 'NO_WRITE' });
  }

  if (
    /\bdon'?t\s+submit\b|\bdo\s+not\s+submit\b|\bprepare\s+(?:a\s+)?review\s+but\b|\bno\s+review\s+submission\b/i.test(
      text,
    )
  ) {
    constraints.push({ type: 'NO_REVIEW_SUBMISSION' });
  }

  if (
    /\bdo\s+not\s+modify\s+(?:the\s+)?api\s+contract\b|\bdon'?t\s+modify\s+(?:the\s+)?api\b/i.test(
      text,
    )
  ) {
    constraints.push({ type: 'FOCUS', value: 'do not modify API contract' });
  }

  if (
    /\bonly\s+review\s+backend\b|\bbackend\s+changes?\s+only\b|\bfocus\s+on\s+backend\b/i.test(text)
  ) {
    constraints.push({ type: 'FOCUS', value: 'backend changes only' });
  }

  if (/\bfocus\s+on\s+security\b|\bsecurity\s+only\b/i.test(text)) {
    constraints.push({ type: 'FOCUS', value: 'security' });
  }

  if (
    /\bonly\s+fix\s+(?:critical|high)\b|\b(?:critical|high)\s+(?:issues?|findings?)\s+only\b|\bfix\s+critical(?:\s+only)?\b|\bcritical\s+only\b/i.test(
      text,
    )
  ) {
    constraints.push({ type: 'SEVERITY_SCOPE', severities: ['high'] });
  }

  // Strip any attempt to disable confirmation — never emit such a constraint.
  return constraints.filter((c) => {
    if (c.type === 'FOCUS' && /no[_ ]?confirmation|skip confirmation/i.test(c.value)) {
      return false;
    }
    return true;
  });
}

function extractUnsupported(text: string): string[] {
  const found: string[] = [];
  for (const entry of UNSUPPORTED_PATTERNS) {
    if (entry.pattern.test(text)) {
      found.push(entry.label);
    }
  }
  return found;
}

function extractIssueKeys(text: string): string[] {
  const keys: string[] = [];
  const re = new RegExp(ISSUE_KEY_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1] && !keys.includes(match[1])) {
      keys.push(match[1]);
    }
  }
  return keys;
}

/**
 * Deterministic goal normalization for planning.
 * Trusted provider identities still come from application context — scope hints are not authority.
 */
export function normalizeAgentGoal(input: NormalizeAgentGoalInput): DeveloperAgentGoal {
  const originalText = input.text.trim().slice(0, WORKFLOW_MAX_GOAL_CHARS);
  const constraints = extractConstraints(originalText);
  const unsupportedRequests = extractUnsupported(originalText);
  const desiredOutcome = detectDesiredOutcome(originalText, constraints);
  const mentionedIssues = extractIssueKeys(originalText);
  const prMatch = originalText.match(PR_NUMBER_RE);

  const scope = {
    ...(input.trustedScope?.jiraIssue
      ? { jiraIssue: input.trustedScope.jiraIssue }
      : mentionedIssues.length === 1
        ? { jiraIssue: mentionedIssues[0] }
        : {}),
    ...(input.trustedScope?.repository ? { repository: input.trustedScope.repository } : {}),
    ...(input.trustedScope?.pullRequestNumber !== undefined
      ? { pullRequestNumber: input.trustedScope.pullRequestNumber }
      : prMatch?.[1]
        ? { pullRequestNumber: Number(prMatch[1]) }
        : {}),
    ...(input.trustedScope?.apiOperation ? { apiOperation: input.trustedScope.apiOperation } : {}),
    ...(input.trustedScope?.ciCheck ? { ciCheck: input.trustedScope.ciCheck } : {}),
  };

  const objective =
    desiredOutcome === 'UNDERSTAND'
      ? 'Explain the current situation using trusted context'
      : desiredOutcome === 'ASSESS'
        ? 'Assess whether requirements are implemented'
        : desiredOutcome === 'REVIEW'
          ? 'Review the pull request'
          : desiredOutcome === 'PREPARE_FIX'
            ? 'Prepare a fix without applying it'
            : desiredOutcome === 'APPLY_FIX'
              ? 'Fix the issue with explicit write confirmation'
              : desiredOutcome === 'VERIFY'
                ? 'Verify the target check or outcome'
                : desiredOutcome === 'PREPARE_REVIEW'
                  ? 'Prepare a review draft'
                  : originalText.slice(0, 160) || 'Complete the allowed developer goal';

  return {
    id: input.id ?? createId(),
    originalText,
    normalizedIntent: {
      objective,
      scope,
      desiredOutcome,
      constraints,
    },
    unsupportedRequests,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function goalMentionsMultipleJiraIssues(text: string): string[] {
  return extractIssueKeys(text);
}

export function constraintsForbidWrites(constraints: AgentGoalConstraint[]): boolean {
  return constraints.some((c) => c.type === 'NO_WRITE' || c.type === 'NO_PATCH_APPLY');
}

export function constraintsForbidReviewSubmission(constraints: AgentGoalConstraint[]): boolean {
  return constraints.some((c) => c.type === 'NO_WRITE' || c.type === 'NO_REVIEW_SUBMISSION');
}

export function constraintsForbidPatchApply(constraints: AgentGoalConstraint[]): boolean {
  return constraints.some((c) => c.type === 'NO_WRITE' || c.type === 'NO_PATCH_APPLY');
}

/** Safety: user constraints can only restrict, never disable confirmation. */
export function isUnsafeConstraintAttempt(text: string): boolean {
  return /\bskip\s+confirmation\b|\bno[_ ]?confirmation\b|\bwithout\s+confirmation\b|\bauto[- ]?approve\b|\bauto[- ]?merge\b/i.test(
    text,
  );
}
