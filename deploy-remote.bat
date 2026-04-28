@echo off
setlocal EnableDelayedExpansion
:::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
:: OpenRealm — Remote deployment to EC2 instances
::
:: Build order:
::   1. PROD_Data-Service — SCP openrealm + openrealm-data, mvn clean install
::      openrealm (dependency), mvn clean package openrealm-data, deploy jar
::   2. EU-WEST-2 — SCP openrealm, build, deploy jar
::   3. US-EAST-1 — SCP openrealm, build, deploy jar
::
:: Usage:
::   deploy-remote.bat [all|data|eu|us]
::   No argument defaults to "all"
:::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::

:: ── Paths ────────────────────────────────────────────────────────────────────
set "OPENREALM_DATA_LOCAL=%~dp0"
:: Remove trailing backslash
if "%OPENREALM_DATA_LOCAL:~-1%"=="\" set "OPENREALM_DATA_LOCAL=%OPENREALM_DATA_LOCAL:~0,-1%"
set "OPENREALM_LOCAL=%OPENREALM_DATA_LOCAL%\..\openrealm"

set "KEY_GCN=%USERPROFILE%\Documents\GitHub\global-compute.net\src\main\resources\gcn.rsa"
set "KEY_EU=%USERPROFILE%\Documents\GitHub\global-compute.net\src\main\resources\openrealm-eu.rsa"

set "SSH_USER=ec2-user"
set "SSH_OPTS=-o StrictHostKeyChecking=no -o LogLevel=ERROR"

:: ── VM definitions ───────────────────────────────────────────────────────────
set "PROD_DATA_IP=98.95.5.4"
set "EU_WEST_2_IP=51.24.13.231"
set "US_EAST_1_IP=100.55.103.226"

:: ── Target selection ─────────────────────────────────────────────────────────
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=all"

echo OpenRealm Remote Deployment
echo Target: %TARGET%

if "%TARGET%"=="all" (
    call :deploy_data
    if !errorlevel! neq 0 goto :fail
    call :deploy_game_server "EU-WEST-2" "%EU_WEST_2_IP%" "%KEY_EU%"
    if !errorlevel! neq 0 goto :fail
    call :deploy_game_server "US-EAST-1" "%US_EAST_1_IP%" "%KEY_GCN%"
    if !errorlevel! neq 0 goto :fail
) else if "%TARGET%"=="data" (
    call :deploy_data
    if !errorlevel! neq 0 goto :fail
) else if "%TARGET%"=="eu" (
    call :deploy_game_server "EU-WEST-2" "%EU_WEST_2_IP%" "%KEY_EU%"
    if !errorlevel! neq 0 goto :fail
) else if "%TARGET%"=="us" (
    call :deploy_game_server "US-EAST-1" "%US_EAST_1_IP%" "%KEY_GCN%"
    if !errorlevel! neq 0 goto :fail
) else (
    echo Usage: %~nx0 [all^|data^|eu^|us]
    exit /b 1
)

echo.
echo =============================================
echo  Deployment complete: %TARGET%
echo =============================================
exit /b 0

:::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
:: SUBROUTINES
:::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::

:: ── Upload a project to a remote host ────────────────────────────────────────
:: %1 = IP, %2 = key path, %3 = local dir, %4 = remote dir
:upload_project
set "UP_IP=%~1"
set "UP_KEY=%~2"
set "UP_LOCAL=%~3"
set "UP_REMOTE=%~4"

:: Derive project name from local dir
for %%D in ("%UP_LOCAL%") do set "UP_NAME=%%~nxD"

set "UP_TAR_NAME=%UP_NAME%-%UP_IP%.tar"
set "UP_TAR=%TEMP%\%UP_TAR_NAME%"

echo     Packaging %UP_NAME%...
pushd "%TEMP%"
tar -cf "%UP_TAR_NAME%" --exclude="./target" --exclude="./.*" -C "%UP_LOCAL%" .
if !errorlevel! neq 0 ( popd & echo     ERROR: tar failed & exit /b 1 )
popd

echo     Clearing remote %UP_REMOTE%...
ssh %SSH_OPTS% -i "%UP_KEY%" %SSH_USER%@%UP_IP% "rm -rf %UP_REMOTE%; mkdir -p %UP_REMOTE%"
if !errorlevel! neq 0 ( echo     ERROR: remote clear failed & exit /b 1 )

echo     Uploading %UP_NAME% to %UP_REMOTE%...
scp %SSH_OPTS% -i "%UP_KEY%" "%UP_TAR%" %SSH_USER%@%UP_IP%:/tmp/%UP_NAME%.tar
if !errorlevel! neq 0 ( echo     ERROR: scp failed & exit /b 1 )

ssh %SSH_OPTS% -i "%UP_KEY%" %SSH_USER%@%UP_IP% "tar -xf /tmp/%UP_NAME%.tar -C %UP_REMOTE%; rm -f /tmp/%UP_NAME%.tar"
if !errorlevel! neq 0 ( echo     ERROR: remote extract failed & exit /b 1 )

del /q "%UP_TAR%" 2>nul
echo     %UP_NAME% uploaded.
exit /b 0

:: ── Deploy: PROD_Data-Service ────────────────────────────────────────────────
:deploy_data
echo.
echo =============================================
echo  Deploying to PROD_Data-Service (%PROD_DATA_IP%)
echo =============================================

call :upload_project "%PROD_DATA_IP%" "%KEY_GCN%" "%OPENREALM_LOCAL%" "/home/ec2-user/openrealm"
if !errorlevel! neq 0 exit /b 1

call :upload_project "%PROD_DATA_IP%" "%KEY_GCN%" "%OPENREALM_DATA_LOCAL%" "/home/ec2-user/openrealm-data"
if !errorlevel! neq 0 exit /b 1

echo     Building openrealm (mvn clean install)...
ssh %SSH_OPTS% -i "%KEY_GCN%" %SSH_USER%@%PROD_DATA_IP% "mvn -B clean install -DskipTests -f /home/ec2-user/openrealm/pom.xml"
if !errorlevel! neq 0 ( echo     ERROR: openrealm build failed & exit /b 1 )

echo     Building openrealm-data (mvn clean package)...
ssh %SSH_OPTS% -i "%KEY_GCN%" %SSH_USER%@%PROD_DATA_IP% "mvn -B clean package -DskipTests -f /home/ec2-user/openrealm-data/pom.xml"
if !errorlevel! neq 0 ( echo     ERROR: openrealm-data build failed & exit /b 1 )

echo     Deploying openrealm-data.jar and restarting service...
:: Chain with && so a missing/failed cp aborts BEFORE the restart, instead
:: of restarting on a stale jar (the previous ; version masked cp failures).
ssh %SSH_OPTS% -i "%KEY_GCN%" %SSH_USER%@%PROD_DATA_IP% "sudo cp /home/ec2-user/openrealm-data/target/openrealm-data.jar /opt/openrealm-data/openrealm-data.jar && sudo systemctl restart openrealm-data"
if !errorlevel! neq 0 ( echo     ERROR: jar copy or service restart failed & exit /b 1 )

echo     Setting up nginx HTTPS reverse proxy...
ssh %SSH_OPTS% -i "%KEY_GCN%" %SSH_USER%@%PROD_DATA_IP% "chmod +x /home/ec2-user/openrealm-data/setup-nginx.sh; sudo /home/ec2-user/openrealm-data/setup-nginx.sh"
if !errorlevel! neq 0 ( echo     WARNING: nginx setup had errors ^(may need manual certbot run^) )

echo     PROD_Data-Service deployed.
exit /b 0

:: ── Deploy: Game server (generic) ────────────────────────────────────────────
:: %1 = name, %2 = IP, %3 = key path
:deploy_game_server
set "GS_NAME=%~1"
set "GS_IP=%~2"
set "GS_KEY=%~3"

echo.
echo =============================================
echo  Deploying to %GS_NAME% (%GS_IP%)
echo =============================================

call :upload_project "%GS_IP%" "%GS_KEY%" "%OPENREALM_LOCAL%" "/home/ec2-user/openrealm"
if !errorlevel! neq 0 exit /b 1

echo     Building openrealm (mvn clean package)...
ssh %SSH_OPTS% -i "%GS_KEY%" %SSH_USER%@%GS_IP% "mvn -B clean package -DskipTests -f /home/ec2-user/openrealm/pom.xml"
if !errorlevel! neq 0 ( echo     ERROR: openrealm build failed & exit /b 1 )

echo     Deploying openrealm.jar and restarting service...
:: Glob the shaded jar so version bumps in openrealm/pom.xml don't silently
:: break the deploy. Chain with && so a missing jar (cp failure) aborts
:: BEFORE the restart, instead of restarting on a stale jar.
ssh %SSH_OPTS% -i "%GS_KEY%" %SSH_USER%@%GS_IP% "sudo cp /home/ec2-user/openrealm/target/openrealm-*-shaded.jar /opt/openrealm/openrealm.jar && sudo systemctl restart openrealm"
if !errorlevel! neq 0 ( echo     ERROR: jar copy or service restart failed & exit /b 1 )

echo     %GS_NAME% deployed.
exit /b 0

:fail
echo.
echo =============================================
echo  Deployment FAILED
echo =============================================
exit /b 1
