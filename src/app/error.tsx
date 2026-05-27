"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950">
      <div className="text-center space-y-4 card max-w-md">
        <h2 className="page-title text-xl">Something went wrong</h2>
        <p className="page-subtitle">{error.message}</p>
        <button onClick={reset} className="btn-primary">
          Try again
        </button>
      </div>
    </div>
  );
}
