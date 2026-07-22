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

export type ToolbarPhase = 'hidden' | 'trigger' | 'menu';

export type AiActionId =
  'explain' | 'improve-writing' | 'summarize' | 'translate' | 'explain-code' | 'custom-prompt';

export type AiAction = {
  id: AiActionId;
  label: string;
  description: string;
  shortcut?: string;
};

export type SelectionSnapshot = {
  text: string;
  rect: SelectionRect;
};
