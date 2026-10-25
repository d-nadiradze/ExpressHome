/**
 * Work hand-off for the ss.ge token relay client (scripts/ssge-token-relay.ts).
 *
 *   GET  → work to do (also records the relay heartbeat)
 *   POST → results (tokens / errors)
 *
 * Authenticated with `Authorization: Bearer $SSGE_RELAY_SECRET`, not a user
 * session — the middleware lets this path through. Returns 404 when no secret
 * is configured so the endpoint is invisible on deployments without a relay.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  isRelayConfigured,
  isValidRelaySecret,
  pullRelayWork,
  pushRelayResults,
  type RelayResults,
} from "@/lib/ssge-relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unauthorized(request: NextRequest): NextResponse | null {
  if (!isRelayConfigured()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!isValidRelaySecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;
  try {
    const work = await pullRelayWork();
    return NextResponse.json(work, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ss.ge relay] pull failed:", error);
    return NextResponse.json({ error: "relay pull failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;
  try {
    const body = (await request.json()) as RelayResults;
    const saved = await pushRelayResults(body ?? {});
    if (saved.guest || saved.accounts || saved.verifications) {
      console.log(
        `[ss.ge relay] received: guest=${saved.guest} accounts=${saved.accounts} verifications=${saved.verifications}`
      );
    }
    return NextResponse.json({ ok: true, ...saved });
  } catch (error) {
    console.error("[ss.ge relay] push failed:", error);
    return NextResponse.json({ error: "relay push failed" }, { status: 500 });
  }
}
