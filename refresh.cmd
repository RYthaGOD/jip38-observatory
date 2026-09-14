@echo off
REM Refresh the JIP-38 Observatory dashboard, on Windows, by hand.
REM
REM ---------------------------------------------------------------------------
REM NO LONGER SCHEDULED, as of 13 September 2026.
REM
REM The "JIP38 Observatory Refresh" scheduled task is DISABLED (disabled, not
REM deleted: Enable-ScheduledTask -TaskName "JIP38 Observatory Refresh" brings it
REM back). Railway now serves the page and refreshes itself in-process every six
REM hours, so this machine running the same refresh did two unhelpful things:
REM
REM   1. It wrote a SECOND series of treasury readings. Both series were
REM      genuine, and neither was complete — they had diverged by three readings
REM      before it was noticed. server.mjs now unions them on boot so nothing is
REM      lost, but one writer is better than a merge.
REM
REM   2. It exited 3 on every run. That is correct: stage 3 below reports that
REM      the page was built but not published to the Artifact, and the headless
REM      publish step cannot work — it needs a Claude session with the Artifact
REM      tool, which a scheduled task does not have. So every run raised a
REM      failure notification for a condition nothing on this machine could fix.
REM
REM Running it by hand is still fine: it runs the offline gate and the registry
REM verifier, reads the chain, and rebuilds the page locally — the same work
REM refresh.mjs does on Railway. It publishes nothing; see below for why.
REM
REM The history of the publish stage this file used to have — including the day
REM it reported success while publishing nothing — is in git and in
REM release.mjs, which is where the lesson is enforced.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"


echo [%date% %time%] offline checks...
call node check.mjs || goto :failed

echo [%date% %time%] verifying the registry against chain...
call node verify.mjs --quiet || goto :failed

echo [%date% %time%] reading chain...
call node snapshot.mjs || goto :failed

echo [%date% %time%] rebuilding page...
call node build-dashboard.mjs || goto :failed

REM There is no publish stage any more, and there must not be one.
REM
REM The Artifact was retired to a pointer on 14 September 2026 — it sends readers
REM to the Railway host, which serves the page itself. The stage that used to sit
REM here republished dist/dashboard.html to that Artifact, so running this file
REM by hand would have silently overwritten the pointer with a dashboard nothing
REM keeps current: two public pages with two sets of figures again, which is the
REM thing the retirement exists to prevent.
REM
REM release.mjs status still runs, and now checks the pointer rather than a build.

echo [%date% %time%] confirming the Artifact is still a pointer...
call node release.mjs status || goto :pointerstale

echo [%date% %time%] done - built locally. The live record is served by Railway.
exit /b 0

:pointerstale
echo [%date% %time%] NOTE: artifact-pointer.html changed since it was published.
echo   See release.mjs status above. The local build itself succeeded.
exit /b 3

:failed
echo [%date% %time%] FAILED with errorlevel %errorlevel%
exit /b %errorlevel%
