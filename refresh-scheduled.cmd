@echo off
REM Scheduled entry point: runs the refresh and captures everything to a log.
REM schtasks cannot parse redirection inside its /tr argument, so the wrapper
REM owns the logging rather than the task definition.
cd /d "%~dp0"
echo. >> refresh.log
echo ======================================================== >> refresh.log
call "%~dp0refresh.cmd" >> refresh.log 2>&1
echo exit=%errorlevel% >> refresh.log
exit /b %errorlevel%
