import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getBulkTokenUsageSummaries } from "@/lib/ai-token-usage";
import bcrypt from "bcryptjs";

// GET: list all users
export async function GET(request: NextRequest) {
  const role = request.headers.get("x-user-role");
  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");
  const skip = (page - 1) * limit;
  const listingStart = searchParams.get("listingStart");
  const listingEnd = searchParams.get("listingEnd");

  const parseDate = (value: string | null): Date | null => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const startDate = parseDate(listingStart);
  const endDate = parseDate(listingEnd);

  if ((listingStart && !startDate) || (listingEnd && !endDate)) {
    return NextResponse.json({ error: "Invalid listing date filters" }, { status: 400 });
  }

  const [users, total] = await Promise.all([
    db.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        aiTokenLimitHour: true,
        aiTokenLimitDay: true,
        aiTokenLimitMonth: true,
        createdAt: true,
        _count: { select: { parsedListings: true } },
        myhomeAccount: { select: { myhomeEmail: true, isVerified: true } },
      },
    }),
    db.user.count(),
  ]);

  const userIds = users.map((u) => u.id);
  const [dateRangeCounts, allTimeCounts, listingBounds] = await Promise.all([
    db.parsedListing.groupBy({
      by: ["userId"],
      where: {
        userId: { in: userIds },
        ...(startDate || endDate
          ? {
              createdAt: {
                ...(startDate ? { gte: startDate } : {}),
                ...(endDate ? { lte: endDate } : {}),
              },
            }
          : {}),
      },
      _count: { _all: true },
    }),
    db.parsedListing.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds } },
      _count: { _all: true },
    }),
    db.parsedListing.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds } },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
  ]);

  const rangeCountMap = new Map(dateRangeCounts.map((row) => [row.userId, row._count._all]));
  const allTimeCountMap = new Map(allTimeCounts.map((row) => [row.userId, row._count._all]));
  const boundsMap = new Map(
    listingBounds.map((row) => [
      row.userId,
      {
        firstUploadAt: row._min.createdAt?.toISOString() ?? null,
        lastUploadAt: row._max.createdAt?.toISOString() ?? null,
      },
    ])
  );

  const usageByUser = await getBulkTokenUsageSummaries(users.map((u) => u.id));
  const usersWithUsage = users.map((user) => ({
    ...user,
    aiTokenUsage: usageByUser[user.id] ?? { hour: 0, day: 0, month: 0 },
    listingStats: {
      total: allTimeCountMap.get(user.id) ?? 0,
      inRange: rangeCountMap.get(user.id) ?? 0,
      ...(boundsMap.get(user.id) ?? { firstUploadAt: null, lastUploadAt: null }),
    },
  }));

  return NextResponse.json({
    users: usersWithUsage,
    total,
    page,
    limit,
    listingFilter: {
      start: startDate?.toISOString() ?? null,
      end: endDate?.toISOString() ?? null,
    },
  });
}

// POST: create a new user (admin only)
export async function POST(request: NextRequest) {
  const role = request.headers.get("x-user-role");
  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { email, password, name, userRole } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "User already exists" },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.user.create({
      data: {
        email,
        passwordHash,
        name: name || null,
        role: userRole || "USER",
      },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    console.error("Admin create user error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
