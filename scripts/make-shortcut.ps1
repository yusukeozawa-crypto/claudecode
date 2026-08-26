# ============================================================
#  デスクトップにショートカットを作る。
#
#  ショートカットは PowerShell を -NoExit 付きで呼ぶので、
#  Ctrl+C で止めても黒い画面が閉じません。
#  作業フォルダをツールのフォルダに固定するため、
#  デスクトップのどこから開いても動きます。
# ============================================================
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'run-qa.ps1'
if (-not (Test-Path $entry)) {
  Write-Host "[エラー] run-qa.ps1 が見つかりません: $entry" -ForegroundColor Red
  exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop '代理店コード・LP動作 自動検証ツール.lnk'

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# -NoExit    … Ctrl+C や終了のあとも画面を残す
# -ExecutionPolicy Bypass … PC の設定を変えずに、この入口だけ実行を許す
$link.Arguments = '-NoExit -ExecutionPolicy Bypass -File "' + $entry + '"'
$link.WorkingDirectory = $root
$link.Description = '代理店コード・LP動作 自動検証ツール'
$link.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',14'
$link.Save()

Write-Host ''
Write-Host '  デスクトップにショートカットを作りました。'
Write-Host "    $linkPath"
Write-Host ''
Write-Host '  このショートカットから開くと、Ctrl+C で止めても画面が閉じません。'
Write-Host ''
