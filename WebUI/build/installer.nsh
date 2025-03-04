!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend


!macro customInstall

    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ${If} $0 != "1"
      DetailPrint "Installing Microsoft Visual C++ Redistributable..."
      inetc::get /CAPTION " " /BANNER "Downloading Microsoft Visual C++ Redistributable..." "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
      ExecWait "$TEMP\vc_redist.x64.exe /install /norestart"
    ${EndIf}

    SetDetailsPrint both
    IfFileExists "$INSTDIR\resources\prototype-python-env.7z" extracting 0
    Abort "Broken installer!"

    extracting:
        DetailPrint "Extracting python environment..."
        nsExec::ExecToLog '"$INSTDIR\resources\7zr.exe" x "$INSTDIR\resources\prototype-python-env.7z" -o"$INSTDIR\resources"'
        Delete "$INSTDIR\resources\prototype-python-env.7z"

    StrCpy $0 "$INSTDIR"
    StrCpy $1 "_model_backup"
    StrCpy $2 "$0$1"
    IfFileExists "$2" recoverModels end

    recoverModels:
        DetailPrint "Recovering model files..."
        nsExec::ExecToLog '"$INSTDIR\resources\prototype-python-env\python.exe" "$INSTDIR\resources\service\tools\move_model_files.py" "$2" "$INSTDIR\resources\service\models"'
        Pop $0
        ${if} $0 == 0
          RMDir /r "$2"
          Goto end
        ${endIf}

        MessageBox MB_OK "WARNING: Failed to recover model files from $2. You can manually copy the contents from $2 to $INSTDIR\resources\service\models"

    end:
        DetailPrint "Installation completed."

!macroend


!macro customRemoveFiles
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

    IfFileExists "$INSTDIR\resources\prototype-python-env\python.exe" 0 slowBackup
    IfFileExists "$INSTDIR\resources\service\tools\move_model_files.py" 0 slowBackup
    nsExec::ExecToLog '"$INSTDIR\resources\prototype-python-env\python.exe" "$INSTDIR\resources\service\tools\move_model_files.py" "$INSTDIR\resources\service\models" "$2"'
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
