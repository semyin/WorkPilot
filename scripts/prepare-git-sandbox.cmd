@echo off
call "%WORKPILOT_VSDEVCMD%" -arch=x64 >nul
if errorlevel 1 exit /b %errorlevel%
"%WORKPILOT_BUILD_NODE%" "%WORKPILOT_BUILD_SCRIPT%" --worker
