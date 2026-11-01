import { Bot, Loader2 } from 'lucide-react';

export default function AgentsLoading() {
  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary animate-pulse" />
        <div className="h-7 w-32 animate-pulse rounded-md bg-muted/60" />
      </div>
      <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded-md bg-muted/40" />

      <div className="mt-6 space-y-6">
        {/* Skeleton Tab Bar */}
        <div className="flex items-center gap-2 border-b border-border/40 pb-2">
          <div className="h-9 w-28 animate-pulse rounded-md bg-muted/60" />
          <div className="h-9 w-24 animate-pulse rounded-md bg-muted/40" />
          <div className="h-9 w-24 animate-pulse rounded-md bg-muted/40" />
        </div>

        {/* Skeleton Content Card with Loader Spinner */}
        <div className="flex min-h-[380px] flex-col items-center justify-center rounded-xl border border-border/60 bg-card/40 p-8 shadow-xs backdrop-blur-xs">
          <div className="relative flex items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl animate-pulse" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 border border-primary/20 shadow-inner">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            </div>
          </div>
          <h3 className="mt-4 text-base font-semibold text-foreground">
            Loading AI Agent...
          </h3>
          <p className="mt-1 text-xs text-muted-foreground animate-pulse">
            Initializing AI Agent environment
          </p>
        </div>
      </div>
    </div>
  );
}
