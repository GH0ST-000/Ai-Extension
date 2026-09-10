/** Boundary-aware Jira key matcher — rejects bare numbers like "321". */
const ISSUE_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/gi;

export function findJiraIssueKeysInText(text: string): string[] {
  if (!text) {
    return [];
  }
  const seen = new Set<string>();
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(ISSUE_KEY.source, 'gi');
  while ((match = re.exec(text)) !== null) {
    const key = (match[1] ?? '').toUpperCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export type JiraLinkSignal = {
  title?: string;
  body?: string;
  headBranch?: string;
};

export function detectJiraKeysInPrSignals(signals: JiraLinkSignal): Array<{
  issueKey: string;
  source: 'pr-title' | 'pr-body' | 'branch-name';
  confidence: 'high' | 'medium';
}> {
  const results: Array<{
    issueKey: string;
    source: 'pr-title' | 'pr-body' | 'branch-name';
    confidence: 'high' | 'medium';
  }> = [];
  const seen = new Set<string>();

  const push = (
    keys: string[],
    source: 'pr-title' | 'pr-body' | 'branch-name',
    confidence: 'high' | 'medium',
  ) => {
    for (const issueKey of keys) {
      if (seen.has(issueKey)) {
        continue;
      }
      seen.add(issueKey);
      results.push({ issueKey, source, confidence });
    }
  };

  push(findJiraIssueKeysInText(signals.title ?? ''), 'pr-title', 'high');
  push(findJiraIssueKeysInText(signals.headBranch ?? ''), 'branch-name', 'high');
  push(findJiraIssueKeysInText(signals.body ?? ''), 'pr-body', 'medium');
  return results;
}
