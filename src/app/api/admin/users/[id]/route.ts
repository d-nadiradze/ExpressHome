import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getUserTokenUsageStatus,
  parseOptionalTokenLimit,
} from "@/lib/ai-token-usage";

// PATCH: update user role or status
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const role = request.headers.get("x-user-role");
  const currentUserId = request.headers.get("x-user-id");

  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const { name, userRole, isActive, aiTokenLimitHour, aiTokenLimitDay, aiTokenLimitMonth } =
      body;

    // Prevent admin from deactivating themselves
    if (id === currentUserId && isActive === false) {
      return NextResponse.json(
        { error: "Cannot deactivate your own account" },
        { status: 400 }
      );
    }

    let limitData: {
      aiTokenLimitHour?: number | null;
      aiTokenLimitDay?: number | null;
      aiTokenLimitMonth?: number | null;
    } = {};

    if (
      aiTokenLimitHour !== undefined ||
      aiTokenLimitDay !== undefined ||
      aiTokenLimitMonth !== undefined
    ) {
      limitData = {
        ...(aiTokenLimitHour !== undefined && {
          aiTokenLimitHour: parseOptionalTokenLimit(aiTokenLimitHour),
        }),
        ...(aiTokenLimitDay !== undefined && {
          aiTokenLimitDay: parseOptionalTokenLimit(aiTokenLimitDay),
        }),
        ...(aiTokenLimitMonth !== undefined && {
          aiTokenLimitMonth: parseOptionalTokenLimit(aiTokenLimitMonth),
        }),
      };
    }

    const user = await db.user.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(userRole !== undefined && { role: userRole }),
        ...(isActive !== undefined && { isActive }),
        ...limitData,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        aiTokenLimitHour: true,
        aiTokenLimitDay: true,
        aiTokenLimitMonth: true,
      },
    });

    // If user is deactivated, kill their session
    if (isActive === false) {
      await db.session.deleteMany({ where: { userId: id } });
    }

    return NextResponse.json({ user });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Token limits")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Update user error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE: remove a user
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const role = request.headers.get("x-user-role");
  const currentUserId = request.headers.get("x-user-id");

  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  if (id === currentUserId) {
    return NextResponse.json(
      { error: "Cannot delete your own account" },
      { status: 400 }
    );
  }

  try {
    await db.user.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete user error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET: get single user details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const role = request.headers.get("x-user-role");
  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const user = await db.user.findUnique({
    where: { id },
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
      updatedAt: true,
      myhomeAccount: {
        select: { myhomeEmail: true, isVerified: true, lastLoginAt: true },
      },
      _count: { select: { parsedListings: true } },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const aiTokenStatus = await getUserTokenUsageStatus(id);

  return NextResponse.json({ user, aiTokenStatus });
}
