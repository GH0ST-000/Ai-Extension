import type { AIAction } from '@project-x/types';

export type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type ToolbarPhase = 'hidden' | 'trigger' | 'menu' | 'assistant';

export type AiActionId = AIAction;

export type AiActionDefinition = {
  id: AIAction;
  label: string;
  description: string;
  shortcut?: string;
};

export type AssistantView =
  | { status: 'menu' }
  | { status: 'custom-prompt'; input: string }
  | { status: 'loading'; action: AIAction }
  | { status: 'streaming'; action: AIAction; content: string }
  | { status: 'success'; action: AIAction; content: string }
  | { status: 'error'; action: AIAction; message: string };

export type SelectionSnapshot = {
  text: string;
  rect: SelectionRect;
};
