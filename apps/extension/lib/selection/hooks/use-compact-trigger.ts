import { useEffect, useState } from 'react';

import type { SelectionRect } from '../types';

const NARROW_VIEWPORT_PX = 480;
const EDGE_GUTTER_PX = 88;

/**
 * Compact (icon-only) trigger when the viewport is narrow
 * or the selection sits too close to a horizontal edge.
 */
export function useCompactTrigger(anchorRect: SelectionRect | null): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const update = () => {
      const viewportWidth = window.innerWidth;
      const narrowViewport = viewportWidth < NARROW_VIEWPORT_PX;

      if (!anchorRect) {
        setCompact(narrowViewport);
        return;
      }

      const spaceLeft = anchorRect.left;
      const spaceRight = viewportWidth - anchorRect.right;
      const nearEdge = Math.min(spaceLeft, spaceRight) < EDGE_GUTTER_PX;

      setCompact(narrowViewport || nearEdge);
    };

    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchorRect]);

  return compact;
}
