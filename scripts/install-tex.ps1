# 安装 TinyTeX 到 Hermes latex-studio 插件目录（提供 latexmk/xelatex 编译链）
# 用法：PowerShell 里执行
#   powershell -ExecutionPolicy Bypass -File scripts\install-tex.ps1
# 已装过会直接退出；装完重启 Hermes 桌面端即生效（后端优先用插件内 TinyTeX）。
$ErrorActionPreference = 'Stop'

$Url = 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.09/TinyTeX-v2026.09.zip'
$Dst = Join-Path $env:LOCALAPPDATA 'hermes\plugins\latex-studio\tinytex'

foreach ($bin in @('bin\windows', 'bin\win32')) {
  if (Test-Path (Join-Path $Dst "$bin\xelatex.exe")) {
    Write-Host "TinyTeX 已就绪：$Dst"
    exit 0
  }
}

$zip = Join-Path $env:TEMP 'TinyTeX-install.zip'
Write-Host '[1/3] 下载 TinyTeX（约 250MB）...'
Invoke-WebRequest -Uri $Url -OutFile $zip

Write-Host "[2/3] 解压到 $Dst ..."
$stage = Join-Path $env:TEMP ('tinytex-' + [guid]::NewGuid())
Expand-Archive -Path $zip -DestinationPath $stage -Force
$inner = Get-ChildItem $stage -Directory | Select-Object -First 1
New-Item -ItemType Directory -Force -Path (Split-Path $Dst) | Out-Null
if (Test-Path $Dst) { Remove-Item $Dst -Recurse -Force }
Move-Item $inner.FullName $Dst
Remove-Item $zip, $stage -Recurse -Force -ErrorAction SilentlyContinue

$tlmgr = Join-Path $Dst 'bin\windows\tlmgr.bat'
if (-not (Test-Path $tlmgr)) { $tlmgr = Join-Path $Dst 'bin\win32\tlmgr.bat' }

Write-Host '[3/3] 安装论文所需宏包（ctex/中文/算法/参考文献链，约 300MB）...'
& $tlmgr install ctex fandol zhnumber unicode-math environ trimspaces siunitx algorithm2e bicaption threeparttable caption subcaption enumitem natbib booktabs multirow amscls tools graphics hyperref geometry fancyhdr ulem listings xstring etoolbox bigfoot notoccite xits stix2-otf ifoddpage relsize

Write-Host '完成。重启 Hermes 桌面端后，编译即走插件自带 TinyTeX（无需再装 TeX Live）。'
