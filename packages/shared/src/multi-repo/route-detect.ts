import type { RelationshipConfidence } from '@project-x/types';

import { joinHttpPath, normalizeHttpMethod, type HttpMethodName } from './http-paths';

/**
 * HTTP routes a repository serves, from Express-style apps / routers and NestJS controllers.
 * Works across the files of one repository so `app.use('/api/users', usersRouter)` in one file
 * prefixes `router.get('/:id')` in another. Static text analysis only.
 */

export interface RouteDefinition {
  method?: HttpMethodName;
  /** Normalized full path. */
  path: string;
  filePath: string;
  line: number;
  framework: 'express' | 'nest';
  confidence: RelationshipConfidence;
  summary: string;
}

export interface SourceFile {
  path: string;
  content: string;
}

const METHOD_GROUP = '(get|post|put|patch|delete|head|options|all)';
const MAX_ROUTES = 200;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

const lineAt = (src: string, index: number) => src.slice(0, index).split('\n').length;

interface FileFacts {
  file: SourceFile;
  appIdents: Set<string>;
  routerIdents: Set<string>;
  /** local import name → module specifier */
  imports: Map<string, string>;
  routes: Array<{ ident: string; method?: HttpMethodName; path: string; line: number }>;
  /** HTTP client instances (`axios.create()`), never servers. */
  clientIdents: Set<string>;
  /** mounter ident, prefix, and either a local ident or a module specifier */
  mounts: Array<{ mounter: string; prefix: string; target?: string; module?: string }>;
}

function collectFacts(file: SourceFile): FileFacts {
  const src = file.content;
  const facts: FileFacts = {
    file,
    appIdents: new Set(),
    routerIdents: new Set(),
    imports: new Map(),
    routes: [],
    mounts: [],
    clientIdents: new Set(),
  };
  const clientRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>]+\s*)?=\s*(?:axios|ky|got)\s*\.\s*(?:create|extend)\s*\(/g;
  let c: RegExpExecArray | null;
  while ((c = clientRe.exec(src)) !== null) facts.clientIdents.add(c[1]!);
  let m: RegExpExecArray | null;

  const appRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>]+\s*)?=\s*(?:express|fastify|Fastify|polka)\s*\(/g;
  while ((m = appRe.exec(src)) !== null) facts.appIdents.add(m[1]!);
  const routerRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>]+\s*)?=\s*(?:new\s+)?(?:express\s*\.\s*)?Router\s*\(/g;
  while ((m = routerRe.exec(src)) !== null) facts.routerIdents.add(m[1]!);

  const importRe =
    /\bimport\s+(?:([A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:\{([^}]*)\}\s*|\*\s+as\s+([A-Za-z_$][\w$]*)\s*)?from\s*['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(src)) !== null) {
    const spec = m[4]!;
    if (m[1]) facts.imports.set(m[1], spec);
    if (m[3]) facts.imports.set(m[3], spec);
    for (const named of (m[2] ?? '').split(',')) {
      // `a` or `a as b` → the local name (token split: no backtracking on long whitespace).
      const tokens = named.trim().split(/\s+/);
      const local = tokens.length === 3 && tokens[1] === 'as' ? tokens[2] : tokens[0];
      if (local) facts.imports.set(local, spec);
    }
  }
  const requireRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(src)) !== null) facts.imports.set(m[1]!, m[2]!);

  const routeRe = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*${METHOD_GROUP}\\s*\\(\\s*(['"\`])(\\/[^'"\`]*)\\3`,
    'g',
  );
  while ((m = routeRe.exec(src)) !== null) {
    facts.routes.push({
      ident: m[1]!,
      method: m[2] === 'all' ? undefined : normalizeHttpMethod(m[2]),
      path: m[4]!,
      line: lineAt(src, m.index),
    });
  }
  // router.route('/x').get(...).post(...)
  const chainRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*(['"`])(\/[^'"`]*)\2\s*\)/g;
  while ((m = chainRe.exec(src)) !== null) {
    const tail = src.slice(chainRe.lastIndex, chainRe.lastIndex + 600).split(/;\s*(?:\n|$)/)[0]!;
    for (const call of tail.matchAll(new RegExp(`\\.\\s*${METHOD_GROUP}\\s*\\(`, 'g'))) {
      facts.routes.push({
        ident: m[1]!,
        method: call[1] === 'all' ? undefined : normalizeHttpMethod(call[1]),
        path: m[3]!,
        line: lineAt(src, m.index),
      });
    }
  }

  // app.use('/prefix', [middleware, ...] router | require('./x'))
  const mountRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*(['"`])(\/[^'"`]*)\2\s*,/g;
  while ((m = mountRe.exec(src)) !== null) {
    const rest = src.slice(mountRe.lastIndex, mountRe.lastIndex + 300);
    const req = rest.match(/^\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (req) {
      facts.mounts.push({ mounter: m[1]!, prefix: m[3]!, module: req[1]! });
      continue;
    }
    const args = mountArguments(rest);
    const last = args[args.length - 1] ?? '';
    // `router` or a router factory call `createUsersRouter()` (resolved through its import).
    const target = last.match(/^([A-Za-z_$][\w$]*)(?:\s*\([^()]*\))?$/);
    if (target) facts.mounts.push({ mounter: m[1]!, prefix: m[3]!, target: target[1]! });
  }
  return facts;
}

/** Top-level arguments up to the `)` closing `app.use(` (strings and brackets respected). */
function mountArguments(rest: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of rest) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Resolve a relative module specifier to one of the known file paths. */
function resolveModule(fromFile: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = `${dirname(fromFile)}/${spec}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const base = out.join('/').replace(/\.(js|mjs|cjs)$/, '');
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'].map((e) => base + e),
    ...['/index.ts', '/index.js', '/index.mjs'].map((e) => base + e),
  ];
  return candidates.find((c) => known.has(c)) ?? null;
}

const LIKELY_APP = /^(app|server|application)$/;
const LIKELY_ROUTER = /^(router|routes?|\w+Router|\w+Routes)$/;

function detectExpressRoutes(files: SourceFile[]): RouteDefinition[] {
  const facts = files.filter((f) => SOURCE_EXT.test(f.path)).map(collectFacts);
  const known = new Set(facts.map((f) => f.file.path));

  const mountsByFile = facts.flatMap((f) => f.mounts.map((mount) => ({ facts: f, mount })));

  // Resolve mount chains (router mounted in a router mounted in the app), bounded depth.
  const prefixOf = (file: string, ident: string, depth: number): string[] => {
    if (depth > 4) return [];
    const self = facts.find((f) => f.file.path === file);
    if (!self) return [];
    if (self.appIdents.has(ident) || (LIKELY_APP.test(ident) && !self.routerIdents.has(ident))) {
      return [''];
    }
    const out: string[] = [];
    for (const { facts: owner, mount } of mountsByFile) {
      const targetsThis =
        (owner.file.path === file && mount.target === ident) ||
        (mount.module && resolveModule(owner.file.path, mount.module, known) === file) ||
        (mount.target &&
          owner.imports.has(mount.target) &&
          resolveModule(owner.file.path, owner.imports.get(mount.target)!, known) === file);
      if (!targetsThis) continue;
      for (const parent of prefixOf(owner.file.path, mount.mounter, depth + 1)) {
        out.push(`${parent}/${mount.prefix}`);
      }
    }
    return out;
  };

  const routes: RouteDefinition[] = [];
  for (const f of facts) {
    for (const r of f.routes) {
      if (f.clientIdents.has(r.ident)) continue;
      const isApp = f.appIdents.has(r.ident) || LIKELY_APP.test(r.ident);
      const isRouter = f.routerIdents.has(r.ident) || LIKELY_ROUTER.test(r.ident);
      if (!isApp && !isRouter) continue; // e.g. `api.get('/x')` on an HTTP client instance
      const mounted =
        isApp && !f.routerIdents.has(r.ident) ? [''] : prefixOf(f.file.path, r.ident, 0);
      // A router whose mount point is unknown has an unknown full path: emitting `/:id` as
      // `/{param}` would match unrelated one-segment calls, so it is not reported at all.
      for (const base of mounted) {
        const path = joinHttpPath(base, r.path);
        if (!path) continue;
        routes.push({
          ...(r.method ? { method: r.method } : {}),
          path,
          filePath: f.file.path,
          line: r.line,
          framework: 'express',
          confidence: 'medium',
          summary: `Route ${r.method ?? 'ALL'} ${path}`,
        });
        if (routes.length >= MAX_ROUTES) return routes;
      }
    }
  }
  return routes;
}

function detectNestRoutes(files: SourceFile[]): RouteDefinition[] {
  let globalPrefix = '';
  for (const f of files) {
    const g = f.content.match(/\.setGlobalPrefix\(\s*(['"`])([^'"`]*)\1/);
    if (g) {
      globalPrefix = g[2]!;
      break;
    }
  }
  const routes: RouteDefinition[] = [];
  for (const f of files) {
    if (!SOURCE_EXT.test(f.path) || !f.content.includes('@Controller')) continue;
    const src = f.content;
    const controllers = [
      ...src.matchAll(/@Controller\(\s*(?:(['"`])([^'"`]*)\1\s*|(\{[^}]*\})\s*)?\)/g),
    ];
    controllers.forEach((ctrl, index) => {
      const start = ctrl.index!;
      const end = controllers[index + 1]?.index ?? src.length;
      const prefix =
        ctrl[2] ??
        (ctrl[3] ? /\bpath\s*:\s*(['"`])([^'"`]*)\1/.exec(ctrl[3])?.[2] : undefined) ??
        '';
      const body = src.slice(start, end);
      for (const d of body.matchAll(
        /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:(['"`])([^'"`]*)\2\s*)?\)/g,
      )) {
        const path = joinHttpPath(globalPrefix, prefix, d[3] ?? '');
        if (!path) continue;
        const method = d[1] === 'All' ? undefined : normalizeHttpMethod(d[1]);
        routes.push({
          ...(method ? { method } : {}),
          path,
          filePath: f.path,
          line: lineAt(src, start + d.index!),
          framework: 'nest',
          confidence: 'high',
          summary: `Nest ${method ?? 'ALL'} ${path}`,
        });
        if (routes.length >= MAX_ROUTES) return;
      }
    });
  }
  return routes;
}

/** All server routes found in the given files of one repository. */
export function detectRouteDefinitions(files: SourceFile[]): RouteDefinition[] {
  const seen = new Set<string>();
  return [...detectNestRoutes(files), ...detectExpressRoutes(files)].filter((r) => {
    const key = `${r.method ?? '*'} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
