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

    if ([string]::IsNullOrEmpty($env:RHB_UPSTREAM)) {
        $env:RHB_UPSTREAM = Read-Host 'Upstream API Base URL (e.g. https://api.example.com/v1; never enter a key)'
        if ([string]::IsNullOrEmpty($env:RHB_UPSTREAM)) {
            throw 'Upstream URL is required.'
        }
    }

    if ([string]::IsNullOrEmpty($env:RHB_UPSTREAM_PROTOCOL)) {
        Write-Host 'Messages protocol: responses = convert to Responses (AgentRouter); passthrough = forward unchanged.'
        $env:RHB_UPSTREAM_PROTOCOL = Read-Host 'Choose responses / passthrough [responses]'
        if ([string]::IsNullOrEmpty($env:RHB_UPSTREAM_PROTOCOL)) {
            $env:RHB_UPSTREAM_PROTOCOL = 'responses'
        }
    }
    if ($env:RHB_UPSTREAM_PROTOCOL -cne 'responses' -and $env:RHB_UPSTREAM_PROTOCOL -cne 'passthrough') {
        throw 'Unsupported upstream protocol.'
    }

    Write-Host 'Existing client credentials are forwarded by default. No keys are prompted for or saved; no client configuration is changed.'
    Write-Host 'The bridge runs in the foreground. Press Ctrl+C to stop listening.'
    & $nodeBin (Join-Path $rootDir 'cli.js')
    $exitCode = $LASTEXITCODE
    exit $exitCode
}
catch {
    Write-Host 'Startup did not complete. Check Node.js >=18, RHB_UPSTREAM, the protocol selection and local execution permissions. No service or execution policy was changed.'
    exit 1
}
