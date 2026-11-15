#!/usr/bin/env python3
"""Writes corpus/pr48-known-fps (exact PR #48 @ 69e1fc4 sources from test/fixtures)."""
import json
import os
import sys

ROOT = sys.argv[1]
FIX = os.path.join(ROOT, 'apps/api/test/fixtures/pr48-69e1fc4')
CDIR = os.path.join(ROOT, 'apps/api/test/benchmark/corpus/pr48-known-fps')
os.makedirs(CDIR, exist_ok=True)


def head(path):
    with open(os.path.join(FIX, path.replace('/', '_') + '.head')) as f:
        return f.read()


def line_of(path, anchor, occurrence=1):
    seen = 0
    for i, l in enumerate(head(path).split('\n')):
        if anchor in l:
            seen += 1
            if seen == occurrence:
                return i + 1
    raise SystemExit(f'anchor not found in {path}: {anchor}')


RESOLVE = 'apps/api/src/workspaces/resolve-workspace-id.ts'
DIFF = 'apps/api/src/ai/pr-review/pull-request-diff.service.ts'
META = 'apps/extension/lib/selection/utils/project-memory-metadata.ts'
HARDEN = 'apps/api/src/project-memory/memory-hardening.spec.ts'
PAGE = 'apps/dashboard/src/app/app/memory/page.tsx'
STORE = 'apps/extension/lib/project-memory/project-memory.store.ts'
CHANGED = [RESOLVE, DIFF, META, HARDEN, PAGE, STORE,
           'apps/extension/lib/selection/store.ts',
           'apps/extension/lib/selection/workflow/workflow.store.ts']


def raw(path, title, category, severity, change, line_start, evidence, explanation, trigger, failure, impact, line_end=None):
    return dict(path=path, lineStart=line_start, lineEnd=line_end or line_start, category=category,
                severity=severity, confidence='medium', title=title, explanation=explanation,
                evidence=evidence, changeType=change, trigger=trigger, failurePath=failure,
                violatedInvariant='', impact=impact, assumptions='', missingContext='')


def answer(verdict, severity, decisive, site='', **extra):
    out = dict(verdict=verdict, severity=severity, reasoning=f'as answered live: {verdict}',
               decisiveCode=decisive, failureSite=site, dependsOnCodeNotShown=False,
               reachableTrigger='', violatedInvariant='', triggerSource='', guardsOnPath=[])
    if verdict == 'confirmed':
        out['reachableTrigger'] = 'A request reaches the code with the claimed input'
        out['violatedInvariant'] = 'The claimed invariant holds'
    out.update(extra)
    return out


cands = [
    (raw(RESOLVE, 'L4: Potential Incorrect Workspace Resolution', 'correctness', 'medium', 'introduced', 42,
         'if (!candidate && peekRequestWorkspaceHeaderInvalid()) {',
         'A malformed X-Workspace-Id header can bypass validation.', 'User sends a malformed X-Workspace-Id header',
         f'{RESOLVE}:42', 'Users may act in the wrong workspace.'),
     answer('confirmed', 'medium',
            'const candidate = explicit ?? peekRequestWorkspaceId();\nif (!candidate && peekRequestWorkspaceHeaderInvalid()) {',
            f'{RESOLVE}:42')),
    (raw(DIFF, 'L5: Potential PR diff fetching failure handling', 'availability', 'medium', 'pre_existing', 105,
         'throw new UnprocessableEntityException({', 'Users may not receive adequate feedback.',
         'Fetching a PR diff with invalid parameters', f'{DIFF}:76', 'Inadequate feedback.'),
     answer('insufficient_context', 'medium', '')),
    (raw(META, 'L5: Incomplete default message for skipped project memory', 'correctness', 'medium', 'introduced', 1,
         "return SKIP_REASON_TEXT[reason] ?? 'Project memory was not applied.';",
         'Lacks handling for unexpected values.', 'Input is an unexpected value.', f'{META}:4',
         'Misleading information.', line_end=36),
     answer('confirmed', 'medium', "return SKIP_REASON_TEXT[reason] ?? 'Project memory was not applied.';",
            f'{META}:{line_of(META, "return SKIP_REASON_TEXT[reason]")}')),
    (raw(HARDEN, 'L5: Ensuring Idempotence for Payment Webhook Handlers', 'correctness', 'medium', 'introduced', 37,
         "const rule = await memory.createRule('owner-1', 'acme', 'payments', {",
         'Payment webhook handlers must be idempotent to avoid duplicate billing.',
         'Duplicate payment webhook event', f'{HARDEN}:37', 'Multiple charges for a single event.'),
     answer('confirmed', 'high', 'never reached', f'{HARDEN}:245')),
    (raw(RESOLVE, 'L6: Possible Inadequate User Membership Checking', 'security', 'medium', 'exposed_existing', 45,
         'if (!membership) {', 'Unclear how errors are managed for non-members.', 'non-active workspace membership',
         f'{RESOLVE}:45', 'Unauthorized access.'),
     answer('refuted', 'low', "if (!membership) {\nthrow workspaceException(")),
    (raw(DIFF, 'L6: Potential Error Handling Gap for GitHub Diff Fetching', 'correctness', 'medium', 'introduced', 168,
         "this.logger.warn({ msg: 'pr_review.diff.unavailable', reason: failure });",
         'Could fall back to empty page-scraped files.', 'GitHub API unavailable', f'{DIFF}:45',
         'Incomplete data.'),
     answer('confirmed', 'medium', "this.logger.warn({ msg: 'pr_review.diff.unavailable', reason: failure });",
            f'{DIFF}:104')),
    (raw(PAGE, 'L6: Potential Management Denial Message Exposure', 'correctness', 'medium', 'introduced', 138,
         'setError(MANAGE_DENIED_MESSAGE);', 'Error handling may fail if roles change mid-session.',
         'Role changes mid-session', f'{PAGE}:360', 'Attempts at unauthorized actions.'),
     answer('confirmed', 'medium', 'setError(MANAGE_DENIED_MESSAGE);', f'{PAGE}:284', dependsOnCodeNotShown=True)),
    (raw(STORE, 'L6: Project Memory Handling May Return Incorrect Results', 'correctness', 'medium', 'introduced', 88,
         'return repo ? `${repo.owner}/${repo.repo}` : null;', 'May return null and fail silently.',
         'AI action that requires project memory', f'{STORE}:88', 'Missing memory context.'),
     answer('confirmed', 'medium', 'return repo ? `${repo.owner}/${repo.repo}` : null;', f'{STORE}:108')),
]

case = dict(
    id='pr48-known-fps', title='PR #48 @ 69e1fc4: known false positives from live reviews #4–#6',
    repository='GH0ST-000/Ai-Extension', pullRequest='48', revision='69e1fc4f3d19', base='94e06797e666',
    clean=True, securityRegression=False, fixtures='pr48-69e1fc4', groups=['clean', 'regression'],
    files=[dict(path=p, physical=None, changed=True, status='modified') for p in CHANGED],
    groundTruth=[],
    groundTruthSource='line-referenced code audit (ground-truth.md): each claim is shown false at the cited lines of the exact PR head',
    projectMemory='- [high] (USER_PREFERENCE) payment-idempotency: All payment webhook handlers must be idempotent. Duplicate webhook events must never cause duplicate billing operations.')
with open(os.path.join(CDIR, 'case.json'), 'w') as f:
    f.write(json.dumps(case, indent=2) + '\n')
responses = dict(
    provenance='scripted',
    note='Candidates and verifier verdicts transcribed from live reviews #4, #5 and #6 (exact quotes were not logged live; decisive code reconstructed from the reported reasons).',
    model='gpt-4o-mini (live runs; responses transcribed, not replayed byte-for-byte)', capturedAt=None,
    runs=[dict(id='baseline', batch=dict(summary='live candidates', findings=[c for c, _ in cands]),
               verify={c['title']: v for c, v in cands})])
with open(os.path.join(CDIR, 'responses.json'), 'w') as f:
    f.write(json.dumps(responses, indent=2) + '\n')
print('pr48 case written:', len(cands), 'candidates')
