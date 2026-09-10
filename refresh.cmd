@echo off
REM Refresh the JIP-38 Observatory dashboard.
REM
REM Two halves, and they need different things:
REM   1. Reading the chain and rebuilding the page is a plain script.
REM   2. Republishing the Artifact can only be done by Claude Code, because
REM      the Artifact tool is not a CLI. So the last step runs Claude headless.
REM
REM Publishing from a session that did not create the artifact requires passing
REM its URL, or a SECOND artifact is created instead of the first being updated.
REM That URL is therefore pinned here.

setlocal
cd /d "%~dp0"

set ARTIFACT_URL=https://claude.ai/code/artifact/a6f040d8-e252-4f10-825b-f5c640b5e107

echo [%date% %time%] reading chain...
call node snapshot.mjs || goto :failed

echo [%date% %time%] rebuilding page...
call node build-dashboard.mjs || goto :failed

echo [%date% %time%] republishing artifact...
REM --allowedTools pre-authorises the publish. A headless run cannot answer an
REM approval prompt, so without this the republish silently stops at the gate
REM and the dashboard quietly goes stale while the task still reports success.
call claude --allowedTools "Artifact" -p "Publish the file dist/dashboard.html as an Artifact update, passing url=%ARTIFACT_URL% so it updates that existing artifact rather than creating a new one. The file is already built - do not modify it, do not re-read the chain, just publish it. Reply with one line: the URL and the execution ratio shown in the page." || goto :failed

echo [%date% %time%] done.
exit /b 0

:failed
echo [%date% %time%] FAILED with errorlevel %errorlevel%
exit /b %errorlevel%
