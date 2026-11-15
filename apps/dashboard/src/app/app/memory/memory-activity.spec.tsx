import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectMemoryAuditEvent, ProjectMemoryAuditRuleSummary } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});

import { MemoryActivity } from './memory-activity';
import { auditActorLabel, auditChangeLines, ruleEventCountLabel } from './memory-audit-data';

const event = (over: Partial<ProjectMemoryAuditEvent> = {}): ProjectMemoryAuditEvent => ({
  id: 'ev1',
  schemaVersion: 1,
  eventType: 'rule_edited',
  actorType: 'user',
  actorUserId: 'u_other',
  actorName: 'Ana',
  actorIsViewer: false,
  reason: 'user_rule',
  memoryId: 'mem1',
  relatedMemoryId: null,
  visibility: 'workspace',
  provider: 'github',
  owner: 'acme',
  repository: 'payments',
  category: 'PROJECT_CONSTRAINT',
  key: 'pay.wh',
  previousState: { status: 'active', text: 'Old text.' },
  newState: { status: 'active', text: 'New text.' },
  requestId: 'req',
  createdAt: '2026-11-17T10:00:00.000Z',
  ...over,
});

const rule = (
  over: Partial<ProjectMemoryAuditRuleSummary> = {},
): ProjectMemoryAuditRuleSummary => ({
  memoryId: 'mem1',
  owner: 'acme',
  repository: 'payments',
  category: 'PROJECT_CONSTRAINT',
  key: 'pay.wh',
  visibility: 'workspace',
  matchingEventCount: 3,
  totalEventCount: 3,
  latestEvent: event(),
  currentStatus: 'active',
  ...over,
});

const props = (over: Partial<Parameters<typeof MemoryActivity>[0]> = {}) => ({
  workspaceId: 'ws_1',
  workspaceRevision: 1,
  owner: 'acme',
  repository: 'payments',
  ruleId: null,
  ruleLabel: null,
  onClearRule: vi.fn(),
  refreshKey: 'v1',
  ...over,
});

const isRulesCall = (path: unknown) => String(path).includes('/memory/audit/rules');

beforeEach(() => apiFetch.mockReset());
afterEach(() => cleanup());

describe('memory audit helpers', () => {
  it('labels actors safely and distinguishes automatic changes', () => {
    expect(auditActorLabel(event())).toBe('Ana');
    expect(auditActorLabel(event({ actorIsViewer: true }))).toBe('You');
    expect(auditActorLabel(event({ actorName: null, actorUserId: null }))).toBe('Former member');
    expect(auditActorLabel(event({ actorType: 'system', actorIsViewer: true }))).toBe(
      'Automatic (started by you)',
    );
  });

  it('describes changes and event counts unambiguously', () => {
    expect(auditChangeLines(event())).toEqual(['Text: “Old text.” → “New text.”']);
    expect(ruleEventCountLabel({ matchingEventCount: 1, totalEventCount: 1 })).toBe('1 event');
    expect(ruleEventCountLabel({ matchingEventCount: 4, totalEventCount: 4 })).toBe('4 events');
    expect(ruleEventCountLabel({ matchingEventCount: 1, totalEventCount: 4 })).toBe(
      '1 of 4 events',
    );
  });
});

describe('MemoryActivity (grouped rows)', () => {
  it('shows one compact row per rule with key, category, latest action, actor, time and count', async () => {
    let resolve!: (v: unknown) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<MemoryActivity {...props()} />);
    expect(screen.getByText('Loading activity…')).toBeTruthy();
    await act(async () => {
      resolve({
        items: [
          rule(),
          rule({
            memoryId: 'mem2',
            key: 'pay.wh', // same key, different record: its own row
            matchingEventCount: 1,
            totalEventCount: 4,
            latestEvent: event({
              id: 'ev2',
              memoryId: 'mem2',
              eventType: 'rule_superseded',
              actorType: 'system',
              actorIsViewer: true,
            }),
          }),
          rule({ memoryId: 'mem3', key: 'me.style', visibility: 'user' }),
        ],
        nextCursor: null,
      });
    });
    const list = within(screen.getByRole('list', { name: 'Memory rules with activity' }));
    const rows = list.getAllByRole('button');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('pay.wh')).toBeTruthy();
    expect(within(rows[0]!).getByText('PROJECT_CONSTRAINT')).toBeTruthy();
    expect(within(rows[0]!).getByText('Edited')).toBeTruthy();
    expect(within(rows[0]!).getByText(/by Ana ·/)).toBeTruthy();
    expect(within(rows[0]!).getByText('3 events')).toBeTruthy();
    expect(within(rows[1]!).getByText('1 of 4 events')).toBeTruthy();
    expect(within(rows[1]!).getByText(/by Automatic \(started by you\)/)).toBeTruthy();
    expect(within(rows[2]!).getByText('Personal')).toBeTruthy();
    const [path, init] = apiFetch.mock.calls[0]! as [string, { cache: string }];
    expect(path).toBe(
      '/workspaces/ws_1/memory/audit/rules?owner=acme&repository=payments&limit=20',
    );
    expect(init.cache).toBe('no-store');
  });

  it('empty state, and an error state with retry (no server text)', async () => {
    apiFetch.mockResolvedValueOnce({ items: [], nextCursor: null });
    render(<MemoryActivity {...props()} />);
    await waitFor(() =>
      expect(screen.getByText('No recorded activity for this repository yet.')).toBeTruthy(),
    );
    cleanup();
    apiFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ items: [rule()], nextCursor: null });
    render(<MemoryActivity {...props()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/reach Project X/i));
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByText('pay.wh')).toBeTruthy());
  });

  it('event, actor and (debounced) search filters are sent together to the server', async () => {
    apiFetch.mockResolvedValue({ items: [], nextCursor: null });
    render(<MemoryActivity {...props()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('Event'));
    fireEvent.click(screen.getByRole('option', { name: 'Archived' }));
    fireEvent.click(screen.getByLabelText('Actor'));
    fireEvent.click(screen.getByRole('option', { name: 'People' }));
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: ' pay ' } });
    await waitFor(() => {
      const last = String(apiFetch.mock.calls.at(-1)![0]);
      expect(last).toContain('eventType=rule_archived');
      expect(last).toContain('actorType=user');
      expect(last).toContain('q=pay');
    });
    expect(screen.getByText('No rules match these filters.')).toBeTruthy();
  });

  it('paginates rules with the server cursor', async () => {
    apiFetch.mockResolvedValueOnce({ items: [rule()], nextCursor: 'c1' }).mockResolvedValueOnce({
      items: [rule({ memoryId: 'mem9', key: 'second.page' })],
      nextCursor: null,
    });
    render(<MemoryActivity {...props()} />);
    fireEvent.click(await screen.findByText('Load more rules'));
    await waitFor(() => expect(screen.getByText('second.page')).toBeTruthy());
    expect(String(apiFetch.mock.calls[1]![0])).toContain('cursor=c1');
    expect(screen.queryByText('Load more rules')).toBeNull();
  });

  it('switching workspace drops previous rows before the new ones arrive', async () => {
    apiFetch.mockResolvedValueOnce({ items: [rule({ key: 'from.ws1' })], nextCursor: null });
    const { rerender } = render(<MemoryActivity {...props()} />);
    await waitFor(() => expect(screen.getByText('from.ws1')).toBeTruthy());
    apiFetch.mockReturnValueOnce(new Promise(() => undefined));
    rerender(<MemoryActivity {...props({ workspaceId: 'ws_2', workspaceRevision: 2 })} />);
    await waitFor(() => expect(screen.queryByText('from.ws1')).toBeNull());
    expect(String(apiFetch.mock.calls.at(-1)![0])).toContain('/workspaces/ws_2/');
  });
});

describe('Rule history modal', () => {
  function routeApi(history: Record<string, unknown>[]) {
    apiFetch.mockImplementation(async (path: string) => {
      if (isRulesCall(path)) return { items: [rule()], nextCursor: null };
      return history.shift() ?? { items: [], nextCursor: null };
    });
  }

  it('opens from a row, loads the complete history (no page filters), and closes with Escape', async () => {
    routeApi([
      {
        items: [
          event({
            id: 'e3',
            eventType: 'rule_archived',
            previousState: { status: 'active', text: 'New text.' },
            newState: { status: 'archived', text: 'New text.' },
          }),
          event({ id: 'e2' }),
          event({
            id: 'e1',
            eventType: 'rule_created',
            previousState: null,
            newState: { status: 'active', text: 'Old text.' },
          }),
        ],
        nextCursor: null,
      },
    ]);
    render(<MemoryActivity {...props()} />);
    // A page filter is active; the modal must ignore it.
    fireEvent.click(screen.getByLabelText('Event'));
    fireEvent.click(screen.getByRole('option', { name: 'Archived' }));
    const row = await screen.findByRole('button', { name: /pay\.wh/ });
    fireEvent.click(row);

    const dialog = await screen.findByRole('dialog');
    const header = within(dialog.querySelector('h2')!.parentElement!);
    expect(header.getByText('pay.wh')).toBeTruthy();
    expect(header.getByText('3 events')).toBeTruthy();
    expect(header.getByText('active')).toBeTruthy(); // current status
    expect(header.getByText('PROJECT_CONSTRAINT')).toBeTruthy();
    const timeline = await within(dialog).findByRole('list', { name: 'Rule history' });
    const entries = within(timeline).getAllByRole('listitem');
    expect(entries.map((e) => e.querySelector('div > span')?.textContent)).toEqual([
      'Archived',
      'Edited',
      'Created',
    ]);
    expect(within(entries[0]!).getByText(/Status:/).textContent).toContain('active → archived');
    expect(within(entries[1]!).getByText('Previous')).toBeTruthy();
    expect(within(entries[1]!).getByText('Old text.')).toBeTruthy();
    expect(within(entries[1]!).getByText('New')).toBeTruthy();
    expect(within(entries[1]!).getByText('New text.')).toBeTruthy();
    const historyCall = String(apiFetch.mock.calls.find(([p]) => !isRulesCall(p))![0]);
    expect(historyCall).toBe('/workspaces/ws_1/memory/audit?memoryId=mem1&limit=25');

    // Focus is inside the dialog; Escape closes it and returns focus to the row.
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(row);
  });

  it('closes with the close button and the backdrop; loads older events on demand', async () => {
    routeApi([
      { items: [event({ id: 'n1' })], nextCursor: 'h1' },
      {
        items: [event({ id: 'n2', eventType: 'rule_created', previousState: null })],
        nextCursor: null,
      },
    ]);
    render(<MemoryActivity {...props()} />);
    fireEvent.click(await screen.findByRole('button', { name: /pay\.wh/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByText('Load older events'));
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(2));
    expect(String(apiFetch.mock.calls.at(-1)![0])).toContain('cursor=h1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close history' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /pay\.wh/ }));
    await screen.findByRole('dialog');
    // Backdrop (the first "Close history" control, outside the panel).
    fireEvent.click(screen.getAllByRole('button', { name: 'Close history', hidden: true })[0]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("opens from a rule's History button and clears it on close; empty history state", async () => {
    routeApi([{ items: [], nextCursor: null }]);
    const onClearRule = vi.fn();
    render(
      <MemoryActivity {...props({ ruleId: 'mem7', ruleLabel: 'deploy.region', onClearRule })} />,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('deploy.region')).toBeTruthy();
    await waitFor(() =>
      expect(within(dialog).getByText('No recorded activity for this rule.')).toBeTruthy(),
    );
    expect(apiFetch.mock.calls.some(([p]) => String(p).includes('memoryId=mem7'))).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClearRule).toHaveBeenCalledTimes(1));
  });
});
