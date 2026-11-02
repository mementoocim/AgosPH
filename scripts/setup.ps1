param([string]$Python = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
if (-not $Python) {
    $taskCandidates = @(
        (Join-Path $taskRoot '.venv\Scripts\python.exe'),
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'),
        'python', 'py'
    )
    foreach ($taskCandidate in $taskCandidates) {
        try {
            $taskVersion = & $taskCandidate -c "import sys; print(sys.version_info >= (3, 12))" 2>$null
            if ($LASTEXITCODE -eq 0 -and $taskVersion -eq 'True') { $Python = $taskCandidate; break }
        } catch { }
    }
}
if (-not $Python) { throw 'Python 3.12+ was not found. Install Python from python.org, then rerun with -Python C:\path\to\python.exe.' }
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed.' }
}
& '.\.venv\Scripts\python.exe' -m pip install -r backend/requirements.lock.txt
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
& '.\.venv\Scripts\python.exe' -m backend.seed
if ($LASTEXITCODE -ne 0) { throw 'Demonstration fixture creation failed.' }
Write-Host 'AgosPH is ready. Run: npm.cmd run start:local' -ForegroundColor Cyan
