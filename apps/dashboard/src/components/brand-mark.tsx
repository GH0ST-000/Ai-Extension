import { APP_NAME } from '@project-x/shared';

type BrandMarkProps = {
  size?: 'sm' | 'lg';
  showWordmark?: boolean;
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

export function BrandMark({ size = 'sm', showWordmark = true }: BrandMarkProps) {
  const box = SIZES[size];
  const radius = size === 'lg' ? 'rounded-2xl' : 'rounded-xl';

  return (
    <div className="flex items-center gap-3">
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
    </div>
  );
}
