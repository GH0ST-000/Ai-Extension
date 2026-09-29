import type { SVGProps } from 'react';

import { cn } from '~/lib/utils/cn';

/** Compact brand mark matching the extension popup (ink / teal / amber). */
export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 128 128"
      aria-hidden
      className={cn('h-6 w-6 shrink-0 rounded-[9px]', className)}
      {...props}
    >
      <defs>
        <linearGradient
          id="pxPlate"
          x1="20"
          y1="8"
          x2="108"
          y2="120"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#141C2E" />
          <stop offset="100%" stopColor="#0B1220" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="36" fill="url(#pxPlate)" />
      <rect
        x="3"
        y="3"
        width="122"
        height="122"
        rx="33"
        fill="none"
        stroke="#14B8A6"
        strokeOpacity="0.35"
        strokeWidth="3"
      />
      <g fill="none" stroke="#14B8A6" strokeWidth="14" strokeLinecap="round">
        <path d="M36 36 L92 92" />
        <path d="M92 36 L36 92" />
      </g>
      <circle cx="92" cy="36" r="8" fill="#F59E0B" />
      <circle cx="92" cy="36" r="3" fill="#FFF7ED" fillOpacity="0.92" />
    </svg>
  );
}
