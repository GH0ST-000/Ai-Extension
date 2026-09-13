import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CATALOG,
  PROMPT_INJECTION_FIXTURES,
  PROMPT_INJECTION_GUARD,
  assertCapabilityAllowed,
  getCapability,
  isKnownWorkflowStepType,
} from '@project-x/shared';
import { AIAction } from '@project-x/types';

import { BASE_RULES, buildUserContent } from '../ai/prompts/prompt.utils';

describe('Day 29 prompt-injection defenses', () => {
  it('embeds injection guard in base rules and user content', () => {
    expect(BASE_RULES).toContain('budget');
    expect(BASE_RULES).toContain('Never change');
    const content = buildUserContent(
      {
        action: AIAction.EXPLAIN,
        text: PROMPT_INJECTION_FIXTURES[0]!,
      },
      'Explain the selection.',
    );
    expect(content).toContain(PROMPT_INJECTION_GUARD);
    for (const fixture of PROMPT_INJECTION_FIXTURES) {
      expect(typeof fixture).toBe('string');
      expect(fixture.length).toBeGreaterThan(5);
    }
  });

  it('keeps injection fixtures as data only in wrapped selection', () => {
    const malicious = PROMPT_INJECTION_FIXTURES.find((f) => f.includes('APPROVE'))!;
    const content = buildUserContent(
      { action: AIAction.EXPLAIN, text: malicious },
      'Explain the selection.',
    );
    expect(content).toContain(malicious);
    expect(content).toContain('<<SEL>>');
    expect(content).toContain(PROMPT_INJECTION_GUARD);
  });
});

describe('Day 29 workflow capability allowlist', () => {
  it('rejects unknown capabilities', () => {
    expect(isKnownWorkflowStepType('MERGE_PR')).toBe(false);
    expect(isKnownWorkflowStepType('DELETE_BRANCH')).toBe(false);
    expect(isKnownWorkflowStepType('RUN_SHELL')).toBe(false);
    expect(isKnownWorkflowStepType('DEPLOY_PRODUCTION')).toBe(false);
    expect(() => assertCapabilityAllowed('MERGE_PR')).toThrow();
  });

  it('registers only explicit catalog capabilities', () => {
    const ids = Object.keys(CAPABILITY_CATALOG);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(getCapability(id as never)).toBeDefined();
      expect(id).not.toMatch(/SHELL|MERGE_PR|DEPLOY|DELETE_BRANCH/i);
    }
  });
});
