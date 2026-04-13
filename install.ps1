$ErrorActionPreference = "Stop"

$Repo = "kyle-undefined/umbodsmadr"
$Binary = "umbod.exe"
$InstallDir = "$env:LOCALAPPDATA\umbod"
$ReleaseRef = if ($env:UMBOD_VERSION) { $env:UMBOD_VERSION } else { "__UMBOD_RELEASE_REF__" }

$UmbodIsRelease = "__UMBOD_IS_RELEASE__"
if ($UmbodIsRelease -ne "true") {
    Write-Error "[umbod] install.ps1 is a release-installer template."
    Write-Error "[umbod] Run the release-hosted install.ps1 asset, or set UMBOD_VERSION explicitly."
    exit 1
}

$BaseUrl = "https://github.com/$Repo/releases/download/$ReleaseRef"
$BinaryUrl = "$BaseUrl/$Binary"
$ChecksumsUrl = "$BaseUrl/umbod-checksums.txt"

Write-Host "[umbod] Resolved release $ReleaseRef"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$TempBinary = [System.IO.Path]::GetTempFileName()
$TempChecksums = [System.IO.Path]::GetTempFileName()

try {
    Write-Host "[umbod] Downloading checksums for $ReleaseRef..."
    Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $TempChecksums -UseBasicParsing

    Write-Host "[umbod] Downloading $Binary for $ReleaseRef..."
    Invoke-WebRequest -Uri $BinaryUrl -OutFile $TempBinary -UseBasicParsing

    $ChecksumLines = Get-Content $TempChecksums
    $ExpectedLine = $ChecksumLines | Where-Object { $_ -match " umbod\.exe$" } | Select-Object -First 1
    if (-not $ExpectedLine) {
        throw "[umbod] Failed to find checksum for $Binary"
    }
    $ExpectedSha = ($ExpectedLine -split "\s+")[0].ToLower()

    $ActualSha = (Get-FileHash -Path $TempBinary -Algorithm SHA256).Hash.ToLower()
    if ($ActualSha -ne $ExpectedSha) {
        throw "[umbod] Checksum verification failed for $Binary"
    }

    $BinaryPath = Join-Path $InstallDir $Binary
    Move-Item -Force $TempBinary $BinaryPath
    Write-Host "[umbod] Verified checksum for $BinaryPath"
    Write-Host "[umbod] Installed binary to $BinaryPath"
} finally {
    if (Test-Path $TempBinary) { Remove-Item $TempBinary -Force -ErrorAction SilentlyContinue }
    if (Test-Path $TempChecksums) { Remove-Item $TempChecksums -Force -ErrorAction SilentlyContinue }
}

$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$CurrentPath;$InstallDir", "User")
    Write-Host "[umbod] Added $InstallDir to PATH (restart terminal to take effect)"
}

Write-Host ""
Write-Host "[umbod] Installed to $InstallDir\$Binary. Run: umbod --help"
