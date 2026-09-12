import type { ProjectConstraintContext, ProjectMemoryItem } from '@project-x/types';

const NO_NEW_DEPS_RE =
  /\bno[_ -]?new[_ -]?dependenc(?:y|ies)\b|\bdo\s+not\s+(?:add|introduce)\s+(?:new\s+)?dependenc|\bnever\s+add\s+dependenc|\bwithout\s+(?:asking|approval).{0,40}dependenc|\bdependenc(?:y|ies).{0,40}without\s+(?:asking|approval)\b/i;

/**
 * Build planner constraint context from active memory items.
 * Detects no-new-dependencies from rule text/key.
 */
export function buildProjectConstraintContext(
  items: ProjectMemoryItem[],
): ProjectConstraintContext {
  const rules: { key: string; text: string }[] = [];
  let noNewDependencies = false;

  for (const item of items) {
    if (item.status !== 'active') continue;

    const text = item.value.summary;
    const key = item.key;
    const blob = `${key} ${text}`;

    if (
      item.category === 'PROJECT_CONSTRAINT' ||
      item.category === 'USER_PREFERENCE' ||
      item.category === 'DEPENDENCY_CONVENTION' ||
      item.provenance.some((p) => p.type === 'user_explicit')
    ) {
      rules.push({ key, text });
    }

    if (
      key === 'constraint.no_new_dependencies' ||
      key.includes('no_new_dependencies') ||
      NO_NEW_DEPS_RE.test(blob)
    ) {
      noNewDependencies = true;
    }
  }

  const result: ProjectConstraintContext = { rules };
  if (noNewDependencies) {
    result.noNewDependencies = true;
  }
  return result;
}
