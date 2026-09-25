@echo off
cd /d "%~dp0"
start "" "D:\node\node.exe" "node_modules\electron\cli.js" ".\release\app\dist\main\main.js"
