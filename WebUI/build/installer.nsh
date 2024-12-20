!macro customHeader
  ShowInstDetails show
!macroend
!macro customInstall
    IfFileExists "$INSTDIR\resources\prototype-python-env.7z" extracting end

    extracting:
        SetDetailsPrint textonly
        DetailPrint "Extracting python environment..."
        nsExec::ExecToLog '"$INSTDIR\resources\7zr.exe" x "$INSTDIR\resources\prototype-python-env.7z" -o"$INSTDIR\resources"'
        Delete "$INSTDIR\resources\prototype-python-env.7z"
        Delete "$INSTDIR\resources\7zr.exe"
    end:
        DetailPrint "Installation completed."
!macroend



!macro customRemoveFiles
  ; Ask the user if they want to keep the models
  MessageBox MB_YESNO "Do you want to keep the models directory?" IDYES keepModels IDNO deleteAll

  deleteAll:
    ; If the user clicked "Yes", delete the entire installation directory
    RMDir /r "$INSTDIR"
    Goto end

  keepModels:
    ; If the user clicked "No", move the models directory to a temporary location in the same drive, delete the installation directory, and then move back the models directory
    StrCpy $0 "$INSTDIR"
    StrCpy $1 "_model_backup"
    StrCpy $2 "$0$1"
    Rename "$INSTDIR\resources\service\models" "$2"
    RMDir /r "$INSTDIR"
    MessageBox MB_OK "backup model directory at $2"

  end:
!macroend