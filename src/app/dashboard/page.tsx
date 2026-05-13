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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-500 mt-1">
            Welcome back, {user.name || user.email}
          </p>
        </div>
        <Link href="/dashboard/parse" className="btn-primary">
          + Parse New Listing
        </Link>
      </div>

      {/* Myhome account warning */}
      {!hasMyHomeAccount && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div>
            <p className="font-medium text-amber-800">myhome.ge account not linked</p>
            <p className="text-sm text-amber-700 mt-0.5">
              Link your myhome.ge account to auto-publish parsed listings.{" "}
              <Link href="/dashboard/link-account" className="underline font-medium">
                Link now →
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card text-center">
          <p className="text-3xl font-bold text-blue-600">{stats.total}</p>
          <p className="text-sm text-gray-500 mt-1">Total Parsed</p>
        </div>
        <div className="card text-center">
          <p className="text-3xl font-bold text-green-600">{stats.posted}</p>
          <p className="text-sm text-gray-500 mt-1">Posted</p>
        </div>
        <div className="card text-center">
          <p className="text-3xl font-bold text-yellow-600">{stats.pending}</p>
          <p className="text-sm text-gray-500 mt-1">Pending</p>
        </div>
      </div>

      {/* Listings (interactive client component) */}
      <DashboardListings initialListings={JSON.parse(JSON.stringify(listings))} />
    </div>
  );
}
