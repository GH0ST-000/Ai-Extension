import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIAction } from '@project-x/types';

const streamAiActionMock = vi.fn();
const extractPageContextMock = vi.fn(() => ({
  type: 'generic' as const,
  url: 'https://example.com/page',
  title: 'Example',
}));

vi.mock('../services/ai-client', async () => {
  const actual = await vi.importActual('../services/ai-client');
  return {
    ...(actual as Record<string, unknown>),
    streamAiAction: (...args: unknown[]) => streamAiActionMock(...args),
  };
});

vi.mock('../context/extract-page-context', () => ({
  extractPageContext: () => extractPageContextMock(),
}));

import { useSelectionToolbarStore } from './store';

describe('selection toolbar store AI flow', () => {
  beforeEach(() => {
    streamAiActionMock.mockReset();
    extractPageContextMock.mockClear();
    useSelectionToolbarStore.setState({
      phase: 'hidden',
      selectedText: '',
      anchorRect: null,
      assistant: { status: 'menu' },
      customPrompt: '',
      requestId: 0,
      abortController: null,
    });
  });

  it('transitions menu → loading → streaming → success', async () => {
    useSelectionToolbarStore.setState({
      phase: 'assistant',
      selectedText: 'Selected text',
      anchorRect: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        top: 0,
        right: 10,
        bottom: 10,
        left: 0,
      },
      assistant: { status: 'menu' },
    });

    streamAiActionMock.mockImplementation(async (_request, handlers) => {
      await Promise.resolve();
      expect(useSelectionToolbarStore.getState().assistant.status).toBe('loading');
      handlers.onChunk('Hel');
      expect(useSelectionToolbarStore.getState().assistant.status).toBe('streaming');
      handlers.onChunk('lo');
      return 'Hello';
    });

    await useSelectionToolbarStore.getState().startAction(AIAction.EXPLAIN);

    expect(extractPageContextMock).toHaveBeenCalled();
    expect(streamAiActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AIAction.EXPLAIN,
        text: 'Selected text',
        context: expect.objectContaining({ type: 'generic' }),
      }),
      expect.any(Object),
    );

    expect(useSelectionToolbarStore.getState().assistant).toEqual({
      status: 'success',
      action: AIAction.EXPLAIN,
      content: 'Hello',
    });
  });

  it('maps empty responses to error state', async () => {
    useSelectionToolbarStore.setState({
      phase: 'assistant',
      selectedText: 'Selected text',
      anchorRect: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        top: 0,
        right: 10,
        bottom: 10,
        left: 0,
      },
      assistant: { status: 'menu' },
    });

    const { AiClientError } = await import('../services/ai-client');
    streamAiActionMock.mockRejectedValue(new AiClientError('Unable to generate a response.'));

    await useSelectionToolbarStore.getState().startAction(AIAction.SUMMARIZE);

    expect(useSelectionToolbarStore.getState().assistant.status).toBe('error');
  });

  it('ignores intentional abort errors', async () => {
    useSelectionToolbarStore.setState({
      phase: 'assistant',
      selectedText: 'Selected text',
      anchorRect: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        top: 0,
        right: 10,
        bottom: 10,
        left: 0,
      },
      assistant: { status: 'menu' },
    });

    const { AiClientError } = await import('../services/ai-client');
    streamAiActionMock.mockRejectedValue(new AiClientError('Request cancelled', { aborted: true }));

    await useSelectionToolbarStore.getState().startAction(AIAction.EXPLAIN);
    expect(useSelectionToolbarStore.getState().assistant.status).not.toBe('error');
  });

  it('Back returns to menu and Cancel closes assistant', () => {
    useSelectionToolbarStore.setState({
      phase: 'assistant',
      selectedText: 'keep me',
      assistant: { status: 'success', action: AIAction.EXPLAIN, content: 'Done' },
    });

    useSelectionToolbarStore.getState().backToMenu();
    expect(useSelectionToolbarStore.getState().assistant).toEqual({ status: 'menu' });
    expect(useSelectionToolbarStore.getState().selectedText).toBe('keep me');

    useSelectionToolbarStore.getState().dismiss();
    expect(useSelectionToolbarStore.getState().phase).toBe('hidden');
  });

  it('Custom Prompt rejects empty input', async () => {
    useSelectionToolbarStore.setState({
      phase: 'assistant',
      selectedText: 'Selected text',
      customPrompt: '   ',
      assistant: { status: 'custom-prompt', input: '   ' },
    });

    await useSelectionToolbarStore.getState().startAction(AIAction.CUSTOM, {
      customPrompt: '   ',
    });

    expect(streamAiActionMock).not.toHaveBeenCalled();
    expect(useSelectionToolbarStore.getState().assistant.status).toBe('custom-prompt');
  });

  it('prevents stale requests from overwriting newer state', async () => {
    useSelectionToolbarStore.setState({
      phase: 'assistant',
      selectedText: 'Selected text',
      anchorRect: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        top: 0,
        right: 10,
        bottom: 10,
        left: 0,
      },
      assistant: { status: 'menu' },
    });

    let resolveFirst: (value: string) => void = () => {
      /* assigned when first request starts */
    };

    streamAiActionMock
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async (_request, handlers) => {
        handlers.onChunk('Second');
        return 'Second';
      });

    const first = useSelectionToolbarStore.getState().startAction(AIAction.EXPLAIN);
    const second = useSelectionToolbarStore.getState().startAction(AIAction.SUMMARIZE);
    await second;
    resolveFirst('First');
    await first;

    expect(useSelectionToolbarStore.getState().assistant).toEqual({
      status: 'success',
      action: AIAction.SUMMARIZE,
      content: 'Second',
    });
  });
});
