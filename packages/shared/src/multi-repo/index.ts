export {
  MULTI_REPO_MAX_REPOS_PER_SYSTEM,
  MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
  MULTI_REPO_MAX_FILES_PER_REPO,
  MULTI_REPO_MAX_TOTAL_FILES,
  MULTI_REPO_MAX_RELATIONSHIPS,
  MULTI_REPO_MAX_HTTP_OPS,
  MULTI_REPO_MAX_KAFKA_TOPICS,
  clampReposPerSystem,
  clampReposPerAnalysis,
  clampFilesPerRepo,
  remainingTotalFileBudget,
  isWithinRelationshipBudget,
  isWithinHttpOpsBudget,
  isWithinKafkaTopicBudget,
  truncateToBudget,
} from './budgets';

export {
  normalizeOwnerRepo,
  parseOwnerRepo,
  repositoryKey,
  sameRepository,
  toRepositoryIdentity,
} from './identity';
export type { OwnerRepo } from './identity';

export {
  knownInSelectedScope,
  noOrgWideClaim,
  notEvidentInScope,
  partialScopeUnavailable,
  systemFlowIncomplete,
} from './scope-language';

export { detectHttpProviderPaths, detectHttpConsumerPaths } from './http-detect';
export type { HttpPathEvidence } from './http-detect';

export { detectKafkaTopicUsages } from './kafka-detect';
export type { KafkaTopicEvidence, KafkaUsageRole } from './kafka-detect';

export { parsePackageJsonManifest, findDependencyByName } from './package-detect';
export type {
  ParsedPackageJson,
  ParsedPackageDependency,
  ParsedPackageRepositoryField,
} from './package-detect';

export {
  compareHttpRequiredFieldsAdded,
  compareTopicRename,
  mergeCompatibilityResults,
} from './compatibility';

export {
  emptyAnalysisScope,
  buildChangeImpactSkeleton,
  validateImpactRepositoriesInScope,
  filterImpactAnalysisToScope,
} from './impact';

export { buildSimpleLinearFlow, appendFlowGap } from './flow';

export { computeSystemContextVersion } from './version';

export {
  validateRepositoriesInScope,
  validateAnalysisRepositorySelection,
  assertNoInventedRepositories,
} from './validate';
export type { MultiRepoValidateResult } from './validate';
