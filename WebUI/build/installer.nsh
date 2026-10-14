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
      ; The app launches backends from this folder. Reject empty, relative, and
      ; UNC paths here so a typed \\server\share never reaches HKLM.
      ${if} $AipgSharedDir == ""
        MessageBox MB_ICONSTOP "Choose a local folder for shared resources."
        Abort
      ${endif}
      StrCpy $1 $AipgSharedDir 2
      ${if} $1 == "\\"
      ${orif} $1 == "//"
        MessageBox MB_ICONSTOP "Choose a local folder. Network paths are not allowed."
        Abort
      ${endif}
      StrCpy $1 $AipgSharedDir 1 1
      ${if} $1 != ":"
        MessageBox MB_ICONSTOP "Choose a local folder on a drive, such as C:\AI Playground."
        Abort
      ${endif}
      StrCpy $1 $AipgSharedDir 1 2
      ${if} $1 != "\"
      ${andif} $1 != "/"
        MessageBox MB_ICONSTOP "Choose a local folder on a drive, such as C:\AI Playground."
        Abort
      ${endif}
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
    ; here. The choice is stored in HKLM (standard users cannot write it) — not
    ; under %PUBLIC%, where any account can create a file. See
    ; electron/kernel/installConfig.ts.
    ;   $R0 = %PUBLIC%  $R1 = legacy config dir  $R2 = shared resources base
    ;   $R3 = file handle / exec result  $R4 = ACL script path
    ${if} $installMode != "CurrentUser"
      ReadEnvStr $R0 "PUBLIC"
      ${if} $R0 == ""
        StrCpy $R0 "C:\Users\Public"
      ${endif}
      StrCpy $R1 "$R0\AI Playground"

      ; Silent installs never show the custom page, so the vars are empty — fall
      ; back to the shared default (the previous silent-install behaviour).
      ${if} $AipgShareState == ""
        StrCpy $AipgShareState "1"
      ${endif}
      ${if} $AipgSharedDir == ""
        StrCpy $AipgSharedDir "$R1"
      ${endif}

      SetRegView 64
      ${if} $AipgShareState == "1"
        StrCpy $R2 "$AipgSharedDir"
        CreateDirectory "$R2"
        ; A junction here would make icacls /T edit the link target. Refuse the
        ; base, and unlink a resources junction before the tree walk.
        nsExec::ExecToLog 'fsutil reparsepoint query "$R2"'
        Pop $R3
        ${if} $R3 == 0
          DetailPrint "Shared resources folder is a link: $R2"
          IfSilent +2
          MessageBox MB_ICONSTOP "The shared resources folder cannot be a shortcut or link.$\r$\n$\r$\nFolder: $R2"
          Abort
        ${endif}
        nsExec::ExecToLog 'fsutil reparsepoint query "$R2\resources"'
        Pop $R3
        ${if} $R3 == 0
          DetailPrint "Removing link at $R2\resources"
          nsExec::ExecToLog 'cmd /c rmdir "$R2\resources"'
          Pop $R3
          ${if} $R3 != 0
            DetailPrint "Failed to remove link at $R2\resources (exit $R3)."
            IfSilent +2
            MessageBox MB_ICONSTOP "AI Playground could not remove a link inside the shared resources folder.$\r$\n$\r$\nFolder: $R2\resources"
            Abort
          ${endif}
        ${endif}
        ; Owner must be BUILTIN\Administrators. The app rejects any other owner,
        ; which is how a folder a standard user created beforehand is ignored.
        ; S-1-5-32-544 = Administrators, S-1-5-18 = SYSTEM, S-1-5-32-545 = Users.
        nsExec::ExecToLog 'icacls "$R2" /setowner "*S-1-5-32-544" /C'
        Pop $R3
        ${if} $R3 != 0
          DetailPrint "Failed to take ownership of $R2 (icacls exit $R3)."
          IfSilent +2
          MessageBox MB_ICONSTOP "AI Playground could not take ownership of the shared resources folder (icacls exit $R3).$\r$\n$\r$\nFolder: $R2$\r$\n$\r$\nSetup will stop so backends are not launched from a folder another account owns."
          Abort
        ${endif}
        ; Replace the directory DACL outright. /grant alone would keep an ACE a
        ; previous owner left behind.
        StrCpy $R4 "$TEMP\aipg-shared-acl.ps1"
        ClearErrors
        FileOpen $R3 $R4 w
        ${if} ${errors}
          DetailPrint "Could not write the shared-folder ACL script."
          IfSilent +2
          MessageBox MB_ICONSTOP "AI Playground could not update the shared resources folder permissions."
          Abort
        ${endif}
        FileWrite $R3 '$$ErrorActionPreference = "Stop"$\r$\n'
        FileWrite $R3 'try {$\r$\n'
        FileWrite $R3 '  $$p = $$args[0]$\r$\n'
        FileWrite $R3 '  if (-not $$p) { exit 2 }$\r$\n'
        FileWrite $R3 '  $$acl = Get-Acl -LiteralPath $$p$\r$\n'
        FileWrite $R3 '  $$admin = New-Object System.Security.Principal.SecurityIdentifier "S-1-5-32-544"$\r$\n'
        FileWrite $R3 '  $$system = New-Object System.Security.Principal.SecurityIdentifier "S-1-5-18"$\r$\n'
        FileWrite $R3 '  $$users = New-Object System.Security.Principal.SecurityIdentifier "S-1-5-32-545"$\r$\n'
        FileWrite $R3 '  $$acl.SetAccessRuleProtection($$true, $$false)$\r$\n'
        FileWrite $R3 '  foreach ($$rule in @($$acl.Access)) { $$acl.PurgeAccessRules($$rule.IdentityReference) }$\r$\n'
        FileWrite $R3 '  $$inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"$\r$\n'
        FileWrite $R3 '  $$none = [System.Security.AccessControl.PropagationFlags]::None$\r$\n'
        FileWrite $R3 '  $$allow = [System.Security.AccessControl.AccessControlType]::Allow$\r$\n'
        FileWrite $R3 '  $$full = [System.Security.AccessControl.FileSystemRights]::FullControl$\r$\n'
        FileWrite $R3 '  $$modify = [System.Security.AccessControl.FileSystemRights]::Modify$\r$\n'
        FileWrite $R3 '  $$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($$admin, $$full, $$inherit, $$none, $$allow)))$\r$\n'
        FileWrite $R3 '  $$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($$system, $$full, $$inherit, $$none, $$allow)))$\r$\n'
        FileWrite $R3 '  $$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($$users, $$modify, $$inherit, $$none, $$allow)))$\r$\n'
        FileWrite $R3 '  Set-Acl -LiteralPath $$p -AclObject $$acl$\r$\n'
        FileWrite $R3 '} catch {$\r$\n'
        FileWrite $R3 '  Write-Output $$_$\r$\n'
        FileWrite $R3 '  exit 1$\r$\n'
        FileWrite $R3 '}$\r$\n'
        FileClose $R3
        nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$R4" "$R2"'
        Pop $R3
        Delete "$R4"
        ${if} $R3 != 0
          DetailPrint "Failed to replace the ACL on $R2 (powershell exit $R3)."
          IfSilent +2
          MessageBox MB_ICONSTOP "AI Playground could not set permissions on the shared resources folder (exit $R3).$\r$\n$\r$\nFolder: $R2$\r$\n$\r$\nSetup will stop so backends are not left usable by only one account."
          Abort
        ${endif}
        ; Set-Acl can leave the installing user as owner. Put Administrators
        ; back, then grant the same rights on files already in the tree.
        ; (OI)(CI) must stay unescaped: $$ would compile to a literal $(OI),
        ; which icacls does not treat as an inheritance flag.
        ; Shared installs run uv with UV_LINK_MODE=copy so new wheel files are
        ; created here and inherit this grant. Re-applied on every upgrade (/T).
        nsExec::ExecToLog 'icacls "$R2" /setowner "*S-1-5-32-544" /C'
        Pop $R3
        ${if} $R3 != 0
          DetailPrint "Failed to take ownership of $R2 (icacls exit $R3)."
          IfSilent +2
          MessageBox MB_ICONSTOP "AI Playground could not take ownership of the shared resources folder (icacls exit $R3).$\r$\n$\r$\nFolder: $R2$\r$\n$\r$\nSetup will stop so backends are not launched from a folder another account owns."
          Abort
        ${endif}
        nsExec::ExecToLog 'icacls "$R2" /grant "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)M" /T /C'
        Pop $R3
        ${if} $R3 != 0
          DetailPrint "Failed to grant all users write access to $R2 (icacls exit $R3)."
          IfSilent +2
          MessageBox MB_ICONSTOP "AI Playground could not make the shared resources folder writable for every account (icacls exit $R3).$\r$\n$\r$\nFolder: $R2$\r$\n$\r$\nSetup will stop so backends are not left usable by only one account."
          Abort
        ${endif}
        ClearErrors
        WriteRegStr HKLM "Software\AI Playground" "modelFolderMode" "shared"
        WriteRegStr HKLM "Software\AI Playground" "sharedResourcesDir" "$R2"
        ${if} ${errors}
          DetailPrint "Failed to write HKLM\Software\AI Playground."
          IfSilent +2
          MessageBox MB_ICONSTOP "AI Playground could not record the shared resources folder.$\r$\n$\r$\nSetup will stop so the app does not keep a per-user copy by mistake."
          Abort
        ${endif}
      ${else}
        ClearErrors
        WriteRegStr HKLM "Software\AI Playground" "modelFolderMode" "per-user"
        ${if} ${errors}
          DetailPrint "Failed to write HKLM\Software\AI Playground."
          IfSilent +2
          MessageBox MB_ICONSTOP "AI Playground could not record the per-user resources choice."
          Abort
        ${endif}
        ClearErrors
        DeleteRegValue HKLM "Software\AI Playground" "sharedResourcesDir"
        ClearErrors
      ${endif}
      SetRegView lastused
      ; The app no longer reads these. A file planted here must not survive an
      ; all-users install and be picked up by an older build.
      Delete "$R1\install-config.json"
      Delete "$R1\shared-resources-dir.txt"
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


; Append stop/delete steps for one LlamaCPP tree when ada.exe or its service
; script is there. $R9 is the open script, $R7 becomes "1" when any tree matches.
; A normal install has neither file, so uninstall does not show UAC.
!macro appendPhisonAdaCleanupDir
  ${if} ${FileExists} "$R4\ada.exe"
  ${orif} ${FileExists} "$R4\wService_delete.bat"
    StrCpy $R7 "1"
    FileWrite $R9 'cd /d "$R4"$\r$\n'
    ${if} ${FileExists} "$R4\wService_delete.bat"
      FileWrite $R9 'call "$R4\wService_delete.bat"$\r$\n'
    ${endif}
    FileWrite $R9 'taskkill /F /IM ada.exe /T$\r$\n'
    FileWrite $R9 'del /f /q "$R4\ada.exe"$\r$\n'
  ${endif}
!macroend

!macro appendPhisonAdaCleanup LLAMA_CPP_DIR
  StrCpy $R8 "${LLAMA_CPP_DIR}"
  StrCpy $R4 "$R8\llama-cpp-phison"
  !insertmacro appendPhisonAdaCleanupDir
  StrCpy $R4 "$R8\llama-cpp"
  !insertmacro appendPhisonAdaCleanupDir
!macroend

!macro customUnInstall
  ; ada.exe is a Windows service. The uninstaller is asInvoker, so RMDir cannot
  ; stop it and the locked file is left behind. One elevated cmd stops the
  ; service, kills the process, and deletes the binary before that RMDir.
  ; Trees outside $INSTDIR (per-user and shared resources) are not removed by
  ; RMDir, so the same cmd deletes ada.exe there too. No prompt when it is absent.
  StrCpy $R7 "0"
  StrCpy $R6 "$TEMP\aipg-stop-ada.cmd"
  ClearErrors
  FileOpen $R9 $R6 w
  ${ifNot} ${Errors}
    FileWrite $R9 "@echo off$\r$\n"
    !insertmacro appendPhisonAdaCleanup "$INSTDIR\resources\LlamaCPP"
    ReadEnvStr $R8 "LOCALAPPDATA"
    ${if} $R8 != ""
      !insertmacro appendPhisonAdaCleanup "$R8\ai-playground\resources\LlamaCPP"
    ${endif}
    ReadEnvStr $R5 "PUBLIC"
    ${if} $R5 == ""
      StrCpy $R5 "C:\Users\Public"
    ${endif}
    ; Only a drive-letter path from HKLM. Never a path read from %PUBLIC%:
    ; that file is user-writable, and the cleanup script calls wService_delete.bat
    ; elevated.
    SetRegView 64
    ClearErrors
    ReadRegStr $R3 HKLM "Software\AI Playground" "sharedResourcesDir"
    SetRegView lastused
    ${if} $R3 != ""
      StrCpy $R8 $R3 2
      ${if} $R8 != "\\"
      ${andif} $R8 != "//"
        StrCpy $R8 $R3 1 1
        ${if} $R8 == ":"
          StrCpy $R8 $R3 1 2
          ${if} $R8 == "\"
          ${orif} $R8 == "/"
            !insertmacro appendPhisonAdaCleanup "$R3\resources\LlamaCPP"
          ${endif}
        ${endif}
      ${endif}
    ${endif}
    StrCpy $R8 "$R5\AI Playground"
    !insertmacro appendPhisonAdaCleanup "$R8\resources\LlamaCPP"
    FileClose $R9
    ${if} $R7 == "1"
      DetailPrint "Stopping aiDAPTIV service before removing ada.exe"
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath $\'$R6$\' -Verb RunAs -WindowStyle Hidden -Wait"'
      Pop $R5
      ${if} $R5 != 0
        DetailPrint "Could not stop aiDAPTIV (ada.exe). Uninstall continues; ada.exe may remain if the service is still running."
      ${endif}
    ${endif}
    Delete "$R6"
  ${endif}

  ; Remove only the machine-wide install markers (mode + shared-folder path) so a
  ; future reinstall re-prompts for the choices. The shared resources tree and
  ; each user's per-user working tree (%LOCALAPPDATA%\ai-playground) are
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
  ; HKLM is not writable unelevated. If the key survives, ask once via UAC.
  SetRegView 64
  ClearErrors
  DeleteRegKey HKLM "Software\AI Playground"
  ClearErrors
  ReadRegStr $R1 HKLM "Software\AI Playground" "modelFolderMode"
  ${if} $R1 != ""
    StrCpy $R6 "$TEMP\aipg-remove-install-config.cmd"
    ClearErrors
    FileOpen $R9 $R6 w
    ${ifNot} ${Errors}
      FileWrite $R9 '@echo off$\r$\n'
      FileWrite $R9 'reg delete "HKLM\Software\AI Playground" /f /reg:64$\r$\n'
      FileClose $R9
      DetailPrint "Removing machine-wide install config"
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath $\'$R6$\' -Verb RunAs -WindowStyle Hidden -Wait"'
      Pop $R1
      ${if} $R1 != 0
        DetailPrint "Could not remove HKLM\Software\AI Playground (exit $R1)."
      ${endif}
      Delete "$R6"
    ${endif}
  ${endif}
  SetRegView lastused
!macroend
