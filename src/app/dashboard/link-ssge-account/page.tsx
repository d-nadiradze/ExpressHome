import { redirect } from "next/navigation";

export default function LinkSsgeAccountRedirect() {
  redirect("/dashboard/link-account?tab=ssge");
}
