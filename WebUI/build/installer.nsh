!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customInstallMode
    ; Both flags "0" lets the assisted installer show the install-mode page so a
    ; system administrator can install for all users (elevated) while a normal
    ; user can still install just for themselves (unelevated). Previously
    ; $isForceCurrentInstall was "1", which forced per-user and hid the choice.
    StrCpy $isForceCurrentInstall "0"
    StrCpy $isForceMachineInstall "0"
!macroend

; A custom wizard page (shown after the "choose install folder" page, before the
; install starts) that lets an all-users installer choose whether to share the
; heavy runtime artifacts (models, Python environments, backends - tens of GB)
; across all users and, when sharing, where that shared tree is stored. This
; replaces the earlier yes/no MessageBox + folder-browse popup. The chosen values
; are consumed in customInstall below.
;   $AipgShareState = "1" shared / "0" per-user   $AipgSharedDir = shared base dir
!macro customPageAfterChangeDir
  ; nsDialogs provides the ${NSD_*} helpers and ${BST_CHECKED}; include guards
  ; make these no-ops if MUI2 already pulled them in.
  !include "nsDialogs.nsh"
  !include "WinMessages.nsh"

  Var /GLOBAL AipgShareState
  Var /GLOBAL AipgSharedDir
  Var /GLOBAL AipgShareCheckbox
  Var /GLOBAL AipgFolderText
  Var /GLOBAL AipgBrowseButton

  Page custom aipgResourcesPageCreate aipgResourcesPageLeave

  Function aipgResourcesPageCreate
    ; A per-user (CurrentUser) install keeps the default per-user paths — there
    ; is nothing to choose, so skip the page entirely.
    ${if} $installMode == "CurrentUser"
      Abort
    ${endif}

    ; Seed defaults the first time the page is shown (and after a Back/Next).
    ${if} $AipgSharedDir == ""
      ReadEnvStr $0 "PUBLIC"
      ${if} $0 == ""
        StrCpy $0 "C:\Users\Public"
      ${endif}
      StrCpy $AipgSharedDir "$0\AI Playground"
    ${endif}
    ${if} $AipgShareState == ""
      StrCpy $AipgShareState "1"
    ${endif}

    !insertmacro MUI_HEADER_TEXT "Shared resources" "Choose how downloaded models and runtime files are stored for the users of this computer."

    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}

    ${NSD_CreateLabel} 0 0 100% 34u "AI Playground downloads models, Python environments and backends - tens of GB of data. Share a single copy across all users of this computer, or give each user a private copy."
    Pop $0

    ${NSD_CreateCheckbox} 0 40u 100% 12u "Share models and runtime files across all users (recommended)"
    Pop $AipgShareCheckbox
    ${if} $AipgShareState == "1"
      ${NSD_Check} $AipgShareCheckbox
    ${endif}
    ${NSD_OnClick} $AipgShareCheckbox aipgShareToggle

    ${NSD_CreateLabel} 0 60u 100% 10u "Shared resources folder:"
    Pop $0

    ${NSD_CreateText} 0 72u 78% 12u "$AipgSharedDir"
    Pop $AipgFolderText

    ${NSD_CreateButton} 80% 71u 20% 13u "Browse..."
    Pop $AipgBrowseButton
    ${NSD_OnClick} $AipgBrowseButton aipgBrowseFolder

    ; The folder row is only meaningful when sharing is enabled.
    Call aipgSyncFolderEnabled

    nsDialogs::Show
  FunctionEnd

  Function aipgShareToggle
    Call aipgSyncFolderEnabled
  FunctionEnd

  Function aipgSyncFolderEnabled
    ${NSD_GetState} $AipgShareCheckbox $0
    ${if} $0 == ${BST_CHECKED}
      EnableWindow $AipgFolderText 1
      EnableWindow $AipgBrowseButton 1
    ${else}
      EnableWindow $AipgFolderText 0
      EnableWindow $AipgBrowseButton 0
    ${endif}
  FunctionEnd

  Function aipgBrowseFolder
    ${NSD_GetText} $AipgFolderText $0
    nsDialogs::SelectFolderDialog "Choose where to store the shared AI Playground files (models, Python environments and backends)" "$0"
    Pop $1
    ${if} $1 != "error"
    ${andif} $1 != ""
      ${NSD_SetText} $AipgFolderText "$1"
    ${endif}
  FunctionEnd

  Function aipgResourcesPageLeave
    ${if} $installMode == "CurrentUser"
      Return
    ${endif}
    ${NSD_GetState} $AipgShareCheckbox $0
    ${if} $0 == ${BST_CHECKED}
      StrCpy $AipgShareState "1"
      ${NSD_GetText} $AipgFolderText $AipgSharedDir
    ${else}
      StrCpy $AipgShareState "0"
    ${endif}
  FunctionEnd
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

    ; --- AI Playground: all-users shared/per-user resources choice ---
    ; Only all-users installs get a machine-wide config; a per-user
    ; (CurrentUser) install keeps the default per-user paths and writes nothing
    ; here. The choice (and, when shared, the folder) comes from the custom
    ; "Shared resources" wizard page ($AipgShareState / $AipgSharedDir above).
    ; Uses $R0-$R3 to avoid clobbering $0-$2 used above.
    ;   $R0 = %PUBLIC%  $R1 = config dir  $R2 = shared resources base dir
    ;   $R3 = file handle / exec result
    ${if} $installMode != "CurrentUser"
      ReadEnvStr $R0 "PUBLIC"
      ${if} $R0 == ""
        StrCpy $R0 "C:\Users\Public"
      ${endif}
      StrCpy $R1 "$R0\AI Playground"
      CreateDirectory "$R1"

      ; Silent installs never show the custom page, so the vars are empty — fall
      ; back to the shared default (the previous silent-install behaviour).
      ${if} $AipgShareState == ""
        StrCpy $AipgShareState "1"
      ${endif}
      ${if} $AipgSharedDir == ""
        StrCpy $AipgSharedDir "$R1"
      ${endif}

      ${if} $AipgShareState == "1"
        StrCpy $R2 "$AipgSharedDir"
        CreateDirectory "$R2"
        ; The default base under C:\Users\Public is already writable by all users
        ; via its inherited ACLs, so no grant is needed there. But the admin can
        ; point $AipgSharedDir at an arbitrary folder (e.g. a roomier drive) that
        ; may not be world-writable, so we still grant all users write access here
        ; so the first user to launch can provision the shared resources (venvs,
        ; backends, models - tens of GB) and later users can read them (and any
        ; user can re-provision after an app update). The app creates the
        ; <shared base>\resources subtree at runtime; the inheritable ACE below
        ; propagates to it. On the default Public path this is a harmless no-op.
        ; S-1-5-32-545 = BUILTIN\Users (SID avoids locale-specific group names).
        nsExec::ExecToLog 'icacls "$R2" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C'
        Pop $R3
        ; Record the chosen path in a raw sidecar (avoids JSON backslash-escaping
        ; in NSIS). The app reads it back and roots the shared tree there — see
        ; electron/installConfig.ts and aipgRoot.ts.
        ClearErrors
        FileOpen $R3 "$R1\shared-resources-dir.txt" w
        ${ifNot} ${errors}
          FileWrite $R3 "$R2"
          FileClose $R3
        ${endif}
        ClearErrors
        FileOpen $R3 "$R1\install-config.json" w
        ${ifNot} ${errors}
          FileWrite $R3 '{$\r$\n  "modelFolderMode": "shared"$\r$\n}$\r$\n'
          FileClose $R3
        ${endif}
      ${else}
        ; Drop any stale shared-folder path from a previous shared install.
        Delete "$R1\shared-resources-dir.txt"
        ClearErrors
        FileOpen $R3 "$R1\install-config.json" w
        ${ifNot} ${errors}
          FileWrite $R3 '{$\r$\n  "modelFolderMode": "per-user"$\r$\n}$\r$\n'
          FileClose $R3
        ${endif}
      ${endif}
    ${endif}

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
    Rename "$INSTDIR\resources\models" "$2"
    DetailPrint "backup model directory at $2"

  deleteAll:
    ; If the user clicked "No", delete the entire installation directory
    DetailPrint "Removing existing files..."
    RMDir /r "$INSTDIR"

!macroend


!macro customUnInstall
  ; Remove only the machine-wide install markers (mode + shared-folder path) so a
  ; future reinstall re-prompts for the choices. The shared resources tree (under
  ; %PUBLIC%\AI Playground\resources by default, or the admin-chosen folder)
  ; and each user's per-user working tree (%LOCALAPPDATA%\ai-playground) are
  ; intentionally preserved — they may hold many GB of admin-provisioned models
  ; and cannot be safely enumerated for every user profile from a machine-wide
  ; uninstaller.
  ReadEnvStr $R0 "PUBLIC"
  ${if} $R0 == ""
    StrCpy $R0 "C:\Users\Public"
  ${endif}
  ${if} $R0 != ""
    Delete "$R0\AI Playground\install-config.json"
    Delete "$R0\AI Playground\shared-resources-dir.txt"
  ${endif}
!macroend
