import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import ListingDetail from "./ListingDetail";

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { id } = await params;

  const listing = await db.parsedListing.findFirst({
    where: { id, userId: user.id },
  });

  if (!listing) {
    redirect("/dashboard");
  }

  return (
    <ListingDetail
      listing={JSON.parse(JSON.stringify(listing))}
    />
  );
}
