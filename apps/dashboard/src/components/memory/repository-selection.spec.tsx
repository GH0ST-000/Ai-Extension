import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProjectSystem } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRepositoryGroups,
  clearLastRepository,
  filterRepositoryGroups,
  forgetRepository,
  parseRepositoryInput,
  readLastRepository,
  readRecentRepositories,
  rememberRepository,
  REPOSITORY_STORAGE_KEY,
} from './repository-selection';
import { RepositorySelector } from './repository-selector';

const opt = (fullName: string) => parseRepositoryInput(fullName)!;
const system = (id: string, name: string, repos: string[]): ProjectSystem => ({
  id,
  name,
  primaryRepository: { provider: 'github', ...opt(repos[0]!) },
  repositories: repos.map((r) => ({
    repository: { provider: 'github', ...opt(r) },
    role: 'backend',
    enabled: true,
    source: 'user_selected',
  })) as ProjectSystem['repositories'],
  createdAt: '',
  updatedAt: '',
});

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe('parseRepositoryInput', () => {
  it('accepts owner/repository and github.com URLs, normalized', () => {
    for (const input of [
      'gh0st-000/project-x-test-api',
      'GH0ST-000/Project-X-Test-API',
      ' gh0st-000/project-x-test-api ',
      'https://github.com/gh0st-000/project-x-test-api',
      'https://github.com/gh0st-000/project-x-test-api.git',
      'github.com/gh0st-000/project-x-test-api/',
    ]) {
      expect(parseRepositoryInput(input), input).toEqual({
        owner: 'gh0st-000',
        repository: 'project-x-test-api',
        fullName: 'gh0st-000/project-x-test-api',
      });
    }
  });

  it('rejects malformed values, other hosts and ambiguous paths', () => {
    for (const input of [
      '',
      'gh0st-000',
      'gh0st-000/',
      'a/b/c',
      'https://gitlab.com/a/b',
      'https://github.com.evil.com/a/b',
      'https://github.com/a/b/tree/main',
      'example.com/repo',
      'owner/re po',
      '-owner/repo',
      'owner/..',
      `${'a'.repeat(40)}/repo`,
      'javascript:alert(1)',
    ]) {
      expect(parseRepositoryInput(input), input).toBeNull();
    }
  });
});

describe('recent and last repositories (per workspace)', () => {
  it('most recent first, de-duplicated by canonical identity, at most 10', () => {
    for (let i = 0; i < 12; i += 1) rememberRepository('ws_a', opt(`acme/repo-${i}`));
    rememberRepository('ws_a', { owner: 'ACME', repository: 'Repo-3' });
    const recent = readRecentRepositories('ws_a').map((r) => r.fullName);
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe('acme/repo-3');
    expect(recent.filter((r) => r === 'acme/repo-3')).toHaveLength(1);
    expect(readLastRepository('ws_a')?.fullName).toBe('acme/repo-3');
  });

  it('workspaces never see each other’s repositories', () => {
    rememberRepository('ws_a', opt('acme/private-a'));
    rememberRepository('ws_b', opt('other/private-b'));
    expect(readRecentRepositories('ws_a').map((r) => r.fullName)).toEqual(['acme/private-a']);
    expect(readRecentRepositories('ws_b').map((r) => r.fullName)).toEqual(['other/private-b']);
    expect(readLastRepository('ws_c')).toBeNull();
  });

  it('forget removes a refused repository; clear keeps recents', () => {
    rememberRepository('ws_a', opt('acme/one'));
    rememberRepository('ws_a', opt('acme/two'));
    forgetRepository('ws_a', opt('acme/two'));
    expect(readLastRepository('ws_a')).toBeNull();
    expect(readRecentRepositories('ws_a').map((r) => r.fullName)).toEqual(['acme/one']);
    rememberRepository('ws_a', opt('acme/one'));
    clearLastRepository('ws_a');
    expect(readLastRepository('ws_a')).toBeNull();
    expect(readRecentRepositories('ws_a')).toHaveLength(1);
  });

  it('invalid, outdated or hostile stored values are ignored', () => {
    for (const raw of ['not json', '{"v":0}', 'null', '{"v":1,"workspaces":null}']) {
      window.localStorage.setItem(REPOSITORY_STORAGE_KEY, raw);
      expect(readRecentRepositories('ws_a')).toEqual([]);
    }
    window.localStorage.setItem(
      REPOSITORY_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        workspaces: {
          ws_a: { last: 'https://evil.com/x/y', recent: ['acme/ok', 42, 'a/b/c', 'ACME/OK'] },
        },
      }),
    );
    expect(readRecentRepositories('ws_a').map((r) => r.fullName)).toEqual(['acme/ok']);
    expect(readLastRepository('ws_a')).toBeNull();
  });

  it('stores repository names only (no tokens or content)', () => {
    rememberRepository('ws_a', opt('acme/one'));
    expect(JSON.parse(window.localStorage.getItem(REPOSITORY_STORAGE_KEY)!)).toEqual({
      v: 1,
      workspaces: { ws_a: { last: 'acme/one', recent: ['acme/one'] } },
    });
  });

  it('storage failures never break selection', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readRecentRepositories('ws_a')).toEqual([]);
    expect(() => rememberRepository('ws_a', opt('acme/one'))).not.toThrow();
    spy.mockRestore();
  });
});

describe('suggestion groups', () => {
  const groups = buildRepositoryGroups({
    recent: [opt('gh0st-000/project-x-test-api')],
    systems: [
      system('s1', 'Test Microservices', [
        'gh0st-000/project-x-test-api',
        'gh0st-000/project-x-test-client',
      ]),
    ],
    history: [
      { owner: 'GH0ST-000', repository: 'project-x-test-client' },
      { owner: 'acme', repository: 'billing' },
    ],
  });

  it('recent, then Systems, then Review History; each repository once', () => {
    expect(groups.map((g) => [g.label, g.options.map((o) => o.fullName)])).toEqual([
      ['Recently used', ['gh0st-000/project-x-test-api']],
      ['System · Test Microservices', ['gh0st-000/project-x-test-client']],
      ['From Review History', ['acme/billing']],
    ]);
  });

  it('filters by owner, repository, full name and System name', () => {
    const names = (q: string) =>
      filterRepositoryGroups(groups, q).flatMap((g) => g.options.map((o) => o.fullName));
    expect(names('acme')).toEqual(['acme/billing']);
    expect(names('test-client')).toEqual(['gh0st-000/project-x-test-client']);
    expect(names('GH0ST-000/PROJECT-X-TEST-API')).toEqual(['gh0st-000/project-x-test-api']);
    expect(names('microservices')).toEqual(['gh0st-000/project-x-test-client']);
    expect(names('nothing-matches')).toEqual([]);
  });
});

describe('RepositorySelector', () => {
  const groups = buildRepositoryGroups({
    recent: [opt('gh0st-000/project-x-test-api')],
    systems: [system('s1', 'Test Microservices', ['gh0st-000/project-x-test-client'])],
  });
  function setup(selected: string | null = null) {
    const onSelect = vi.fn();
    const onClear = vi.fn();
    render(
      <RepositorySelector
        selected={selected ? opt(selected) : null}
        groups={groups}
        onSelect={onSelect}
        onClear={onClear}
      />,
    );
    return { onSelect, onClear, input: screen.getByRole('combobox', { name: 'Repository' }) };
  }

  it('lists grouped suggestions and supports keyboard selection', () => {
    const { input, onSelect } = setup();
    fireEvent.focus(input);
    const listbox = screen.getByRole('listbox', { name: 'Repositories' });
    expect(within(listbox).getByRole('group', { name: 'Recently used' })).toBeTruthy();
    expect(
      within(listbox).getByRole('group', { name: 'System · Test Microservices' }),
    ).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toContain('project-x-test-client');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(opt('gh0st-000/project-x-test-client'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('search filters; Escape closes', () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'client' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'gh0st-000/project-x-test-client',
    ]);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('manual entry: owner/repository or a GitHub URL not in the list', () => {
    const { input, onSelect } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'https://github.com/Acme/Billing' } });
    fireEvent.click(screen.getByRole('option', { name: /Use acme\/billing/ }));
    expect(onSelect).toHaveBeenCalledWith(opt('acme/billing'));
  });

  it('invalid input is explained and cannot be selected', () => {
    const { input, onSelect } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'https://gitlab.com/a/b' } });
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByText(/Enter owner\/repository or a github.com repository URL/)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the selected repository and can clear it', () => {
    const { input, onClear } = setup('gh0st-000/project-x-test-api');
    expect((input as HTMLInputElement).value).toBe('gh0st-000/project-x-test-api');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Clear selected repository gh0st-000/project-x-test-api',
      }),
    );
    expect(onClear).toHaveBeenCalled();
  });

  it('empty state without suggestions', () => {
    const onSelect = vi.fn();
    render(
      <RepositorySelector selected={null} groups={[]} onSelect={onSelect} onClear={vi.fn()} />,
    );
    fireEvent.focus(screen.getByRole('combobox'));
    expect(screen.getByText(/No suggestions yet/)).toBeTruthy();
  });
});
