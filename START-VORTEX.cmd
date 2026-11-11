@echo off
setlocal
cd /d "%~dp0"
rem XPath search needs two small packages. The release ZIP ships them; a fresh clone installs them once here.
if not exist "node_modules\xpath\package.json" (
  echo Installing the two runtime packages ^(first start only^)...
  call npm ci --omit=dev --no-audit --no-fund
)
call npm start -- %*
pause
