import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import Sidebar from "@/components/Sidebar";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/dashboard");

  return (
    <div className="flex h-dvh bg-slate-50 dark:bg-slate-950">
      <Sidebar user={user} />
      <main className="flex-1 overflow-auto dashboard-bg">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">{children}</div>
      </main>
    </div>
  );
}
