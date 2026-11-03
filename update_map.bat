@echo off
rem Update the Taua map on blog.lewisbrewer.com
rem
rem   Double-click            export from Core Data, then publish (live in a few minutes)
rem   update_map.bat preview  export and push to the map-preview branch only (nothing goes live)
rem
rem Needs Python 3 and Git for Windows. Reads Core Data, never writes to it.
setlocal EnableExtensions
cd /d "%~dp0"
title Update the Taua map
set "CORE=D:\Taua\Taua\Assets\Core Data"
set "MODE=publish"
if /i "%~1"=="preview" set "MODE=preview"
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

set "PATHS=map-src map src/map update_map.bat README.md .gitignore eleventy.config.js package.json package-lock.json .github/workflows/publish.yml converter/docs-to-html.mjs scripts/relativize.mjs src/_includes/layouts/base.njk src/assets/css/site.css test/run.mjs test/build-fixtures.mjs"

if "%MODE%"=="preview" goto preview

echo.
echo   2/3  Saving the change
git add -A -- %PATHS%
git diff --cached --quiet
if not errorlevel 1 (
  echo        Nothing changed since the last update.
  goto pushonly
)
git commit -q -m "Update the map"
if errorlevel 1 goto fail

:pushonly
echo.
echo   3/3  Sending it to GitHub
git pull --rebase -q
if errorlevel 1 (
  echo   Couldn't merge with the latest posts on GitHub. Nothing was published.
  git rebase --abort >nul 2>nul
  goto fail
)
git push -q
if errorlevel 1 goto fail
git push -q origin --delete map-preview >nul 2>nul
echo.
echo   Done. The map goes live at https://blog.lewisbrewer.com/map/ in a few minutes
echo   (longer the first time, while GitHub builds the tiles).
echo   Progress: https://github.com/LewisBrewer/blog/actions
goto end

:preview
echo.
echo   2/3  Saving a preview
git stash push -q --include-untracked -- %PATHS% >nul 2>nul
git fetch -q origin
git checkout -q -B map-preview origin/main
if errorlevel 1 goto restore
git stash pop -q
if errorlevel 1 (
  echo   The preview clashed with the latest version on GitHub.
  goto restore
)
git add -A -- %PATHS%
git commit -q -m "Map preview"
echo.
echo   3/3  Sending the preview to GitHub
git push -q -f origin map-preview
if errorlevel 1 goto restore
git checkout -q main
git checkout -q map-preview -- %PATHS%
git reset -q
echo.
echo   Done. Nothing has gone live. To look at it:
echo     1. Open https://github.com/LewisBrewer/blog/actions/workflows/publish.yml
echo     2. Run workflow, set "Use workflow from" to map-preview, tick Preview only, Run.
echo     3. When it finishes (about 10 minutes the first time), download blog-preview,
echo        unzip it and open map\index.html.
goto end

:restore
git checkout -q main >nul 2>nul
git stash pop -q >nul 2>nul
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
