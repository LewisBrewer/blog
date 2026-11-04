@echo off
rem Update the Taua map on blog.lewisbrewer.com
rem
rem   Double-click            export from Core Data, then publish (live in a few minutes)
rem   update_map.bat preview  export and push to the map-preview branch only (nothing goes live)
rem
rem Needs Python 3 and Git for Windows. Reads Core Data, never writes to it.
rem Site code comes from GitHub: local edits to the blog's code in this folder are replaced.
setlocal EnableExtensions
rem Git rewrites this file while it runs (pulling the latest version), and cmd
rem reads a batch file as it goes, so run from a copy in the temp folder.
if /i not "%~1"=="--run" (
  copy /y "%~f0" "%TEMP%\update_taua_map.bat" >nul
  "%TEMP%\update_taua_map.bat" --run "%~dp0" %1
)
cd /d "%~2"
title Update the Taua map
set "CORE=D:\Taua\Taua\Assets\Core Data"
set "MODE=publish"
if /i "%~3"=="preview" set "MODE=preview"
set "PYTHONUTF8=1"

echo.
echo   Update the Taua map  (%MODE%)
echo   ------------------------------------------
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo   Git isn't installed. Get Git for Windows from https://git-scm.com/download/win
  echo   then run this again. The first push asks you to sign in to GitHub once.
  goto fail
)
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo   Python 3 isn't installed. Get it from https://www.python.org/downloads/
  echo   and tick "Add python.exe to PATH" during setup.
  goto fail
)
if not exist "%CORE%\Settlements_v2\places.csv" (
  echo   Can't find Core Data at "%CORE%". Edit the CORE line near the top of this file.
  goto fail
)

git config core.filemode false
git config core.autocrlf true
git config core.safecrlf false

echo   1/3  Exporting the public map data
%PY% map\export_public.py "%CORE%"
if errorlevel 1 goto fail

rem The map data is rebuilt from Core Data on every run, and the site code lives on
rem GitHub, so this never merges: it sets the export aside, takes GitHub's latest
rem version of everything, puts the export back on top and sends that.
set "HOLD=%TEMP%\taua_map_src"
if exist "%HOLD%" rmdir /s /q "%HOLD%"
robocopy map-src "%HOLD%" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto fail

echo.
echo   2/3  Getting the latest version from GitHub
git rebase --abort >nul 2>nul
git merge --abort >nul 2>nul
git fetch -q origin
if errorlevel 1 goto fail
git checkout -q -f main
git reset -q --hard origin/main
if errorlevel 1 goto fail
robocopy "%HOLD%" map-src /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto fail

if "%MODE%"=="preview" goto preview

git add -A -- map-src
git diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo   Nothing has changed since the last update. Nothing to send.
  goto end
)
git commit -q -m "Update the map"
if errorlevel 1 goto fail

echo.
echo   3/3  Sending it to GitHub
git push -q origin main
if errorlevel 1 (
  rem GitHub moved on in the last few seconds (usually the daily posts run): try once more
  git fetch -q origin
  git reset -q --soft origin/main
  git commit -q -m "Update the map"
  git push -q origin main
  if errorlevel 1 goto fail
)
git push -q origin --delete map-preview >nul 2>nul
echo.
echo   Done. The map goes live at https://blog.lewisbrewer.com/map/ in a few minutes.
echo   Progress: https://github.com/LewisBrewer/blog/actions
goto end

:preview
echo.
echo   3/3  Sending a preview to GitHub
git checkout -q -B map-preview
git add -A -- map-src
git commit -q -m "Map preview"
git push -q -f origin map-preview
if errorlevel 1 goto restore
git checkout -q -f main
robocopy "%HOLD%" map-src /MIR /NFL /NDL /NJH /NJS /NP >nul
echo.
echo   Done. Nothing has gone live. To look at it:
echo     1. Open https://github.com/LewisBrewer/blog/actions/workflows/publish.yml
echo     2. Run workflow, set "Use workflow from" to map-preview, tick Preview only, Run.
echo     3. When it finishes, download blog-preview, unzip it and open map\index.html.
goto end

:restore
git checkout -q -f main >nul 2>nul
goto fail

:fail
echo.
echo   Stopped. Nothing was published.
echo.
pause
exit /b 1

:end
echo.
pause
