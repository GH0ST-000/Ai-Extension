import { forwardRef } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

import type { AiActionDefinition } from '../types';
import { ACTION_ICONS } from './action-icons';

type ActionMenuItemProps = {
  action: AiActionDefinition;
  index: number;
  onSelect: (action: AiActionDefinition) => void;
};

export const ActionMenuItem = forwardRef<HTMLButtonElement, ActionMenuItemProps>(
  function ActionMenuItem({ action, index, onSelect }, ref) {
    const Icon = ACTION_ICONS[action.id];

    return (
      <motion.button
        ref={ref}
        type="button"
        role="menuitem"
        initial={{ opacity: 0, y: 2 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.018 * index, duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect(action);
        }}
        className={cn(
          'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
          'text-primary transition-colors duration-100',
          'hover:bg-hover focus-visible:bg-active active:bg-active',
          'outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-icon text-secondary transition-colors group-hover:text-accent">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium leading-4 tracking-tight">
            {action.label}
          </span>
          <span className="mt-px block truncate text-[11px] leading-tight text-muted">
            {action.description}
          </span>
        </span>
        {action.shortcut ? (
          <kbd
            className={cn(
              'ml-auto shrink-0 rounded px-1.5 py-0.5',
              'border border-border bg-kbd font-sans text-[10px] font-medium leading-none',
              'text-kbd-foreground',
            )}
          >
            {action.shortcut}
          </kbd>
        ) : null}
      </motion.button>
    );
  },
);
