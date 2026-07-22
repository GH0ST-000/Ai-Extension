export const SHADOW_HOST_ID = 'project-x-selection-toolbar';

export const AI_ACTIONS = [
  {
    id: 'explain',
    label: 'Explain',
    description: 'Clarify meaning',
    shortcut: 'E',
  },
  {
    id: 'improve-writing',
    label: 'Improve Writing',
    description: 'Polish tone',
    shortcut: 'I',
  },
  {
    id: 'summarize',
    label: 'Summarize',
    description: 'Key points only',
    shortcut: 'S',
  },
  {
    id: 'translate',
    label: 'Translate',
    description: 'Change language',
    shortcut: 'T',
  },
  {
    id: 'explain-code',
    label: 'Explain Code',
    description: 'Break it down',
    shortcut: 'C',
  },
  {
    id: 'custom-prompt',
    label: 'Custom Prompt',
    description: 'Freeform ask',
    shortcut: 'P',
  },
] as const;

export const MIN_SELECTION_LENGTH = 1;

/** Keep the trigger close to the selection without covering it. */
export const TRIGGER_OFFSET_PX = 6;
export const MENU_OFFSET_PX = 8;
