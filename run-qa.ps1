# ============================================================
#  代理店コード・LP動作 自動検証ツール — ダブルクリック用の入口 (PowerShell 版)
#
#  run-qa.cmd との違いは 1 つだけ:
#    Ctrl+C を押しても、この画面が閉じません。
#
#  cmd (バッチ) から起動すると、Ctrl+C のあとに
#  「バッチ ジョブを終了しますか (Y/N)?」と聞かれ、Y を選ぶと窓ごと閉じます。
#  これは Windows の仕様で、こちらからは止められません。
#  PowerShell なら中断してもプロンプトに戻るだけなので、画面が残ります。
#
#  ショートカット (make-shortcut.cmd で作るもの) は -NoExit を付けて
#  この入口を呼びます。
# ============================================================
Set-Location -Path $PSScriptRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Start-QaTool {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host '[エラー] Node.js が見つかりません。' -ForegroundColor Red
    Write-Host '        https://nodejs.org/ja から入れたあと、この画面で run-qa と入力してください。'
    return
  }
  node scripts\ui-server.mjs
}
Set-Alias -Name run-qa -Value Start-QaTool

Write-Host ''
Write-Host '  止めるときは Ctrl+C。この画面は閉じません。'
Write-Host '  もう一度開くときは  run-qa  と入力して Enter。'
Write-Host '  終わるときはこの窓を閉じてください。'
Write-Host ''
Start-QaTool
