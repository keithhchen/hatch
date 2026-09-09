"""Run LibreOffice as an isolated, bounded Skill subprocess.

Windows launches ``soffice.bin`` behind ``soffice.exe``.  A completed
conversion can leave that child process alive while it still holds files in
the bundled LibreOffice tree.  Every invocation uses a unique profile, so the
Windows cleanup can terminate only the processes belonging to this call.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Mapping, Sequence


def run_libreoffice(
    command: Sequence[str],
    *,
    profile: Path,
    environment: Mapping[str, str],
    timeout: float = 300,
) -> subprocess.CompletedProcess[str]:
    """Run LibreOffice and release any platform-specific child processes."""

    # A relative socket name avoids macOS sockaddr_un path-length limits even
    # when the runner's private temp root is long. All caller file arguments
    # must be absolute before changing cwd; never use the shared /tmp namespace.
    profile = profile.resolve(strict=True)
    child_environment = dict(environment)
    if os.name != "nt":
        child_environment["OSL_SOCKET_PATH"] = "."
    process = subprocess.Popen(
        list(command),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=child_environment,
        cwd=profile,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _terminate_process_tree(process.pid)
        try:
            process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        raise
    finally:
        _terminate_profile_processes(profile)

    if process.returncode != 0 and not (stdout.strip() or stderr.strip()):
        stderr = f"LibreOffice exited with code {process.returncode} without diagnostic output"
        if process.returncode < 0:
            stderr += f" (terminated by signal {-process.returncode})"

    return subprocess.CompletedProcess(
        process.args,
        process.returncode,
        stdout,
        stderr,
    )


def _terminate_process_tree(pid: int) -> None:
    if os.name != "nt":
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        return

    taskkill = shutil.which("taskkill.exe") or "taskkill.exe"
    subprocess.run(
        [taskkill, "/PID", str(pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=15,
    )


def _terminate_profile_processes(profile: Path) -> None:
    if os.name != "nt":
        return

    powershell = shutil.which("pwsh.exe") or shutil.which("powershell.exe")
    if not powershell:
        return

    cleanup_environment = os.environ.copy()
    cleanup_environment["HATCH_LO_PROFILE_TO_CLEAN"] = str(profile)
    script = r"""
$profile = $env:HATCH_LO_PROFILE_TO_CLEAN
if (-not $profile) { exit 0 }
$profile = [System.IO.Path]::GetFullPath($profile).Replace('\', '/').TrimEnd('/')
$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(soffice|soffice\.bin)(\.exe)?$' }
foreach ($process in $processes) {
  $commandLine = [string]$process.CommandLine
  if ($commandLine -and $commandLine.Replace('\', '/').IndexOf($profile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
"""
    for _ in range(3):
        subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
            env=cleanup_environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=15,
        )
        time.sleep(0.15)
