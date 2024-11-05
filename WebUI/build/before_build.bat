@echo off
if NOT EXIST "./external/service" (
    mklink /J "./external/service" "../service"
)
IF NOT EXIST "../external/env" (
    mklink /J "../external/env" "../env"
)