/** Quick smoke test for API login (reads credentials from DB). */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { db } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { loginMyhomeApi } from "@/lib/myhome-api-prefill";

const email = process.argv[2];
if (!email) {
  console.error("Usage: npx tsx scripts/test-api-login.ts <myhome-email>");
  process.exit(1);
}

const account = await db.myhomeAccount.findFirst({
  where: { myhomeEmail: email, isVerified: true },
});
if (!account) {
  console.error("No verified account for", email);
  process.exit(1);
}

const result = await loginMyhomeApi({
  email: account.myhomeEmail,
  password: decrypt(account.myhomePassword),
});

console.log(result.success ? "OK — got tokens" : `FAIL: ${result.error}`);
if (result.session) {
  console.log("accessToken length:", result.session.accessToken.length);
}

await db.$disconnect();
