@echo off
if EXIST ".\external\service" (
    rd /s /q ".\external\service"
)
mklink /J ".\external\service" "..\service"

if NOT EXIST "..\package_res\ultra_env.7z" (
    setlocal enabledelayedexpansion
    pushd "..\package_res"
    set "absolutePath=!cd!"
    echo "You must place ultra_env.7z under the directory !absolutePath!"
    popd
    endlocal
    Exit -1
)
IF EXIST ".\external\env.7z" (
    del /F /Q ".\external\env.7z"
)
mklink /H ".\external\env.7z" "..\package_res\ultra_env.7z"