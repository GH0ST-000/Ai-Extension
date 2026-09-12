export {
  MULTI_REPO_MAX_REPOS_PER_SYSTEM,
  MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
  MULTI_REPO_MAX_FILES_PER_REPO,
  MULTI_REPO_MAX_TOTAL_FILES,
  MULTI_REPO_MAX_RELATIONSHIPS,
  MULTI_REPO_MAX_HTTP_OPS,
  MULTI_REPO_MAX_KAFKA_TOPICS,
} from '@project-x/types';

import {
  MULTI_REPO_MAX_FILES_PER_REPO,
  MULTI_REPO_MAX_HTTP_OPS,
  MULTI_REPO_MAX_KAFKA_TOPICS,
  MULTI_REPO_MAX_RELATIONSHIPS,
  MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
  MULTI_REPO_MAX_REPOS_PER_SYSTEM,
  MULTI_REPO_MAX_TOTAL_FILES,
} from '@project-x/types';

export function clampReposPerSystem(count: number): number {
  return Math.min(Math.max(0, count), MULTI_REPO_MAX_REPOS_PER_SYSTEM);
}

export function clampReposPerAnalysis(count: number): number {
  return Math.min(Math.max(0, count), MULTI_REPO_MAX_REPOS_PER_ANALYSIS);
}

export function clampFilesPerRepo(count: number): number {
  return Math.min(Math.max(0, count), MULTI_REPO_MAX_FILES_PER_REPO);
}

export function remainingTotalFileBudget(used: number): number {
  return Math.max(0, MULTI_REPO_MAX_TOTAL_FILES - Math.max(0, used));
}

export function isWithinRelationshipBudget(count: number): boolean {
  return count <= MULTI_REPO_MAX_RELATIONSHIPS;
}

export function isWithinHttpOpsBudget(count: number): boolean {
  return count <= MULTI_REPO_MAX_HTTP_OPS;
}

export function isWithinKafkaTopicBudget(count: number): boolean {
  return count <= MULTI_REPO_MAX_KAFKA_TOPICS;
}

export function truncateToBudget<T>(items: T[], max: number): { items: T[]; truncated: boolean } {
  if (items.length <= max) {
    return { items, truncated: false };
  }
  return { items: items.slice(0, max), truncated: true };
}
