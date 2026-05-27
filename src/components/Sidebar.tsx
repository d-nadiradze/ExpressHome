"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import ThemeToggle from "@/components/ThemeToggle";

interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  myhomeAccount?: {
    myhomeEmail: string;
    isVerified: boolean;
  } | null;
  ssgeAccount?: {
    ssgeEmail: string;
    isVerified: boolean;
  } | null;
}

const mainNavItems = [
  {
    href: "/dashboard",
    label: "Dashboard",
    match: (path: string) => path === "/dashboard",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
  },
  {
    href: "/dashboard/parse",
    label: "Parse listing",
    match: (path: string) => path.startsWith("/dashboard/parse"),
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
  },
];

const settingsNavItems = [
  {
    href: "/dashboard/link-account",
    label: "Platform accounts",
    match: (path: string) =>
      path.startsWith("/dashboard/link-account") || path.startsWith("/dashboard/link-ssge-account"),
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
    ),
  },
];

const adminNavItems = [
  {
    href: "/admin",
    label: "User management",
    match: (path: string) => path.startsWith("/admin"),
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
    ),
  },
];

function NavSection({
  title,
  items,
  pathname,
  trailing,
}: {
  title?: string;
  items: typeof mainNavItems;
  pathname: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div>
      {title && (
        <p className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {title}
        </p>
      )}
      <div className="space-y-0.5">
        {items.map((item) => {
          const isActive = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn("nav-item", isActive ? "nav-item-active" : "nav-item-inactive")}
              aria-current={isActive ? "page" : undefined}
            >
              <span className={cn(isActive ? "text-white dark:text-slate-900" : "text-slate-400 dark:text-slate-500")}>{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {trailing && item.href === "/dashboard/link-account" ? trailing : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function Sidebar({ user }: { user: User }) {
  const pathname = usePathname();
  const router = useRouter();

  const myhomeLinked = user.myhomeAccount?.isVerified;
  const ssgeLinked = user.ssgeAccount?.isVerified;
  const linkedCount = [myhomeLinked, ssgeLinked].filter(Boolean).length;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    toast.success("Logged out");
    router.push("/login");
    router.refresh();
  }

  const accountStatusTrailing =
    linkedCount < 2 ? (
      <span className="text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-700">
        {linkedCount}/2
      </span>
    ) : (
      <span className="w-2 h-2 rounded-full bg-emerald-400" aria-label="All platforms linked" />
    );

  return (
    <aside className="w-64 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200/80 dark:border-slate-800 flex flex-col">
      {/* Brand */}
      <div className="px-5 py-5 border-b border-slate-100 dark:border-slate-800">
        <Link href="/dashboard" className="flex items-center gap-3 group">
          <div className="w-9 h-9 bg-slate-900 dark:bg-white rounded-xl flex items-center justify-center shadow-sm transition-transform duration-200 group-hover:scale-105">
            <svg className="w-5 h-5 text-white dark:text-slate-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </div>
          <div>
            <span className="font-bold text-slate-900 dark:text-slate-50 tracking-tight">ExpressHome</span>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-none mt-0.5">Listing parser</p>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-5 space-y-6 overflow-y-auto">
        {user.role === "ADMIN" && (
          <NavSection title="Admin" items={adminNavItems} pathname={pathname} />
        )}
        <NavSection title="Workspace" items={mainNavItems} pathname={pathname} />
        <NavSection
          title="Settings"
          items={settingsNavItems}
          pathname={pathname}
          trailing={accountStatusTrailing}
        />
      </nav>

      {/* Platform status summary */}
      <div className="px-4 py-3 mx-3 mb-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700/60">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
          Platforms
        </p>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600 dark:text-slate-400">myhome.ge</span>
            <span className={cn("badge text-[10px]", myhomeLinked ? "badge-posted" : "badge-pending")}>
              {myhomeLinked ? "Linked" : "Not linked"}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600 dark:text-slate-400">ss.ge</span>
            <span className={cn("badge text-[10px]", ssgeLinked ? "badge-posted" : "badge-pending")}>
              {ssgeLinked ? "Linked" : "Not linked"}
            </span>
          </div>
        </div>
      </div>

      {/* User */}
      <div className="p-4 border-t border-slate-100 dark:border-slate-800 space-y-2">
        <ThemeToggle />
        <div className="flex items-center gap-3 mb-1 pt-1">
          <div className="w-9 h-9 bg-gradient-to-br from-slate-700 to-slate-900 dark:from-slate-600 dark:to-slate-800 rounded-full flex items-center justify-center text-white font-semibold text-sm shrink-0">
            {(user.name || user.email)[0].toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{user.name || user.email}</p>
            <p className="text-xs text-slate-400 truncate">{user.email}</p>
          </div>
          <span
            className={cn(
              "badge text-[10px] shrink-0",
              user.role === "ADMIN"
                ? "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-600/20"
                : user.role === "MODERATOR"
                ? "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-600/20"
                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
            )}
          >
            {user.role}
          </span>
        </div>

        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 dark:text-slate-400 dark:hover:text-red-400 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Sign out
        </button>
      </div>
    </aside>
  );
}
