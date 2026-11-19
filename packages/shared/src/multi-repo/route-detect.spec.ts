import { describe, expect, it } from 'vitest';

import { detectRouteDefinitions } from './route-detect';

const routes = (files: Array<[string, string]>) =>
  detectRouteDefinitions(files.map(([path, content]) => ({ path, content }))).map(
    (r) => `${r.method ?? '*'} ${r.path} (${r.confidence})`,
  );

describe('detectRouteDefinitions', () => {
  it('express app routes', () => {
    expect(
      routes([
        [
          'src/server.ts',
          "const app = express();\napp.get('/health', h);\napp.get('/api/users/:id', h);",
        ],
      ]),
    ).toEqual(['GET /health (medium)', 'GET /api/users/{param} (medium)']);
  });

  it('routers mounted from another file (import and require)', () => {
    expect(
      routes([
        [
          'src/app.ts',
          "import express from 'express';\nimport usersRouter from './routes/users';\nconst app = express();\napp.use('/api/users', auth, usersRouter);\napp.use('/api/teams', require('./routes/teams'));",
        ],
        [
          'src/routes/users.ts',
          "const router = Router();\nrouter.get('/', list);\nrouter.get('/:id', get);\nexport default router;",
        ],
        [
          'src/routes/teams.js',
          "const router = express.Router();\nrouter.route('/:id').get(a).delete(b);\nmodule.exports = router;",
        ],
      ]),
    ).toEqual([
      'GET /api/users (medium)',
      'GET /api/users/{param} (medium)',
      'GET /api/teams/{param} (medium)',
      'DELETE /api/teams/{param} (medium)',
    ]);
  });

  it('unmounted routers are not reported (unknown path); client instances are not providers', () => {
    expect(
      routes([
        ['src/r.ts', "const router = Router();\nrouter.post('/login', h);\nrouter.get('/:id', h);"],
      ]),
    ).toEqual([]);
    expect(
      routes([['src/client.ts', "const api = axios.create();\napi.get('/api/users');"]]),
    ).toEqual([]);
  });

  it('router factories mounted from another module (the real test API structure)', () => {
    expect(
      routes([
        [
          'src/app.ts',
          "import express from 'express';\nimport { createUsersRouter } from './routes/users.js';\nexport function createApp() {\n  const app = express();\n  app.get('/health', (_req, res) => res.json({ status: 'ok' }));\n  app.use('/api/users', createUsersRouter());\n  app.use(notFoundHandler);\n  return app;\n}",
        ],
        [
          'src/routes/users.ts',
          "import { Router } from 'express';\nexport function createUsersRouter(): Router {\n  const router = Router();\n  router.get('/', (_req, res) => res.json({ users: [] }));\n  router.get('/:id', (req, res) => res.json({}));\n  return router;\n}",
        ],
      ]),
    ).toEqual([
      'GET /health (medium)',
      'GET /api/users (medium)',
      'GET /api/users/{param} (medium)',
    ]);
  });

  it('NestJS controllers with global prefix', () => {
    expect(
      routes([
        ['src/main.ts', "app.setGlobalPrefix('api');"],
        [
          'src/users.controller.ts',
          "@Controller('users')\nexport class C {\n @Get()\n list() {}\n @Get(':id')\n one() {}\n}",
        ],
      ]),
    ).toEqual(['GET /api/users (high)', 'GET /api/users/{param} (high)']);
  });
});

describe('detectRouteDefinitions — regex shapes (CodeQL polynomial-regex fixes)', () => {
  it('typed declarations, aliased named imports and controller path objects still match', () => {
    expect(
      routes([
        [
          'src/app.ts',
          "import { usersRouter as users } from './routes/users';\nconst app: Express = express();\napp.use('/api/users', users);",
        ],
        [
          'src/routes/users.ts',
          "export const usersRouter: Router = Router();\nconst r : Router = Router();\nusersRouter.get('/:id', h);",
        ],
        [
          'src/teams.controller.ts',
          "@Controller({ version: '1', path: 'teams' })\nexport class T {\n  @Get( ':id' )\n  one() {}\n}",
        ],
      ]),
    ).toEqual(
      expect.arrayContaining(['GET /api/users/{param} (medium)', 'GET /teams/{param} (high)']),
    );
  });

  it('long whitespace and repeated tokens are processed in linear time', () => {
    const sp = ' '.repeat(100_000);
    const started = Date.now();
    for (const content of [
      `import x${sp}`,
      `import {a${sp}} from 'x'`,
      `const x${sp}`,
      `@Controller(${sp}`,
      `@Controller({${'('.repeat(100_000)}`,
      '@Controller({'.repeat(40_000), // CodeQL: rescanning from every `@Controller(`
    ]) {
      expect(detectRouteDefinitions([{ path: 'src/a.ts', content }])).toEqual([]);
    }
    expect(Date.now() - started).toBeLessThan(2_000); // was minutes (cubic) before the fix
  });
});
