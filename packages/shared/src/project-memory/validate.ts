import type {
  CreateProjectMemoryRuleRequest,
  ProjectMemoryCategory,
  ProjectMemoryScope,
  ProjectMemoryValue,
} from '@project-x/types';
import {
  PROJECT_MEMORY_MAX_SUMMARY_CHARS,
  PROJECT_MEMORY_MAX_VALUE_CHARS,
  ProjectMemoryCategory as Categories,
} from '@project-x/types';

import { isKnownProjectMemoryCategory } from './categories';
import { isUnsafeMemoryRuleText, userExplicitMayStore } from './policy';
import { containsSensitiveMemoryContent } from './secrets';

export type ValidateResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: 'PROJECT_MEMORY_VALIDATION_FAILED' | 'PROJECT_MEMORY_SECRET_DETECTED';
      message: string;
    };

export function normalizeMemoryKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

export function validateMemoryValue(value: unknown): ValidateResult<ProjectMemoryValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'Memory value must be an object with a summary.',
    };
  }

  const record = value as Record<string, unknown>;
  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'Memory value.summary is required.',
    };
  }

  const summary = record.summary.trim();
  if (summary.length > PROJECT_MEMORY_MAX_SUMMARY_CHARS) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: `Memory summary exceeds ${PROJECT_MEMORY_MAX_SUMMARY_CHARS} characters.`,
    };
  }

  if (containsSensitiveMemoryContent(summary)) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_SECRET_DETECTED',
      message: 'This information looks sensitive and cannot be saved to project memory.',
    };
  }

  let details: Record<string, unknown> | undefined;
  if (record.details !== undefined) {
    if (!record.details || typeof record.details !== 'object' || Array.isArray(record.details)) {
      return {
        ok: false,
        code: 'PROJECT_MEMORY_VALIDATION_FAILED',
        message: 'Memory value.details must be a plain object when provided.',
      };
    }
    details = record.details as Record<string, unknown>;
    const detailsJson = JSON.stringify(details);
    if (containsSensitiveMemoryContent(detailsJson)) {
      return {
        ok: false,
        code: 'PROJECT_MEMORY_SECRET_DETECTED',
        message: 'This information looks sensitive and cannot be saved to project memory.',
      };
    }
  }

  const serialized = JSON.stringify({ summary, details });
  if (serialized.length > PROJECT_MEMORY_MAX_VALUE_CHARS) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: `Memory value exceeds ${PROJECT_MEMORY_MAX_VALUE_CHARS} characters.`,
    };
  }

  return {
    ok: true,
    value: details ? { summary, details } : { summary },
  };
}

export function validateScope(scope: unknown): ValidateResult<ProjectMemoryScope> {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'Memory scope must be an object.',
    };
  }

  const record = scope as Record<string, unknown>;
  const type = record.type;

  if (type === 'repository') {
    return { ok: true, value: { type: 'repository' } };
  }
  if (type === 'user-project') {
    return { ok: true, value: { type: 'user-project' } };
  }
  if (type === 'directory') {
    if (typeof record.path !== 'string' || !record.path.trim()) {
      return {
        ok: false,
        code: 'PROJECT_MEMORY_VALIDATION_FAILED',
        message: 'Directory scope requires a path.',
      };
    }
    return { ok: true, value: { type: 'directory', path: record.path.trim() } };
  }
  if (type === 'service') {
    if (typeof record.name !== 'string' || !record.name.trim()) {
      return {
        ok: false,
        code: 'PROJECT_MEMORY_VALIDATION_FAILED',
        message: 'Service scope requires a name.',
      };
    }
    return { ok: true, value: { type: 'service', name: record.name.trim() } };
  }
  if (type === 'file-pattern') {
    if (typeof record.pattern !== 'string' || !record.pattern.trim()) {
      return {
        ok: false,
        code: 'PROJECT_MEMORY_VALIDATION_FAILED',
        message: 'File-pattern scope requires a pattern.',
      };
    }
    return { ok: true, value: { type: 'file-pattern', pattern: record.pattern.trim() } };
  }

  return {
    ok: false,
    code: 'PROJECT_MEMORY_VALIDATION_FAILED',
    message: 'Unknown memory scope type.',
  };
}

export type ValidatedCreateRule = {
  owner: string;
  repository: string;
  category: ProjectMemoryCategory;
  key: string;
  text: string;
  scope: ProjectMemoryScope;
};

export function validateCreateRuleInput(
  input: CreateProjectMemoryRuleRequest,
): ValidateResult<ValidatedCreateRule> {
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  const repository = typeof input.repository === 'string' ? input.repository.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';

  if (!owner || !repository) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'owner and repository are required.',
    };
  }

  if (!text) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'Rule text is required.',
    };
  }

  if (text.length > PROJECT_MEMORY_MAX_SUMMARY_CHARS) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: `Rule text exceeds ${PROJECT_MEMORY_MAX_SUMMARY_CHARS} characters.`,
    };
  }

  if (!isKnownProjectMemoryCategory(input.category)) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'Unknown project memory category.',
    };
  }

  if (containsSensitiveMemoryContent(text)) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_SECRET_DETECTED',
      message: 'This information looks sensitive and cannot be saved to project memory.',
    };
  }

  if (!userExplicitMayStore(text) || isUnsafeMemoryRuleText(text)) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'This rule conflicts with Project X safety policy and cannot be stored.',
    };
  }

  const allowedRuleCategories = new Set<ProjectMemoryCategory>([
    Categories.PROJECT_CONSTRAINT,
    Categories.USER_PREFERENCE,
    Categories.TECHNICAL_DECISION,
    Categories.CODE_CONVENTION,
    Categories.REVIEW_CONVENTION,
    Categories.DEPENDENCY_CONVENTION,
  ]);
  if (!allowedRuleCategories.has(input.category)) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'Category is not allowed for explicit project rules.',
    };
  }

  let scope: ProjectMemoryScope = { type: 'repository' };
  if (input.scope !== undefined) {
    const scopeResult = validateScope(input.scope);
    if (!scopeResult.ok) return scopeResult;
    scope = scopeResult.value;
  }

  const key = normalizeMemoryKey(
    input.key?.trim() ||
      (input.category === Categories.PROJECT_CONSTRAINT
        ? `constraint.${text.slice(0, 40)}`
        : `rule.${text.slice(0, 40)}`),
  );

  if (!key) {
    return {
      ok: false,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
      message: 'Memory key could not be normalized.',
    };
  }

  return {
    ok: true,
    value: {
      owner,
      repository,
      category: input.category,
      key,
      text,
      scope,
    },
  };
}
