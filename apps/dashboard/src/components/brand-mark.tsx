import { APP_NAME } from '@project-x/shared';

type BrandMarkProps = {
  size?: 'sm' | 'lg';
  showWordmark?: boolean;
};

export function BrandMark({ size = 'sm', showWordmark = true }: BrandMarkProps) {
  const mark = size === 'lg' ? 'h-12 w-12 rounded-2xl text-lg' : 'h-9 w-9 rounded-xl text-sm';

  return (
    <div className="flex items-center gap-3">
      <div
        className={`relative flex shrink-0 items-center justify-center bg-ink text-white shadow-soft ${mark}`}
        aria-hidden
      >
        <span className="font-display font-bold tracking-tight">X</span>
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-spark" />
      </div>
      {showWordmark ? (
        <div className="min-w-0">
          <p className="font-display text-[15px] font-semibold tracking-tight text-ink">
            {APP_NAME}
          </p>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Studio
          </p>
        </div>
      ) : null}
    </div>
  );
}
