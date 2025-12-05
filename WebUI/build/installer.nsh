!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customInstallMode
    StrCpy $isForceCurrentInstall "1"
    StrCpy $isForceMachineInstall "0"
!macroend

!macro customInstall

    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ${If} $0 != "1"
      DetailPrint "Installing Microsoft Visual C++ Redistributable..."
      inetc::get /CAPTION " " /BANNER "Downloading Microsoft Visual C++ Redistributable..." "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
      ExecWait "$TEMP\vc_redist.x64.exe /install /norestart"
    ${EndIf}
      
    SetDetailsPrint both

    StrCpy $0 "$INSTDIR"
    StrCpy $1 "_model_backup"
    StrCpy $2 "$0$1"
    IfFileExists "$2" recoverModels end

    recoverModels:
      DetailPrint "Recovering model files..."
      nsExec::ExecToLog '"$INSTDIR\resources\uv.exe" "run" "--script" "$INSTDIR\resources\service\move_model_files.py" "$2" "$INSTDIR\resources\models"'
      Pop $0
      ${if} $0 == 0
        RMDir /r "$2"
        Goto end
      ${endIf}

      IfSilent +2
      MessageBox MB_OK "WARNING: Failed to recover model files from $2. You can manually copy the contents from $2 to $INSTDIR\resources\models"

    end:
        DetailPrint "Installation completed."
          
!macroend


!macro customRemoveFiles

  IfSilent keepModels
  SetDetailsPrint both
  DetailPrint "Uninstalling existing files..."

  ; Ask the user if they want to keep the models
  MessageBox MB_YESNO "Do you want to keep the models directory?" IDYES keepModels IDNO deleteAll


  keepModels:
    ; If the user clicked "Yes", move the models directory to a temporary location in the same drive, delete the installation directory, and then move back the models directory
    DetailPrint "Backing up model files..."

    StrCpy $0 "$INSTDIR"
    StrCpy $1 "_model_backup"
    StrCpy $2 "$0$1"

    IfFileExists "$INSTDIR\resources\uv.exe" 0 slowBackup
    IfFileExists "$INSTDIR\resources\service\move_model_files.py" 0 slowBackup
    nsExec::ExecToLog '"$INSTDIR\resources\uv.exe" "run" "--script" "$INSTDIR\resources\service\move_model_files.py" "$INSTDIR\resources\models" "$2"'
    Pop $0
    ${if} $0 == 0
      Goto deleteAll
    ${endIf}

  slowBackup:
    IfFileExists "$2" copyToBackup moveToBackup

  copyToBackup:
    CopyFiles "$INSTDIR\resources\service\models\*.*" "$2"
    DetailPrint "backup model directory at $2"
    Goto deleteAll

  moveToBackup:
    Rename "$INSTDIR\resources\service\models" "$2"
    DetailPrint "backup model directory at $2"

  deleteAll:
    ; If the user clicked "No", delete the entire installation directory
    DetailPrint "Removing existing files..."
    RMDir /r "$INSTDIR"

!macroend
