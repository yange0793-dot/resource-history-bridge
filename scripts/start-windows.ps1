$ErrorActionPreference = 'Stop'

try {
    $rootDir = Split-Path -Parent $PSScriptRoot
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw 'Node.js is unavailable.'
    }
    $nodeBin = $nodeCommand.Source
    $nodeMajor = & $nodeBin -p 'parseInt(process.versions.node)'
    if ($LASTEXITCODE -ne 0 -or "$nodeMajor" -notmatch '^\d+$' -or [int]$nodeMajor -lt 18) {
        throw 'Node.js 18 or newer is required.'
    }

    if (-not (Test-Path Env:RHB_CLIENT) -and -not (Test-Path Env:RHB_HISTORY_MODE)) {
        Write-Host 'Client codex / harness / claude-code / generic [codex]'
        $client = Read-Host
        if ([string]::IsNullOrEmpty($client)) {
            $client = 'codex'
        }
        $env:RHB_CLIENT = $client
    }

    Write-Host 'Existing client credentials are forwarded by default. No keys are prompted for or saved; no client configuration is changed.'
    Write-Host 'The bridge runs in the foreground. Press Ctrl+C to stop listening.'
    & $nodeBin (Join-Path $rootDir 'cli.js')
    $exitCode = $LASTEXITCODE
    exit $exitCode
}
catch {
    Write-Host 'Startup did not complete. Check Node.js >=18, RHB_CLIENT, the AgentRouter upstream, port and local execution permissions. No service or execution policy was changed.'
    exit 1
}
