"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";

type Platform = "myhome" | "ssge";

interface LinkedAccount {
  email: string;
  isVerified: boolean;
  lastLoginAt: string | null;
}

const PLATFORMS: Record<
  Platform,
  {
    label: string;
    apiPath: string;
    accent: "emerald" | "violet";
    description: string;
    howItWorks: string;
  }
> = {
  myhome: {
    label: "myhome.ge",
    apiPath: "/api/myhome/link",
    accent: "emerald",
    description:
      "Connect myhome.ge so parsed listings can be pre-filled and published automatically.",
    howItWorks:
      "We log into myhome.ge in a browser to verify your credentials. Your encrypted password is only used when posting listings.",
  },
  ssge: {
    label: "ss.ge",
    apiPath: "/api/ssge/link",
    accent: "violet",
    description:
      "Connect ss.ge so parsed listings can be pre-filled on the platform step by step.",
    howItWorks:
      "We log into ss.ge in a browser to verify your credentials. Your encrypted password is only used when pre-filling listings.",
  },
};

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div
        className="animate-spin w-8 h-8 border-[3px] border-slate-200 border-t-slate-900 rounded-full"
        role="status"
        aria-label="Loading"
      />
      <p className="text-sm text-slate-500">Loading account status…</p>
    </div>
  );
}

function LinkedAccountPanel({
  platform,
  account,
  onEdit,
  onUnlink,
  unlinking,
}: {
  platform: Platform;
  account: LinkedAccount;
  onEdit: () => void;
  onUnlink: () => void;
  unlinking: boolean;
}) {
  const config = PLATFORMS[platform];
  const accentRing = config.accent === "emerald" ? "ring-emerald-600/15" : "ring-violet-600/15";
  const accentBg = config.accent === "emerald" ? "from-emerald-500 to-emerald-700" : "from-violet-500 to-violet-700";
  const accentIconBg = config.accent === "emerald" ? "bg-emerald-50 text-emerald-600" : "bg-violet-50 text-violet-600";

  return (
    <div className="card p-0 overflow-hidden">
      <div className={cn("h-1.5 bg-gradient-to-r", accentBg)} aria-hidden="true" />

      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3">
          <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", accentIconBg)}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Linked account</p>
            <p className="font-semibold text-slate-900 dark:text-slate-50 mt-0.5">{config.label}</p>
            <span className={cn("badge badge-posted mt-2 ring-1 ring-inset", accentRing)}>Connected</span>
          </div>
        </div>

        <dl className="space-y-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700 p-4">
          <div>
            <dt className="text-xs font-medium text-slate-400">Email</dt>
            <dd className="text-sm font-medium text-slate-900 dark:text-slate-100 mt-0.5 break-all">{account.email}</dd>
          </div>
          {account.lastLoginAt && (
            <div>
              <dt className="text-xs font-medium text-slate-400">Last verified</dt>
              <dd className="text-sm text-slate-700 dark:text-slate-300 mt-0.5 tabular-nums">
                {new Date(account.lastLoginAt).toLocaleString()}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-medium text-slate-400">Password</dt>
            <dd className="text-sm text-slate-500 mt-0.5">Stored encrypted (AES-256)</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2">
          <button type="button" onClick={onEdit} className="btn-secondary w-full">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit credentials
          </button>
          <button
            type="button"
            onClick={onUnlink}
            disabled={unlinking}
            className="btn-outline-danger w-full"
          >
            {unlinking ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Unlinking…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                Unlink account
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyAccountPanel({ platform }: { platform: Platform }) {
  const config = PLATFORMS[platform];

  return (
    <div className="card flex flex-col items-center text-center py-10 px-6">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 mb-4">
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      </div>
      <p className="font-semibold text-slate-900 dark:text-slate-50">No account linked</p>
      <p className="text-sm text-slate-500 mt-2 leading-relaxed">
        Sign in to {config.label} on the left to connect your account.
      </p>
    </div>
  );
}

function PlatformForm({
  platform,
  account,
  isEditing,
  onCancelEdit,
  onAccountChange,
}: {
  platform: Platform;
  account: LinkedAccount | null;
  isEditing: boolean;
  onCancelEdit: () => void;
  onAccountChange: (account: LinkedAccount | null) => void;
}) {
  const config = PLATFORMS[platform];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const showForm = !account?.isVerified || isEditing;

  useEffect(() => {
    setEmail(account?.email ?? "");
    setPassword("");
  }, [account, platform, isEditing]);

  async function handleLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch(config.apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to link account");
        return;
      }

      toast.success(`${config.label} account linked successfully`);
      onAccountChange({
        email,
        isVerified: true,
        lastLoginAt: new Date().toISOString(),
      });
      setPassword("");
      onCancelEdit();
    } catch {
      toast.error("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const submitClass = config.accent === "emerald" ? "btn-success" : "btn-platform-ssge";

  if (!showForm) {
    return (
      <div className="space-y-5">
        <div className="card">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">{config.label} is connected</h2>
              <p className="text-sm text-slate-500 mt-1 leading-relaxed">
                Your account is ready for one-click pre-fill. Manage credentials from the panel on the right.
              </p>
            </div>
          </div>
        </div>

        <div className="card-muted text-sm text-slate-600 leading-relaxed">
          <span className="font-semibold text-slate-800">How it works: </span>
          {config.howItWorks}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {isEditing ? "Update credentials" : `Sign in to ${config.label}`}
            </h2>
            <p className="text-sm text-slate-500 mt-1">{config.description}</p>
          </div>
          {isEditing && (
            <button type="button" onClick={onCancelEdit} className="btn-ghost text-sm shrink-0">
              Cancel
            </button>
          )}
        </div>

        <form onSubmit={handleLink} className="space-y-4 mt-5">
          <div>
            <label htmlFor={`${platform}-email`} className="block text-sm font-medium text-slate-700 mb-1.5">
              Email
            </label>
            <input
              id={`${platform}-email`}
              type="email"
              className="input"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div>
            <label htmlFor={`${platform}-password`} className="block text-sm font-medium text-slate-700 mb-1.5">
              Password
            </label>
            <input
              id={`${platform}-password`}
              type="password"
              className="input"
              placeholder={`Your ${config.label} password`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
            <p className="text-xs text-slate-400 mt-1.5">
              Encrypted with AES-256 before storage. Never shared.
            </p>
          </div>

          <button type="submit" className={cn(submitClass, "w-full sm:w-auto")} disabled={loading}>
            {loading ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Verifying…
              </>
            ) : isEditing ? (
              "Save & verify"
            ) : (
              "Link account"
            )}
          </button>
        </form>
      </div>

      <div className="card-muted text-sm text-slate-600 leading-relaxed">
        <span className="font-semibold text-slate-800">How it works: </span>
        {config.howItWorks}
      </div>
    </div>
  );
}

export default function LinkAccountsClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tabParam = searchParams.get("tab");
  const activeTab: Platform = tabParam === "ssge" ? "ssge" : "myhome";

  const [fetching, setFetching] = useState(true);
  const [editing, setEditing] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [accounts, setAccounts] = useState<Record<Platform, LinkedAccount | null>>({
    myhome: null,
    ssge: null,
  });

  const loadAccounts = useCallback(async () => {
    setFetching(true);
    try {
      const [myhomeRes, ssgeRes] = await Promise.all([
        fetch("/api/myhome/link"),
        fetch("/api/ssge/link"),
      ]);
      const [myhomeData, ssgeData] = await Promise.all([myhomeRes.json(), ssgeRes.json()]);

      setAccounts({
        myhome: myhomeData.account
          ? {
              email: myhomeData.account.myhomeEmail,
              isVerified: myhomeData.account.isVerified,
              lastLoginAt: myhomeData.account.lastLoginAt,
            }
          : null,
        ssge: ssgeData.account
          ? {
              email: ssgeData.account.ssgeEmail,
              isVerified: ssgeData.account.isVerified,
              lastLoginAt: ssgeData.account.lastLoginAt,
            }
          : null,
      });
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    setEditing(false);
  }, [activeTab]);

  function setTab(tab: Platform) {
    router.replace(tab === "myhome" ? "/dashboard/link-account" : "/dashboard/link-account?tab=ssge", {
      scroll: false,
    });
  }

  async function handleUnlink() {
    const config = PLATFORMS[activeTab];
    if (!confirm(`Unlink your ${config.label} account?`)) return;

    setUnlinking(true);
    try {
      const res = await fetch(config.apiPath, { method: "DELETE" });
      if (res.ok) {
        toast.success("Account unlinked");
        setAccounts((prev) => ({ ...prev, [activeTab]: null }));
        setEditing(false);
      } else {
        toast.error("Failed to unlink account");
      }
    } finally {
      setUnlinking(false);
    }
  }

  const linkedCount = [accounts.myhome?.isVerified, accounts.ssge?.isVerified].filter(Boolean).length;
  const activeAccount = accounts[activeTab];

  if (fetching) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-8">
      <div className="page-header">
        <div>
          <p className="section-title mb-2">Settings</p>
          <h1 className="page-title">Platform accounts</h1>
          <p className="page-subtitle">
            Link publishing platforms to enable one-click pre-fill from your parsed listings.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="badge badge-posted">{linkedCount}/2 linked</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="tablist" aria-label="Platform selection">
        {(["myhome", "ssge"] as Platform[]).map((p) => {
          const config = PLATFORMS[p];
          const linked = accounts[p]?.isVerified;
          const isActive = activeTab === p;

          return (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(p)}
              className={cn(
                "text-left rounded-2xl border p-4 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2",
                isActive
                  ? "border-slate-900 bg-slate-900 dark:border-slate-100 dark:bg-slate-100 text-white dark:text-slate-900 shadow-md"
                  : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn("font-semibold", isActive ? "text-white dark:text-slate-900" : "text-slate-900 dark:text-slate-100")}>
                  {config.label}
                </span>
                <span
                  className={cn(
                    "badge text-[10px]",
                    linked
                      ? isActive
                        ? "bg-white/20 text-white ring-white/30 dark:bg-slate-900/20 dark:text-slate-900 dark:ring-slate-900/30"
                        : "badge-posted"
                      : isActive
                      ? "bg-white/10 text-white/80 ring-white/20 dark:bg-slate-900/10 dark:text-slate-700 dark:ring-slate-900/20"
                      : "badge-pending"
                  )}
                >
                  {linked ? "Linked" : "Not linked"}
                </span>
              </div>
              {accounts[p]?.email && (
                <p className={cn("text-xs mt-2 truncate", isActive ? "text-white/70 dark:text-slate-600" : "text-slate-500 dark:text-slate-400")}>
                  {accounts[p]!.email}
                </p>
              )}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        <div role="tabpanel" aria-label={PLATFORMS[activeTab].label}>
          <PlatformForm
            platform={activeTab}
            account={activeAccount}
            isEditing={editing}
            onCancelEdit={() => setEditing(false)}
            onAccountChange={(account) =>
              setAccounts((prev) => ({ ...prev, [activeTab]: account }))
            }
          />
        </div>

        <aside className="panel-sticky" aria-label="Linked account">
          {activeAccount?.isVerified ? (
            <LinkedAccountPanel
              platform={activeTab}
              account={activeAccount}
              onEdit={() => setEditing(true)}
              onUnlink={handleUnlink}
              unlinking={unlinking}
            />
          ) : (
            <EmptyAccountPanel platform={activeTab} />
          )}
        </aside>
      </div>
    </div>
  );
}
