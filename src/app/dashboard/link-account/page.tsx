"use client";

import { useState, useEffect } from "react";
import toast from "react-hot-toast";

interface MyhomeAccount {
  myhomeEmail: string;
  isVerified: boolean;
  lastLoginAt: string | null;
}

export default function LinkAccountPage() {
  const [account, setAccount] = useState<MyhomeAccount | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    fetch("/api/myhome/link")
      .then((r) => r.json())
      .then((d) => {
        if (d.account) {
          setAccount(d.account);
          setEmail(d.account.myhomeEmail);
        }
      })
      .finally(() => setFetching(false));
  }, []);

  async function handleLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch("/api/myhome/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to link account");
        return;
      }

      toast.success("myhome.ge account linked successfully!");
      setAccount({ myhomeEmail: email, isVerified: true, lastLoginAt: new Date().toISOString() });
      setPassword("");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleUnlink() {
    if (!confirm("Are you sure you want to unlink your myhome.ge account?")) return;

    const res = await fetch("/api/myhome/link", { method: "DELETE" });
    if (res.ok) {
      toast.success("Account unlinked");
      setAccount(null);
      setEmail("");
      setPassword("");
    }
  }

  if (fetching) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full" />
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Link myhome.ge Account</h1>
        <p className="text-gray-500 mt-1">
          Connect your myhome.ge credentials so the app can auto-publish parsed listings on your behalf.
        </p>
      </div>

      {account?.isVerified && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <svg className="w-5 h-5 text-green-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          <div>
            <p className="font-medium text-green-800">Account linked</p>
            <p className="text-sm text-green-700 mt-0.5">
              Logged in as <strong>{account.myhomeEmail}</strong>
            </p>
            {account.lastLoginAt && (
              <p className="text-xs text-green-600 mt-0.5">
                Last verified: {new Date(account.lastLoginAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <h2 className="font-semibold text-gray-900 mb-4">
          {account ? "Update credentials" : "Enter your myhome.ge credentials"}
        </h2>

        <form onSubmit={handleLink} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              myhome.ge Email
            </label>
            <input
              type="email"
              className="input"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              myhome.ge Password
            </label>
            <input
              type="password"
              className="input"
              placeholder="Your myhome.ge password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p className="text-xs text-gray-400 mt-1">
              Your password is encrypted with AES-256 before being stored.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              className="btn-primary flex-1 flex items-center justify-center gap-2"
              disabled={loading}
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Verifying...
                </>
              ) : account ? (
                "Update & Verify"
              ) : (
                "Link Account"
              )}
            </button>

            {account && (
              <button
                type="button"
                onClick={handleUnlink}
                className="btn-danger"
              >
                Unlink
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm text-blue-700">
        <strong>How it works:</strong> When you enter your credentials, the app logs into myhome.ge on your behalf using a browser to verify them. Your encrypted password is used only for posting new listings.
      </div>
    </div>
  );
}
