/**
 * Work hand-off for ss.ge token relay clients (src/relay/client.ts).
 *
 *   GET            → work to do (also records the relay heartbeat)
 *   GET ?status=1  → who am I / am I seen (used by the installer to confirm)
 *   POST           → results (tokens / errors)
 *
 * Authenticated with `Authorization: Bearer <token>` where the token is either
 * SSGE_RELAY_SECRET (admin relay) or a per-user token (see ssge-relay.ts),
 * not a user session — the middleware lets this path through. Returns 404
 * when no secret is configured so the endpoint is invisible without a relay.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  authenticateRelay,
  isRelayConfigured,
  isUserRelayAlive,
  isAdminRelayAlive,
  pullRelayWork,
  pushRelayResults,
  type RelayIdentity,
  type RelayResults,
} from "@/lib/ssge-relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function identify(
  request: NextRequest
): Promise<{ identity: RelayIdentity } | { denied: NextResponse }> {
  if (!isRelayConfigured()) {
    return { denied: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  const identity = await authenticateRelay(request.headers.get("authorization"));
  if (!identity) {
    return { denied: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { identity };
}

export async function GET(request: NextRequest) {
  const auth = await identify(request);
  if ("denied" in auth) return auth.denied;
  try {
    if (request.nextUrl.searchParams.get("status") === "1") {
      const { identity } = auth;
      const online =
        identity.kind === "admin" ? await isAdminRelayAlive() : await isUserRelayAlive(identity.id);
      return NextResponse.json(
        { ok: true, relay: identity, online },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    const work = await pullRelayWork(auth.identity);
    return NextResponse.json(work, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ss.ge relay] pull failed:", error);
    return NextResponse.json({ error: "relay pull failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await identify(request);
  if ("denied" in auth) return auth.denied;
  try {
    const body = (await request.json()) as RelayResults;
    const saved = await pushRelayResults(auth.identity, body ?? {});
    if (saved.guest || saved.accounts || saved.verifications || saved.pages) {
      console.log(
        `[ss.ge relay] received from ${auth.identity.id}: guest=${saved.guest} accounts=${saved.accounts} verifications=${saved.verifications} pages=${saved.pages}`
      );
    }
    return NextResponse.json({ ok: true, ...saved });
  } catch (error) {
    console.error("[ss.ge relay] push failed:", error);
    return NextResponse.json({ error: "relay push failed" }, { status: 500 });
  }
}
