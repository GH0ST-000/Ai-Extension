import { forwardRef } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

import { AI_ACTIONS } from '../constants';
import type { AiActionDefinition } from '../types';
import { ActionMenuItem } from './action-menu-item';

type ActionMenuProps = {
  onSelect: (action: AiActionDefinition) => void;
};

export const ActionMenu = forwardRef<HTMLDivElement, ActionMenuProps>(function ActionMenu(
  { onSelect },
  ref,
) {
  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label="Project X actions"
      initial={{ opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.55 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'pointer-events-auto w-[280px] overflow-hidden rounded-[12px] p-1',
        'bg-elevated text-primary shadow-menu backdrop-blur-2xl',
        'border border-border',
      )}
    >
      <div className="px-2 pb-1 pt-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Actions</p>
      </div>
      <div className="flex flex-col">
        {AI_ACTIONS.map((action, index) => (
          <ActionMenuItem key={action.id} action={action} index={index} onSelect={onSelect} />
        ))}
      </div>
    </motion.div>
  );
});
