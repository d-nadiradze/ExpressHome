/**
 * One-click Windows installer for the ss.ge token relay, personalised for the
 * signed-in user: a small .cmd that carries the server URL and this user's
 * relay token and runs the shared /relay/install.ps1 (portable Node, hidden
 * auto-starting scheduled task, self-updating client).
 *
 * The token is derived from SSGE_RELAY_SECRET (see mintUserRelayToken) and only
 * lets that PC mint the shared guest token and the user's own account token.
 *
 * The bootstrap PowerShell is written to a .ps1 file (not -Command) so cmd.exe
 * quoting cannot mangle it, and it avoids APIs missing on Windows 8.1 / .NET
 * 4.0 (Tls12 enum name, DateTimeOffset.ToUnixTimeSeconds).
 */
import { NextRequest, NextResponse } from "next/server";
import { publicUrl } from "@/lib/auth";
import { isRelayConfigured, mintUserRelayToken } from "@/lib/ssge-relay";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isRelayConfigured()) {
    return NextResponse.json(
      { error: "The ss.ge relay is not enabled on this server (SSGE_RELAY_SECRET is not set)." },
      { status: 404 }
    );
  }

  const origin = publicUrl("/", request).origin;
  const token = mintUserRelayToken(userId);
  // URL/token are [A-Za-z0-9.:/-]; nothing to escape for cmd or the tiny .ps1.
  const lines = [
    "@echo off",
    "title ExpressHome relay setup",
    "echo.",
    "echo  ExpressHome ss.ge relay - setup",
    "echo  ----------------------------------",
    "echo  Installing into %LOCALAPPDATA%\\ExpressHomeRelay ...",
    "echo.",
    `set "EH_RELAY_URL=${origin}"`,
    `set "EH_RELAY_TOKEN=${token}"`,
    `set "EH_INSTALLER=%TEMP%\\ExpressHomeRelay-install.ps1"`,
    `set "EH_BOOTSTRAP=%TEMP%\\ExpressHomeRelay-dl.ps1"`,
    // Tiny downloader: TLS 1.2 as numeric 3072 (named Tls12 is missing on
    // .NET 2.0/3.5 / PowerShell 2), no DateTimeOffset.ToUnixTimeSeconds.
    `> "%EH_BOOTSTRAP%" echo $ErrorActionPreference = 'Stop'`,
    `>> "%EH_BOOTSTRAP%" echo try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}`,
    `>> "%EH_BOOTSTRAP%" echo $u = '%EH_RELAY_URL%/relay/install.ps1?t=' + (Get-Random)`,
    `>> "%EH_BOOTSTRAP%" echo (New-Object Net.WebClient).DownloadFile($u, '%EH_INSTALLER%')`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File "%EH_BOOTSTRAP%"`,
    `if not exist "%EH_INSTALLER%" ( echo  Could not download the installer. Check your internet connection and try again. & goto :end )`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File "%EH_INSTALLER%"`,
    `if errorlevel 1 ( echo. & echo  Setup did not finish. Please send a screenshot of this window to support. )`,
    ":end",
    "echo.",
    "pause",
    "",
  ];
  const body = lines.join("\r\n");
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-bat; charset=us-ascii",
      "Content-Disposition": 'attachment; filename="ExpressHome-relay-setup.cmd"',
      "Cache-Control": "no-store",
    },
  });
}
