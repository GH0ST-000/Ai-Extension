import Link from 'next/link';

import { APP_NAME } from '@project-x/shared';

type BrandMarkProps = {
  size?: 'sm' | 'lg';
  showWordmark?: boolean;
  /** Defaults to landing `/`. Pass `null` to render without a link. */
  href?: string | null;
};

const SIZES = {
  sm: 36,
  lg: 52,
} as const;

/** Original Project X mark — crossing signal beams + spark node. */
export function BrandGlyph({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
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

function BrandMarkInner({ size, showWordmark }: { size: 'sm' | 'lg'; showWordmark: boolean }) {
  const box = SIZES[size];
  const radius = size === 'lg' ? 'rounded-2xl' : 'rounded-xl';

  return (
    <>
      <BrandGlyph size={box} className={`shrink-0 shadow-soft ${radius}`} />
      {showWordmark ? (
        <div className="min-w-0">
          <p className="font-display text-[15px] font-semibold leading-tight tracking-tight text-ink">
            {APP_NAME}
          </p>
          <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Studio
          </p>
        </div>
      ) : null}
    </>
  );
}

export function BrandMark({ size = 'sm', showWordmark = true, href = '/' }: BrandMarkProps) {
  const className = 'flex items-center gap-3 transition hover:opacity-90';

  if (href == null) {
    return (
      <div className={className}>
        <BrandMarkInner size={size} showWordmark={showWordmark} />
      </div>
    );
  }

  return (
    <Link href={href} className={className} aria-label={`${APP_NAME} home`}>
      <BrandMarkInner size={size} showWordmark={showWordmark} />
    </Link>
  );
}
