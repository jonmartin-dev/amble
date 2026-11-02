@echo off
rem Sets up an Amble server on Windows, or checks one: runs deploy/setup.sh in Git Bash, which comes
rem with Git for Windows, so it takes the same options. Works from PowerShell or Command Prompt.
rem
rem   deploy\setup.cmd            set up, asking for anything not given
rem   deploy\setup.cmd --check    check a setup and say what to fix
rem   deploy\setup.cmd --update   back up the database, get the latest code, rebuild
rem   deploy\setup.cmd --help     every option
setlocal
set "BASH="
rem Git's own bash, beside the git on the PATH. Not C:\Windows\System32\bash.exe, which is WSL's.
for /f "delims=" %%G in ('where git 2^>nul') do if not defined BASH if exist "%%~dpG..\bin\bash.exe" set "BASH=%%~dpG..\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "BASH=%LocalAppData%\Programs\Git\bin\bash.exe"
if not defined BASH (
  echo Git Bash wasn't found. Install Git for Windows ^(winget install Git.Git, or https://git-scm.com^), then run this again.
  exit /b 1
)
rem The script finds the repository from its own path, which bash reads with forward slashes.
set "SCRIPT=%~dp0setup.sh"
set "AMBLE_SETUP_AS=deploy\setup.cmd"
"%BASH%" "%SCRIPT:\=/%" %*
exit /b %ERRORLEVEL%
