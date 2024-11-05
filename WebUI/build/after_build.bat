@echo off
IF EXIST ".\external\service" (
    rd /q /s ".\external\service"
)
IF EXIST ".\external\env.7z" (
    del /F /Q ".\external\env.7z"
)

IF EXIST ".\external\env" (
    rd /q /s ".\external\env"
)