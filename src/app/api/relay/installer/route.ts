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
  // Windows 7 ships TLS 1.0. Chrome has its own TLS 1.2, so the site opens,
  // but .NET WebClient cannot download until Schannel and .NET are switched
  // to TLS 1.2. Those registry values are read when the next process starts.
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
    `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.2\\Client" /v Enabled /t REG_DWORD /d 1 /f >nul 2>&1`,
    `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.2\\Client" /v DisabledByDefault /t REG_DWORD /d 0 /f >nul 2>&1`,
    `reg add "HKLM\\SOFTWARE\\Microsoft\\.NETFramework\\v4.0.30319" /v SchUseStrongCrypto /t REG_DWORD /d 1 /f >nul 2>&1`,
    `reg add "HKLM\\SOFTWARE\\Microsoft\\.NETFramework\\v4.0.30319" /v SystemDefaultTlsVersions /t REG_DWORD /d 1 /f >nul 2>&1`,
    `reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\.NETFramework\\v4.0.30319" /v SchUseStrongCrypto /t REG_DWORD /d 1 /f >nul 2>&1`,
    `reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\.NETFramework\\v4.0.30319" /v SystemDefaultTlsVersions /t REG_DWORD /d 1 /f >nul 2>&1`,
    `reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\WinHttp" /v DefaultSecureProtocols /t REG_DWORD /d 2560 /f >nul 2>&1`,
    `reg add "HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\WinHttp" /v DefaultSecureProtocols /t REG_DWORD /d 2560 /f >nul 2>&1`,
    // 4032 = Tls | Tls11 | Tls12. Enum.ToObject works when the name Tls12 is missing.
    `> "%EH_BOOTSTRAP%" echo $ErrorActionPreference = 'Stop'`,
    `>> "%EH_BOOTSTRAP%" echo try { [Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject([Net.SecurityProtocolType], 4032) } catch {}`,
    `>> "%EH_BOOTSTRAP%" echo $u = '%EH_RELAY_URL%/relay/install.ps1?t=' + (Get-Random)`,
    `>> "%EH_BOOTSTRAP%" echo (New-Object Net.WebClient).DownloadFile($u, '%EH_INSTALLER%')`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File "%EH_BOOTSTRAP%"`,
    `if exist "%EH_INSTALLER%" goto :run`,
    `echo  Could not download the installer.`,
    `echo  Windows 7 can open the site in Chrome, but setup needs TLS 1.2 in .NET.`,
    `echo  Install .NET Framework 4.8, run Windows Update, then open this file again.`,
    `goto :end`,
    ":run",
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
