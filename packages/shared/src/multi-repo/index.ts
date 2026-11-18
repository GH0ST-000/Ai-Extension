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

export {
  HTTP_METHOD_NAMES,
  PATH_PARAM,
  httpMethodsMatch,
  httpPathsMatch,
  isGenericHttpPath,
  joinHttpPath,
  normalizeHttpMethod,
  normalizeHttpPath,
  parseEndpointSpec,
} from './http-paths';
export type { HttpMethodName } from './http-paths';
export { extractOpenApiOperations, looksLikeOpenApiPath } from './openapi-detect';
export type { OpenApiExtraction, DetectedOpenApiOperation } from './openapi-detect';
export { detectHttpCalls } from './http-calls';
export type { HttpCall } from './http-calls';
export { detectRouteDefinitions } from './route-detect';
export type { RouteDefinition, SourceFile } from './route-detect';
export { SERVICE_MANIFEST_PATH, parseServiceDependencyManifest } from './manifest-detect';
export type { ManifestDependency, ManifestParseResult } from './manifest-detect';
export { planRepositoryScan } from './scan-plan';
export type { ScanPlan, TreeEntry } from './scan-plan';
export { matchHttpDependencies } from './http-match';
export { computeDownstreamImpact, DEFAULT_GRAPH_FRESHNESS_DAYS } from './downstream-impact';
export type { ScopedRelationship } from './downstream-impact';
export type {
  CallSite,
  DeclaredDependency,
  HttpDependencyLink,
  HttpMatchResult,
  MatchedEndpoint,
  ProviderOperation,
  RepoHttpFacts,
} from './http-match';

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
export {
  DOWNSTREAM_IMPACT_HEADING,
  renderDownstreamImpactSection,
} from './downstream-impact-render';
