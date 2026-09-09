param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[object]]::new()
function Check([string]$Name, [scriptblock]$Action) {
    try { & $Action; $checks.Add(@{name=$Name; status='passed'}) }
    catch { $checks.Add(@{name=$Name; status='failed'; error=$_.ToString()}) }
}
function Denied([scriptblock]$Action) {
    try { & $Action } catch {
        $e = $_.Exception
        while ($null -ne $e) {
            if ($e -is [System.UnauthorizedAccessException]) { return }
            $e = $e.InnerException
        }
        throw
    }
    throw 'operation was allowed'
}
Check 'workspace read/write' {
    $p = Join-Path $Root 'workspace\powershell-marker'
    [IO.File]::WriteAllText($p, 'powershell-ok')
    if ([IO.File]::ReadAllText($p) -ne 'powershell-ok') { throw 'marker mismatch' }
}
foreach ($dir in @('runtime', 'attachments')) {
    $p = Join-Path $Root "$dir\probe-canary.txt"
    Check "$dir read" { if ([IO.File]::ReadAllText($p) -ne 'readonly') { throw 'canary mismatch' } }
    Check "$dir write denied" { Denied { [IO.File]::WriteAllText($p, 'ESCAPE') } }
}
Check 'ungranted read denied' { Denied { [IO.File]::ReadAllText((Join-Path $Root 'ungranted\secret.txt')) | Out-Null } }
Check 'ungranted write denied' { Denied { [IO.File]::WriteAllText((Join-Path $Root 'ungranted\secret.txt'), 'ESCAPE') } }
@{checks=@($checks.ToArray())} | ConvertTo-Json -Depth 6 -Compress
if (@($checks | Where-Object {$_.status -ne 'passed'}).Count) { exit 1 }
exit 0
