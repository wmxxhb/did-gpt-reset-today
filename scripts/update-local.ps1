param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Commit, [string]$SourceArchive)
$ErrorActionPreference = 'Stop'
if ($Commit -notmatch '^[a-f0-9]{40}$') { throw 'Invalid update commit' }
$taskRootPath = [IO.Path]::GetFullPath($Root)
$taskPackage = Get-Content -LiteralPath (Join-Path $taskRootPath 'package.json') -Raw | ConvertFrom-Json
if ($taskPackage.name -ne 'did-gpt-reset-today') { throw 'Unexpected project folder' }
[void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
$taskTempPath = Join-Path ([IO.Path]::GetTempPath()) ('gpt-reset-update-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($taskTempPath) | Out-Null
$taskArchivePath = Join-Path $taskTempPath 'source.zip'
$taskBackupPath = Join-Path $taskRootPath ('.tibo-local\update-backup\' + [Guid]::NewGuid().ToString('N'))
$taskWritten = @()
try {
  if ($SourceArchive) { Copy-Item -LiteralPath $SourceArchive -Destination $taskArchivePath }
  else {
    $taskClient = [Net.WebClient]::new()
    try { $taskClient.DownloadFile('https://codeload.github.com/wmxxhb/did-gpt-reset-today/zip/' + $Commit, $taskArchivePath) }
    finally { $taskClient.Dispose() }
  }
  $taskZip = [IO.Compression.ZipFile]::OpenRead($taskArchivePath)
  try {
    $taskEntries = @()
    foreach ($taskEntry in $taskZip.Entries) {
      $taskPrefix = 'did-gpt-reset-today-' + $Commit + '/'
      if (!$taskEntry.FullName.StartsWith($taskPrefix, [StringComparison]::Ordinal)) { throw 'Unexpected archive root' }
      $taskRelative = $taskEntry.FullName.Substring($taskPrefix.Length)
      if (!$taskRelative -or $taskRelative.EndsWith('/')) { continue }
      if ($taskRelative -match '\\|(^|/)\.\.?(/|$)|:') { throw 'Unsafe archive entry' }
      # Only update public runtime files. Private settings and Git metadata are never copied.
      if ($taskRelative -notmatch '^(src/|scripts/|web/|package\.json$|package-lock\.json$|README\.md$|SECURITY\.md$|THIRD_PARTY_NOTICES\.md$|start\.ps1$|wrangler\.jsonc$)' -and $taskRelative -notmatch '\.(cmd|txt|ps1)$') { continue }
      if ($taskRelative -match '(^|/)\.') { continue }
      $taskTarget = [IO.Path]::GetFullPath((Join-Path $taskRootPath $taskRelative))
      if (!$taskTarget.StartsWith($taskRootPath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe target' }
      $taskStaged = Join-Path $taskTempPath ('staged\' + $taskRelative)
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskStaged)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($taskEntry, $taskStaged, $true)
      $taskEntries += @{ Target=$taskTarget; Staged=$taskStaged; Relative=$taskRelative }
    }
    if (!(Test-Path -LiteralPath (Join-Path $taskTempPath 'staged\package.json')) -or !(Test-Path -LiteralPath (Join-Path $taskTempPath 'staged\src\worker.mjs'))) { throw 'Incomplete update archive' }
    $taskNewPackage = Get-Content -LiteralPath (Join-Path $taskTempPath 'staged\package.json') -Raw | ConvertFrom-Json
    if ($taskNewPackage.name -ne 'did-gpt-reset-today') { throw 'Unexpected update package' }
    foreach ($taskEntry in $taskEntries) {
      $taskBackup = Join-Path $taskBackupPath $taskEntry.Relative
      if (Test-Path -LiteralPath $taskEntry.Target) {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskBackup)) | Out-Null
        Copy-Item -LiteralPath $taskEntry.Target -Destination $taskBackup
      }
      $taskWritten += @{ Target=$taskEntry.Target; Backup=$taskBackup }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskEntry.Target)) | Out-Null
      Copy-Item -LiteralPath $taskEntry.Staged -Destination $taskEntry.Target -Force
    }
  } finally { $taskZip.Dispose() }
} catch {
  foreach ($taskEntry in $taskWritten) {
    if (Test-Path -LiteralPath $taskEntry.Backup) { Copy-Item -LiteralPath $taskEntry.Backup -Destination $taskEntry.Target -Force }
  }
  throw 'Update incomplete. Existing files were restored. Please retry or download from GitHub.'
} finally {
  $taskResolvedTemp = [IO.Path]::GetFullPath($taskTempPath)
  $taskAllowedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\gpt-reset-update-'
  if ($taskResolvedTemp.StartsWith($taskAllowedTemp, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $taskResolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
