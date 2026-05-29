import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  assertUserTokenLimit,
  recordAiTokenUsage,
  TokenLimitError,
} from "@/lib/ai-token-usage";
import {
  suggestListingDescription,
  DescriptionAiError,
  descriptionAiErrorStatus,
  type DescriptionListingContext,
  type DescriptionSuggestMode,
} from "@/lib/description-ai";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const listing = await db.parsedListing.findFirst({
    where: { id, userId },
  });

  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  try {
    const body = await request.json();
    const mode: DescriptionSuggestMode = "improve";

    const context: DescriptionListingContext = {
      currentDescription: body.currentDescription ?? listing.description ?? undefined,
    };

    const descriptionText = context.currentDescription?.trim() || "";
    if (descriptionText) {
      await assertUserTokenLimit(userId);
    }

    const result = await suggestListingDescription(context, mode);

    if (result.source === "openai" && result.tokensUsed) {
      await recordAiTokenUsage(userId, result.tokensUsed);
    }

    return NextResponse.json({
      description: result.description,
      mode,
      source: result.source,
      warning: result.warning,
    });
  } catch (error) {
    if (error instanceof TokenLimitError) {
      return NextResponse.json(
        { error: error.message, code: error.code, period: error.period },
        { status: 429 }
      );
    }

    if (error instanceof DescriptionAiError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: descriptionAiErrorStatus(error.code) }
      );
    }

    const message =
      error instanceof Error ? error.message : "Failed to generate description";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
