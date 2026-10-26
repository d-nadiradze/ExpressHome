/**
 * ss.ge token relay — admin entry point for a repo checkout:
 *
 *   npx tsx scripts/ssge-token-relay.ts            # run forever
 *   npx tsx scripts/ssge-token-relay.ts --once     # one pass, then exit
 *
 * Config (env or `.env.relay` in the repo root — see .env.relay.example):
 *   SSGE_RELAY_URL     https://makler.solutions
 *   SSGE_RELAY_SECRET  same value as SSGE_RELAY_SECRET on the server
 *
 * The implementation lives in src/relay/client.ts so the Docker build can
 * bundle the same code into public/relay/ssge-relay.cjs for staff PCs.
 */
import "@/relay/client";
