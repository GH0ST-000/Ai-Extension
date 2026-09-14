import type { SVGProps } from 'react';

import { cn } from '~/lib/utils/cn';

/** Compact brand mark matching the extension popup (ink / teal / amber). */
export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 128 128"
      aria-hidden
      className={cn('h-6 w-6 shrink-0 rounded-[7px]', className)}
      {...props}
    >
      <rect width="128" height="128" rx="32" fill="#0B1220" />
      <g fill="none" stroke="#14B8A6" strokeWidth="18" strokeLinecap="round">
        <path d="M34 34 L94 94" />
        <path d="M94 34 L34 94" />
      </g>
      <circle cx="94" cy="34" r="9" fill="#F59E0B" />
      <circle cx="94" cy="34" r="3.5" fill="#FFF7ED" fillOpacity="0.9" />
    </svg>
  );
}
