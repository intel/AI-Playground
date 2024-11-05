!macro customHeader
  ShowInstDetails show
!macroend
!macro customInstall
    IfFileExists "$INSTDIR\resources\env.7z" extracting end

    extracting:
        SetDetailsPrint textonly
        DetailPrint "Extracting python environment..."
        nsExec::ExecToLog '"$INSTDIR\resources\7zr.exe" x "$INSTDIR\resources\env.7z" -o"$INSTDIR\resources"'
        Delete "$INSTDIR\resources\env.7z"
        Delete "$INSTDIR\resources\7zr.exe"

        DetailPrint "Downloading and setting up python environment..."
        ; Display a popup message with OK/Cancel options
        MessageBox MB_ICONQUESTION|MB_OKCANCEL "Before installing Python dependencies, please ensure you have a stable internet connection. This could take several minutes. Click OK to proceed or Cancel to abort installation."

        ; Check the return value from MessageBox
        StrCmp $R0 IDCANCEL cancel
        Goto continue

        cancel:
            Abort ; Abort the installation if Cancel is clicked

        continue:
            nsExec::ExecToLog '"$INSTDIR\resources\env\python.exe" "-m" "pip" "install" "-r" "$INSTDIR\resources\service\requirements-arc.txt"'
            nsExec::ExecToLog '"$INSTDIR\resources\env\python.exe" "-m" "pip" "install" "$INSTDIR\resources\arc-ipex-wheels\bigdl_core_xe_23-2.6.0.dev0-cp311-cp311-win_amd64.whl"'
            nsExec::ExecToLog '"$INSTDIR\resources\env\python.exe" "-m" "pip" "install" "$INSTDIR\resources\arc-ipex-wheels\bigdl_core_xe_addons_23-2.6.0.dev0-cp311-cp311-win_amd64.whl"'
            nsExec::ExecToLog '"$INSTDIR\resources\env\python.exe" "-m" "pip" "install" "$INSTDIR\resources\arc-ipex-wheels\bigdl_core_xe_batch_23-2.6.0.dev0-cp311-cp311-win_amd64.whl"'
            nsExec::ExecToLog '"$INSTDIR\resources\env\python.exe" "-m" "pip" "install" "$INSTDIR\resources\arc-ipex-wheels\intel_extension_for_pytorch-2.3.110+xpu-cp311-cp311-win_amd64.whl"'
            nsExec::ExecToLog '"$INSTDIR\resources\env\python.exe" "-m" "pip" "install" "$INSTDIR\resources\arc-ipex-wheels\torch-2.3.1+cxx11.abi-cp311-cp311-win_amd64.whl"'
            nsExec::ExecToLog '"$INSTDIR\resources\env\python.exe" "-m" "pip" "install" "$INSTDIR\resources\arc-ipex-wheels\torchaudio-2.3.1+cxx11.abi-cp311-cp311-win_amd64.whl"'
            nsExec::ExecToLog '"$INSTDIR\resources\env\python.exe" "-m" "pip" "install" "$INSTDIR\resources\arc-ipex-wheels\torchvision-0.18.1+cxx11.abi-cp311-cp311-win_amd64.whl"'
    end:
        SetDetailsPrint both
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