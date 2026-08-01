@echo off
rem =====================================================
rem VRChat OSC シャッター 固定時刻起動バッチ
rem
rem 使い方:
rem   1. 下の TARGET_TIME を撮影したい時刻に書き換える
rem   2. shutter-at-time.js と同じフォルダにこの .bat を置く
rem   3. ダブルクリックで実行(コマンドプロンプトが開いたままになるので
rem      結果を確認したらウィンドウを閉じてください)
rem =====================================================

setlocal

rem ここを固定したい時刻に変更してください (HH:MM:SS.mmm)
set TARGET_TIME=4:00:00.000

rem このバッチファイルがあるフォルダに移動(どこから実行してもOKにする)
cd /d "%~dp0"

echo ==============================================
echo  VRChat シャッター起動: %TARGET_TIME% に撮影します
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [エラー] Node.js が見つかりません。インストールされているか確認してください。
    pause
    exit /b 1
)

node shutter-at-time.js "%TARGET_TIME%"

echo.
echo 処理が終了しました。
pause
