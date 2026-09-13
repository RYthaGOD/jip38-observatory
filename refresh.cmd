@echo off
REM Refresh the JIP-38 Observatory dashboard.
REM
REM Three stages, and they fail differently:
REM   1. Read the chain and rebuild the page. Plain scripts; they fail loudly.
REM   2. Republish the Artifact. Only Claude Code can do this, because the
REM      Artifact tool is not a CLI.
REM   3. Confirm that what is published IS what was built.
REM
REM ---------------------------------------------------------------------------
REM WHY STAGE 3 EXISTS
REM
REM On 13 September 2026 this script reported success while publishing nothing.
REM The headless Claude session had no Artifact tool, said so honestly, and
REM exited 0. "|| goto :failed" therefore never fired, the log recorded "done",
REM and the scheduled task recorded SUCCESS with a three-day-stale artifact in
REM front of the public.
REM
REM An exit code from a publisher is not evidence of publication. So the run is
REM only a success if release.mjs can show that the built page is the one
REM verified as served. Publishing requires a session where the Artifact tool is
REM actually available; until that happens this task is SUPPOSED to fail, and
REM the failure is the honest signal that the public page is behind.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

set ARTIFACT_URL=https://claude.ai/code/artifact/a6f040d8-e252-4f10-825b-f5c640b5e107

echo [%date% %time%] offline checks...
call node check.mjs || goto :failed

echo [%date% %time%] verifying the registry against chain...
call node verify.mjs --quiet || goto :failed

echo [%date% %time%] reading chain...
call node snapshot.mjs || goto :failed

echo [%date% %time%] rebuilding page...
call node build-dashboard.mjs || goto :failed

echo [%date% %time%] republishing artifact...
REM --allowedTools pre-authorises the publish. A headless run cannot answer an
REM approval prompt, so without this the republish silently stops at the gate.
REM Note that a zero exit here proves nothing; stage 3 is what decides.
call claude --allowedTools "Artifact" -p "Publish the file dist/dashboard.html as an Artifact update, passing url=%ARTIFACT_URL% so it updates that existing artifact rather than creating a new one. The file is already built - do not modify it, do not re-read the chain, just publish it. Then READ THE ARTIFACT BACK from that URL and confirm which snapshot generatedAt it actually serves. If and only if the readback matches the built page, run: node release.mjs record --url %ARTIFACT_URL% --served <the generatedAt you read back> --by \"headless refresh readback\". If you cannot publish, say so plainly and do not record anything."

echo [%date% %time%] confirming what is actually published...
call node release.mjs status || goto :notpublished

echo [%date% %time%] done - built, published and verified.
exit /b 0

:notpublished
echo [%date% %time%] FAILED: the page was built but is NOT published.
echo   The public artifact is behind the local build. See release.mjs status above.
exit /b 3

:failed
echo [%date% %time%] FAILED with errorlevel %errorlevel%
exit /b %errorlevel%
