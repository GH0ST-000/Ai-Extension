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
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.02 * index, duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        whileHover={{ x: 2 }}
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
          'group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left',
          'text-primary transition-colors duration-150',
          'hover:bg-hover focus-visible:bg-active active:bg-active',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
        )}
      >
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
            'bg-icon text-accent ring-1 ring-accent/15',
            'transition-all duration-150 group-hover:bg-accent-soft group-hover:ring-accent/30',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold leading-4 tracking-[-0.01em]">
            {action.label}
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] leading-tight text-muted">
            {action.description}
          </span>
        </span>
        {action.shortcut ? (
          <kbd
            className={cn(
              'ml-auto shrink-0 rounded-md px-1.5 py-1',
              'border border-border bg-kbd font-sans text-[10px] font-semibold leading-none',
              'text-kbd-foreground transition-colors group-hover:border-amber/40 group-hover:text-amber',
            )}
          >
            {action.shortcut}
          </kbd>
        ) : null}
      </motion.button>
    );
  },
);
