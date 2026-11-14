@echo off
setlocal
title Leaf Runner Mission Control
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Leaf Runner requires Node.js 22 or newer. Install it, then open this file again.
  pause
  exit /b 1
)
pushd "%~dp0"
if errorlevel 1 exit /b 1
node prove2me.mjs %*
set "runnerExitCode=%errorlevel%"
popd
if not "%runnerExitCode%"=="0" (
  echo.
  echo Leaf Runner stopped. See the message above for details.
  pause
)
exit /b %runnerExitCode%
