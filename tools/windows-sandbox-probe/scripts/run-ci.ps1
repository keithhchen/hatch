# Explicit provisioning ONLY on disposable GitHub-hosted Windows runners.
# Not a product installer; never use on a workstation/self-hosted runner.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Requires a disposable GitHub-hosted runner'
}
$username = 'HatchProbe_' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$accountSid = $null
$exitCode = 1
$cleanup = [System.Collections.Generic.List[string]]::new()
$reportDir = Join-Path $env:GITHUB_WORKSPACE 'probe-results'
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
try {
    $bytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $password = 'Aa1!' + [Convert]::ToBase64String($bytes)
    $secure = ConvertTo-SecureString $password -AsPlainText -Force
    $user = New-LocalUser -Name $username -Password $secure -Description 'Disposable Hatch compatibility probe only'
    $accountSid = $user.SID.Value
    $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
    Add-LocalGroupMember -Group $usersGroup -Member $user
    $env:HATCH_PROBE_PASSWORD = $password
    $env:HATCH_PROBE_ENV_CANARY = 'synthetic-host-only-do-not-inherit'
    $password = $null
    $secure.Dispose()
    $probe = Join-Path $env:GITHUB_WORKSPACE 'tools/windows-sandbox-probe/target/release/hatch-windows-sandbox-probe.exe'
    $runtime = (Resolve-Path (Join-Path $env:GITHUB_WORKSPACE 'desktop-app/src-tauri/runtime')).Path
    & $probe --opt-in --runtime-root $runtime --identity-user $username --timeout-seconds 180 `
        1>(Join-Path $reportDir 'restricted.json') 2>(Join-Path $reportDir 'restricted.stderr.txt')
    $exitCode = $LASTEXITCODE
} finally {
    Remove-Item Env:HATCH_PROBE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:HATCH_PROBE_ENV_CANARY -ErrorAction SilentlyContinue
    if ($null -ne $accountSid) {
        # Exact newly-created SID is the authority; no broad name wildcard,
        # taskkill /IM, TEMP deletion, or cleanup of pre-existing identities.
        foreach ($process in Get-CimInstance Win32_Process) {
            $held = $null
            try {
                $held = [Diagnostics.Process]::GetProcessById($process.ProcessId)
                $null = $held.Handle # Pin the process object before checking ownership; avoid PID reuse.
                $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
                if ($owner.Sid -eq $accountSid) {
                    $cleanup.Add("probe left owned process $($process.ProcessId); CI recovery required")
                    $held.Kill()
                    if (-not $held.WaitForExit(5000)) { $cleanup.Add('owned process exit unconfirmed') }
                }
            } catch {
                if ($null -ne $held -and -not $held.HasExited) { $cleanup.Add('process ownership/cleanup check failed') }
            } finally { if ($null -ne $held) { $held.Dispose() } }
        }
        try {
            Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $accountSid } | Remove-CimInstance
            $existing = Get-LocalUser -Name $username
            if ($existing.SID.Value -ne $accountSid) { throw 'account SID changed; refusing deletion' }
            Remove-LocalUser -SID $existing.SID
        } catch { $cleanup.Add($_.Exception.Message) }
    }
    @{ account = $username; sid = $accountSid; cleanup_errors = @($cleanup.ToArray());
       probe_exit = $exitCode; source_sha = $env:GITHUB_SHA; scope = 'synthetic compatibility probe, not product UAT' } |
       ConvertTo-Json -Depth 4 | Set-Content (Join-Path $reportDir 'identity-cleanup.json')
}
if ($cleanup.Count -ne 0) { exit 1 }
exit $exitCode
