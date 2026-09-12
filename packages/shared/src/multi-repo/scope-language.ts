/** Safe, non-overclaiming language for multi-repo analysis UX/copy. */

export function knownInSelectedScope(resourceLabel = 'consumers'): string {
  return `Known ${resourceLabel} in selected repositories.`;
}

export function noOrgWideClaim(): string {
  return 'Analysis is limited to the selected system repositories — not organization-wide.';
}

export function notEvidentInScope(subject = 'Impact'): string {
  return `${subject} is not evident in the analyzed scope.`;
}

export function partialScopeUnavailable(repoLabel: string): string {
  return `${repoLabel} could not be analyzed because repository access is unavailable.`;
}

export function systemFlowIncomplete(): string {
  return 'Project X found part of the flow, but one or more hops are not evident in the selected repositories.';
}
