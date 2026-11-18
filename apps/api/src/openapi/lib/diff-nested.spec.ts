import { describe, expect, it } from 'vitest';

import { diffApiContracts } from './diff';
import { normalizeOpenApiDocument } from './normalize';
import { parseOpenApiRaw } from './parse-raw';

/** OpenAPI shaped like gh0st-000/project-x-test-api (users list + user by id via $ref). */
function usersApi(user: string, extra = ''): string {
  return `openapi: 3.0.3
info:
  title: project-x-test-api
  version: 1.0.0
paths:
  /health:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties:
                  status: { type: string, enum: [ok] }
  /api/users:
    get:
      summary: List users
      responses:
        '200':
          description: All users
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UsersResponse'
  /api/users/{id}:
    get:
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: One user
          content:
            application/json:
              schema:
                type: object
                required: [user]
                properties:
                  user:
                    $ref: '#/components/schemas/User'
${extra}components:
  schemas:
    User:
${user}
    UsersResponse:
      type: object
      required: [users]
      properties:
        users:
          type: array
          items:
            $ref: '#/components/schemas/User'
`;
}

const USER_BASE = `      type: object
      required: [id, name]
      properties:
        id: { type: string, example: usr_001 }
        name: { type: string, example: Alice }`;
const USER_RENAMED = `      type: object
      required: [id, displayName]
      properties:
        id: { type: string, example: usr_001 }
        displayName: { type: string, example: Alice }`;

const contract = (yaml: string) => {
  const { document } = parseOpenApiRaw(yaml);
  return normalizeOpenApiDocument(document, { type: 'page' }, yaml);
};
const diff = (base: string, head: string) =>
  diffApiContracts(contract(base), contract(head), { baseRef: 'main', headRef: 'pr' });
const lines = (changes: Array<{ title: string }>) => changes.map((c) => c.title);

describe('diffApiContracts — nested response fields', () => {
  it('ACCEPTANCE: name → displayName on User is breaking on both user endpoints, /health untouched', () => {
    const d = diff(usersApi(USER_BASE), usersApi(USER_RENAMED));
    expect(lines(d.breakingChanges)).toEqual([
      'Removed response field users[].name (200) on GET /api/users',
      'Removed response field user.name (200) on GET /api/users/{id}',
    ]);
    expect(
      d.breakingChanges.map((c) => [c.kind, c.method, c.path, c.fieldPath, c.statusCode]),
    ).toEqual([
      ['removed-response-field', 'GET', '/api/users', 'users[].name', '200'],
      ['removed-response-field', 'GET', '/api/users/{id}', 'user.name', '200'],
    ]);
    expect(lines(d.nonBreakingChanges)).toEqual([
      'Added response field users[].displayName (200) on GET /api/users',
      'Added response field user.displayName (200) on GET /api/users/{id}',
    ]);
    expect(d.nonBreakingChanges.every((c) => c.kind === 'added-response-field')).toBe(true);
    expect(d.uncertainChanges).toEqual([]);
    expect([...d.breakingChanges, ...d.nonBreakingChanges].some((c) => c.path === '/health')).toBe(
      false,
    );
  });

  it('documentation-only edits (summaries, descriptions, examples, version) produce no changes', () => {
    const docs = usersApi(USER_BASE)
      .replace('version: 1.0.0', 'version: 1.0.1')
      .replace('summary: List users', 'summary: List every user')
      .replace('description: All users', 'description: Every user in the store')
      .replace('example: Alice', 'example: Alicia');
    const d = diff(usersApi(USER_BASE), docs);
    expect([...d.breakingChanges, ...d.nonBreakingChanges, ...d.uncertainChanges]).toEqual([]);
  });

  it('nested type changes, objects and removed parents are reported once at the right level', () => {
    const typed = USER_BASE.replace(
      'id: { type: string, example: usr_001 }',
      'id: { type: integer }',
    );
    expect(lines(diff(usersApi(USER_BASE), usersApi(typed)).breakingChanges)).toEqual([
      'Type change for users[].id (200) on GET /api/users',
      'Type change for user.id (200) on GET /api/users/{id}',
    ]);
    const withAddress = `${USER_BASE}
        address:
          type: object
          properties:
            city: { type: string }
            zip: { type: string }`;
    const cityRemoved = withAddress.replace('            city: { type: string }\n', '');
    expect(
      diff(usersApi(withAddress), usersApi(cityRemoved)).breakingChanges.map((c) => c.fieldPath),
    ).toEqual(['users[].address.city', 'user.address.city']);
    // Removing the whole object reports the object, not each child.
    expect(
      diff(usersApi(withAddress), usersApi(USER_BASE)).breakingChanges.map((c) => c.fieldPath),
    ).toEqual(['users[].address', 'user.address']);
    // Adding a whole object is one additive change per operation.
    expect(
      diff(usersApi(USER_BASE), usersApi(withAddress)).nonBreakingChanges.map((c) => c.fieldPath),
    ).toEqual(['users[].address', 'user.address']);
  });

  it('required → optional and nullable are flagged as uncertain, not breaking', () => {
    const optional = USER_BASE.replace('required: [id, name]', 'required: [id]');
    expect(
      diff(usersApi(USER_BASE), usersApi(optional)).uncertainChanges.map((c) => c.fieldPath),
    ).toEqual(['users[].name', 'user.name']);
    const nullable = USER_BASE.replace(
      'name: { type: string, example: Alice }',
      'name: { type: string, nullable: true }',
    );
    const d = diff(usersApi(USER_BASE), usersApi(nullable));
    expect(d.breakingChanges).toEqual([]);
    expect(d.uncertainChanges.map((c) => c.title)).toContain(
      'Response field users[].name (200) on GET /api/users became nullable',
    );
  });

  it('response enums: removed values are compatible, added values are uncertain', () => {
    const base = usersApi(USER_BASE);
    const narrowed = base
      .replace('enum: [ok]', 'enum: [ok]')
      .replace(
        'status: { type: string, enum: [ok] }',
        'status: { type: string, enum: [ok, degraded] }',
      );
    expect(diff(base, narrowed).uncertainChanges.map((c) => c.kind)).toEqual(['enum-widening']);
    expect(diff(narrowed, base).nonBreakingChanges.map((c) => c.kind)).toEqual(['enum-narrowing']);
    expect(diff(narrowed, base).breakingChanges).toEqual([]);
  });

  it('recursive $ref schemas do not crash or produce false changes', () => {
    const recursive = `      type: object
      properties:
        id: { type: string }
        manager:
          $ref: '#/components/schemas/User'`;
    const d = diff(usersApi(recursive), usersApi(recursive));
    expect([...d.breakingChanges, ...d.nonBreakingChanges, ...d.uncertainChanges]).toEqual([]);
  });
});

describe('diffApiContracts — canonical operations', () => {
  it('renaming a path parameter is not a removed endpoint or a new required field', () => {
    const renamed = usersApi(USER_BASE)
      .replace('/api/users/{id}:', '/api/users/{userId}:')
      .replace('- name: id', '- name: userId');
    const d = diff(usersApi(USER_BASE), renamed);
    expect([...d.breakingChanges, ...d.nonBreakingChanges, ...d.uncertainChanges]).toEqual([]);
  });

  it('a method change is a removed and an added operation', () => {
    const post = usersApi(USER_BASE).replace('  /api/users:\n    get:', '  /api/users:\n    post:');
    const d = diff(usersApi(USER_BASE), post);
    expect(lines(d.breakingChanges)).toEqual(['Removed GET /api/users']);
    expect(lines(d.nonBreakingChanges)).toEqual(['Added POST /api/users']);
  });

  it('a new required query parameter is breaking; distinct paths stay distinct', () => {
    const query = usersApi(USER_BASE).replace(
      '  /api/users:\n    get:\n      summary: List users\n',
      '  /api/users:\n    get:\n      summary: List users\n      parameters:\n        - name: tenant\n          in: query\n          required: true\n          schema: { type: string }\n',
    );
    expect(lines(diff(usersApi(USER_BASE), query).breakingChanges)).toEqual([
      'New required field query:tenant on GET /api/users',
    ]);
    const settings = usersApi(
      USER_BASE,
      `  /api/users/settings:\n    get:\n      responses:\n        '200':\n          description: OK\n`,
    );
    expect(lines(diff(usersApi(USER_BASE), settings).nonBreakingChanges)).toEqual([
      'Added GET /api/users/settings',
    ]);
  });

  it('malformed or truncated schemas never yield a type-change claim', () => {
    const broken = usersApi(
      USER_BASE.replace(
        'name: { type: string, example: Alice }',
        "name:\n          $ref: '#/components/schemas/Missing'",
      ),
    );
    const d = diff(usersApi(USER_BASE), broken);
    expect(d.breakingChanges.filter((c) => c.kind === 'type-change')).toEqual([]);
  });
});
