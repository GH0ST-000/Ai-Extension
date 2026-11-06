export default function DashboardLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading page…</span>
      <div className="h-8 w-48 animate-pulse rounded-xl bg-mist" />
      <div className="h-4 w-72 max-w-full animate-pulse rounded-lg bg-mist/80" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-36 animate-pulse rounded-2xl border border-line bg-mist/60" />
        <div className="h-36 animate-pulse rounded-2xl border border-line bg-mist/60" />
      </div>
      <div className="h-48 animate-pulse rounded-2xl border border-line bg-mist/50" />
    </div>
  );
}
