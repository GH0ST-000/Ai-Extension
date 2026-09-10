import type { ErrorCategory } from '@project-x/types';

export type ErrorSignalMatch = {
  signal: string;
  weight: number;
  category?: ErrorCategory;
  technology?: string;
  errorCode?: string;
};

/**
 * Small focused patterns — scored individually, never one mega-regex.
 */
export const ERROR_SIGNAL_PATTERNS: readonly {
  id: string;
  pattern: RegExp;
  weight: number;
  category?: ErrorCategory;
  technology?: string;
  /** When true, capture group 1 becomes errorCode if present. */
  codeGroup?: number;
  errorCode?: string;
}[] = [
  {
    id: 'js-runtime',
    pattern: /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)\b/,
    weight: 0.42,
    category: 'runtime',
    technology: 'javascript',
    codeGroup: 1,
  },
  {
    id: 'unhandled-rejection',
    pattern: /\bUnhandledPromiseRejection\b|\bunhandledrejection\b/i,
    weight: 0.4,
    category: 'runtime',
    technology: 'javascript',
  },
  {
    id: 'cannot-read',
    pattern: /\bCannot read propert(y|ies)\b/i,
    weight: 0.38,
    category: 'runtime',
    technology: 'javascript',
  },
  {
    id: 'not-a-function',
    pattern: /\bis not (a function|defined)\b/i,
    weight: 0.35,
    category: 'runtime',
    technology: 'javascript',
  },
  {
    id: 'undefined-function',
    pattern: /\bundefined is not (a function|an object)\b/i,
    weight: 0.38,
    category: 'runtime',
    technology: 'javascript',
  },
  {
    id: 'ts-diagnostic',
    pattern: /\b(TS\d{4})\b/,
    weight: 0.48,
    category: 'type',
    technology: 'typescript',
    codeGroup: 1,
  },
  {
    id: 'node-network',
    pattern: /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EADDRINUSE|EPIPE)\b/,
    weight: 0.45,
    category: 'network',
    technology: 'node',
    codeGroup: 1,
  },
  {
    id: 'module-not-found',
    pattern: /\b(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b/,
    weight: 0.45,
    category: 'dependency',
    technology: 'node',
    codeGroup: 1,
  },
  {
    id: 'prisma',
    pattern:
      /\b(PrismaClientKnownRequestError|PrismaClientValidationError|PrismaClientInitializationError|PrismaClientRustPanicError)\b/,
    weight: 0.48,
    category: 'database',
    technology: 'prisma',
    codeGroup: 1,
  },
  {
    id: 'prisma-constraint',
    pattern: /\bunique constraint\b|\bforeign key constraint\b|\bP\d{4}\b/i,
    weight: 0.35,
    category: 'database',
    technology: 'prisma',
  },
  {
    id: 'nest-di',
    pattern: /\bNest can't resolve dependencies\b|\bNestJS\b.+\bdependenc/i,
    weight: 0.42,
    category: 'framework',
    technology: 'nestjs',
  },
  {
    id: 'react-runtime',
    pattern: /\bMinified React error\b|\bReactDOM\b.+\berror\b|\binvariant=|react-dom/i,
    weight: 0.35,
    category: 'framework',
    technology: 'react',
  },
  {
    id: 'nextjs',
    pattern: /\bNext\.js\b.+\b(error|failed)\b|\bNEXT_NOT_FOUND\b/i,
    weight: 0.35,
    category: 'framework',
    technology: 'nextjs',
  },
  {
    id: 'npm-err',
    pattern: /\bnpm ERR!\b|\bpnpm ERR!\b|\byarn error\b/i,
    weight: 0.4,
    category: 'build',
    technology: 'npm',
  },
  {
    id: 'module-resolve',
    pattern: /\bModule not found\b|\bCan't resolve\b|\bCannot resolve\b|\bfailed to resolve\b/i,
    weight: 0.48,
    category: 'dependency',
  },
  {
    id: 'build-failed',
    pattern: /\bBuild failed\b|\bCompilation failed\b|\bFailed to compile\b/i,
    weight: 0.45,
    category: 'build',
  },
  {
    id: 'java-exception',
    pattern: /\b(\w*(Exception|Error))\b/,
    weight: 0.2,
    category: 'runtime',
  },
  {
    id: 'uncaught',
    pattern: /\bUncaught\b/i,
    weight: 0.28,
    category: 'runtime',
  },
  {
    id: 'stack-frame',
    pattern: /^\s*at\s+\S+/m,
    weight: 0.28,
    category: 'runtime',
  },
  {
    id: 'file-line-col',
    pattern: /[/\\][\w.-]+\.\w+:\d+:\d+/,
    weight: 0.22,
    category: 'runtime',
  },
  {
    id: 'traceback',
    pattern: /\btraceback\b \(most recent call last\)/i,
    weight: 0.4,
    category: 'runtime',
    technology: 'python',
  },
  {
    id: 'panic',
    pattern: /\bpanic:/i,
    weight: 0.35,
    category: 'runtime',
    technology: 'go',
  },
  {
    id: 'http-status-line',
    pattern: /\b(HTTP\/\d(?:\.\d)?)\s+([45]\d{2})\b|\bstatus(?:\s+code)?\s*[:=]?\s*([45]\d{2})\b/i,
    weight: 0.32,
    category: 'http',
  },
  {
    id: 'connection-refused',
    pattern: /\bconnection refused\b/i,
    weight: 0.32,
    category: 'network',
  },
  {
    id: 'timeout-word',
    pattern: /\b(ETIMEDOUT|timed?\s*out|timeout)\b/i,
    weight: 0.18,
    category: 'network',
  },
];

/** Bare HTTP codes — only count with technical neighbors. */
export const HTTP_STATUS_CODES = new Set([
  '400',
  '401',
  '403',
  '404',
  '409',
  '422',
  '429',
  '500',
  '502',
  '503',
  '504',
]);

export const TECHNICAL_HTTP_CONTEXT =
  /\b(http|https|status|response|request|api|endpoint|fetch|axios|nginx|server|client|GET|POST|PUT|PATCH|DELETE)\b/i;
