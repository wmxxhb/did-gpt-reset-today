$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# Prefer an installed Node >=22, or the existing Codex bundled runtime.
$tiboNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($tiboNode) { $tiboMajor = [int]((& $tiboNode --version) -replace '^v(\d+).*', '$1') } else { $tiboMajor = 0 }
if ($tiboMajor -lt 22) {
    $tiboBundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $tiboBundled) { $tiboNode = $tiboBundled }
    if ($tiboNode) { $tiboMajor = [int]((& $tiboNode --version) -replace '^v(\d+).*', '$1') }
    if ($tiboMajor -lt 22) {
        Write-Host '首次使用需要安装 Node.js 22 或更新版本（免费运行组件）。'
        Write-Host '1. 打开官方下载页面，安装 LTS 版本（推荐）'
        Write-Host '0. 暂时退出'
        $tiboInstallChoice = Read-Host '输入编号'
        if ($tiboInstallChoice -eq '1') { Start-Process 'https://nodejs.org/en/download' }
        Write-Host '安装完成后，请重新双击“打开工具.cmd”。'
        exit 0
    }
}
$env:Path = (Split-Path -Parent $tiboNode) + ';' + $env:Path
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\wrangler\bin\wrangler.js'))) {
    $tiboNpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $tiboNpmCommand) { throw '未找到 npm，请安装 Node.js：https://nodejs.org/' }
    $tiboNpmCli = Join-Path (Split-Path -Parent $tiboNpmCommand.Source) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $tiboNpmCli)) { throw '未找到 npm CLI，请在安装 Node.js 后重试。' }
    & $tiboNode 'scripts\install.mjs' $tiboNpmCli
    if ($LASTEXITCODE -ne 0) { throw '组件准备失败，请检查网络后重新双击打开。' }
}
& $tiboNode 'scripts\setup.mjs'
if ($LASTEXITCODE -ne 0) { throw '部署尚未完成，请根据提示处理后重试。' }
