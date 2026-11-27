param(
  [Parameter(Mandatory=$true)][string]$Destination,
  [string]$CacheDirectory = (Join-Path $env:TEMP 'loom-office-download-cache')
)
$ErrorActionPreference = 'Stop'
$loVersion = '25.8.7'
$loUrl = "https://download.documentfoundation.org/libreoffice/stable/$loVersion/win/x86_64/LibreOffice_${loVersion}_Win_x86-64.msi"
$popplerVersion = '26.09.0-0'
$popplerUrl = "https://github.com/oschwartz10612/poppler-windows/releases/download/v$popplerVersion/Release-$popplerVersion.zip"
New-Item -ItemType Directory -Force -Path $CacheDirectory | Out-Null
$msi = Join-Path $CacheDirectory "LibreOffice_${loVersion}_Win_x86-64.msi"
if (!(Test-Path $msi)) { Invoke-WebRequest -Uri $loUrl -OutFile $msi -UseBasicParsing }
$zip = Join-Path $CacheDirectory "poppler-$popplerVersion.zip"
if (!(Test-Path $zip)) { Invoke-WebRequest -Uri $popplerUrl -OutFile $zip -UseBasicParsing }
if (Test-Path $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $Destination 'libreoffice'),(Join-Path $Destination 'poppler') | Out-Null
$install = Join-Path $CacheDirectory 'libreoffice-install'
if (Test-Path $install) { Remove-Item -LiteralPath $install -Recurse -Force }
New-Item -ItemType Directory -Force -Path $install | Out-Null
$arguments = @('/i', ('"{0}"' -f $msi), '/qn', '/norestart', ('INSTALLLOCATION="{0}"' -f $install))
$process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "LibreOffice MSI install failed: $($process.ExitCode)" }
$installed = Join-Path $install 'program/soffice.exe'
if (!(Test-Path $installed)) {
  $fallback = 'C:\Program Files\LibreOffice\program\soffice.exe'
  if (Test-Path $fallback) { $install = 'C:\Program Files\LibreOffice' } else { throw 'LibreOffice soffice.exe missing after MSI install' }
}
Copy-Item (Join-Path $install '*') (Join-Path $Destination 'libreoffice') -Recurse -Force
$extract = Join-Path $CacheDirectory 'poppler-extract'
if (Test-Path $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $extract
$exe = Get-ChildItem -LiteralPath $extract -Filter pdftoppm.exe -File -Recurse | Select-Object -First 1
if (!$exe) { throw 'pdftoppm.exe missing in pinned poppler archive' }
$libraryRoot = $exe.Directory.Parent.FullName
Copy-Item (Join-Path $libraryRoot '*') (Join-Path $Destination 'poppler') -Recurse -Force
if (!(Test-Path (Join-Path $Destination 'poppler/bin/pdftoppm.exe'))) { throw 'staged pdftoppm.exe missing' }
[ordered]@{ schema = 1; libreOfficeVersion = $loVersion; popplerVersion = $popplerVersion; portable = $true } | ConvertTo-Json | Set-Content (Join-Path $Destination 'office-bundle.json') -Encoding utf8
Write-Host "office runtime staged at $Destination"
