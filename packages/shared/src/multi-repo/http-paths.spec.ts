import { describe, expect, it } from 'vitest';

import {
  httpMethodsMatch,
  httpPathsMatch,
  isGenericHttpPath,
  joinHttpPath,
  normalizeHttpPath,
  parseEndpointSpec,
} from './http-paths';

describe('normalizeHttpPath', () => {
  it('maps every parameter syntax to {param}', () => {
    for (const raw of [
      '/api/users/:id',
      '/api/users/{id}',
      '/api/users/${userId}',
      '/api/users/:id?',
    ]) {
      expect(normalizeHttpPath(raw), raw).toBe('/api/users/{param}');
    }
    expect(normalizeHttpPath('/files/v{version}/x')).toBe('/files/v{param}/x');
    expect(normalizeHttpPath('/users/user-${id}')).toBe('/users/user-{param}');
  });

  it('removes query, fragment, duplicate and trailing slashes; keeps case', () => {
    expect(normalizeHttpPath('/api//users/?page=2#top')).toBe('/api/users');
    expect(normalizeHttpPath('https://api.example.com/api/Users/')).toBe('/api/Users');
    expect(normalizeHttpPath('/')).toBe('/');
  });

  it('decodes safely and never creates new structure', () => {
    expect(normalizeHttpPath('/caf%C3%A9')).toBe('/café');
    expect(normalizeHttpPath('/a%2Fb')).toBe('/a%2Fb');
    expect(normalizeHttpPath('/bad%E0%A4%A')).toBe('/bad%E0%A4%A');
  });

  it('rejects non-paths', () => {
    for (const raw of ['users', '', 'mailto:x@y.z', undefined, null, '/'.repeat(5000)]) {
      expect(normalizeHttpPath(raw as string)).toBeNull();
    }
  });

  it('joins prefixes', () => {
    expect(joinHttpPath('/api/', 'users', ':id')).toBe('/api/users/{param}');
    expect(joinHttpPath(null, '/health')).toBe('/health');
  });
});

describe('matching', () => {
  it('provider parameters accept concrete or dynamic consumer segments', () => {
    expect(httpPathsMatch('/api/users/{param}', '/api/users/{param}')).toBe(true);
    expect(httpPathsMatch('/api/users/42', '/api/users/{param}')).toBe(true);
  });

  it('rejects unrelated endpoints', () => {
    expect(httpPathsMatch('/api/users', '/api/users/{param}')).toBe(false);
    expect(httpPathsMatch('/api/users/{param}', '/api/users/me')).toBe(false);
    expect(httpPathsMatch('/api/orders/{param}', '/api/users/{param}')).toBe(false);
    expect(httpPathsMatch('/api/users', '/API/users')).toBe(false);
  });

  it('methods match when equal or unknown', () => {
    expect(httpMethodsMatch('GET', 'GET')).toBe(true);
    expect(httpMethodsMatch(undefined, 'POST')).toBe(true);
    expect(httpMethodsMatch('GET', 'POST')).toBe(false);
  });

  it('generic endpoints are recognized', () => {
    for (const p of ['/health', '/api/health', '/v1/status', '/metrics', '/']) {
      expect(isGenericHttpPath(p), p).toBe(true);
    }
    expect(isGenericHttpPath('/api/users')).toBe(false);
  });

  it('parses endpoint specs', () => {
    expect(parseEndpointSpec('GET /api/users/{id}')).toEqual({
      method: 'GET',
      path: '/api/users/{param}',
    });
    expect(parseEndpointSpec('/api/users')).toEqual({ path: '/api/users' });
    expect(parseEndpointSpec('FETCH /x')).toBeNull();
    expect(parseEndpointSpec(42)).toBeNull();
  });
});

describe('joinHttpPath', () => {
  it('trims slashes in linear time', () => {
    expect(joinHttpPath('/api/', '//users/:id//')).toBe('/api/users/{param}');
    expect(joinHttpPath('a' + '/'.repeat(200_000) + 'b')).not.toBeUndefined();
  });
});
