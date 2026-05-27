import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import Link from "next/link";
import DashboardListings from "./DashboardListings";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const listings = await db.parsedListing.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      price: true,
      currency: true,
      description: true,
      address: true,
      area: true,
      rooms: true,
      floor: true,
      totalFloors: true,
      postStatus: true,
      postUrl: true,
      ssgePostStatus: true,
      sourceUrl: true,
      images: true,
      rawData: true,
      createdAt: true,
    },
  });

  const stats = {
    total: await db.parsedListing.count({ where: { userId: user.id } }),
    posted: await db.parsedListing.count({
      where: { userId: user.id, postStatus: "POSTED" },
    }),
    pending: await db.parsedListing.count({
      where: { userId: user.id, postStatus: "PENDING" },
    }),
  };

  const hasMyHomeAccount = !!user.myhomeAccount;
  const firstName = user.name?.split(" ")[0] || user.email.split("@")[0];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="page-header">
        <div>
          <p className="section-title mb-2">Overview</p>
          <h1 className="page-title">Welcome back, {firstName}</h1>
          <p className="page-subtitle">
            Parse listings once, publish to myhome.ge and ss.ge from one place.
          </p>
        </div>
        <Link href="/dashboard/parse" className="btn-primary shrink-0">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Parse new listing
        </Link>
      </div>

      {/* Account warning */}
      {!hasMyHomeAccount && (
        <div
          className="rounded-2xl border border-amber-200/80 bg-gradient-to-r from-amber-50 to-orange-50 p-5 flex items-start gap-4"
          role="alert"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-amber-900">myhome.ge account not linked</p>
            <p className="text-sm text-amber-800/90 mt-1 leading-relaxed">
              Connect your account to auto-publish parsed listings without manual copy-paste.
            </p>
            <Link
              href="/dashboard/link-account"
              className="inline-flex items-center gap-1 mt-3 text-sm font-semibold text-amber-900 hover:text-amber-950 underline-offset-2 hover:underline"
            >
              Link account
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      )}

      {/* Stats bento */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="stat-card">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <div>
            <p className="text-3xl font-bold tabular-nums text-slate-900">{stats.total}</p>
            <p className="text-sm text-slate-500 mt-0.5">Total parsed</p>
          </div>
        </div>

        <div className="stat-card">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-3xl font-bold tabular-nums text-emerald-700">{stats.posted}</p>
            <p className="text-sm text-slate-500 mt-0.5">Posted to myhome</p>
          </div>
        </div>

        <div className="stat-card">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-3xl font-bold tabular-nums text-amber-700">{stats.pending}</p>
            <p className="text-sm text-slate-500 mt-0.5">Awaiting publish</p>
          </div>
        </div>
      </div>

      <DashboardListings initialListings={JSON.parse(JSON.stringify(listings))} />
    </div>
  );
}
