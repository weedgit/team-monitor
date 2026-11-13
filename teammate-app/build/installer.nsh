!macro customInstall
  ; Keep the uninstall key so the admin command can still find it, but hide the app from Settings.
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "SystemComponent" 1
!macroend

!macro customUnInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  IfErrors 0 tm_allow_uninstall
  IfFileExists "$APPDATA\Team Monitor\allow-uninstall" 0 tm_block_uninstall
  Delete "$APPDATA\Team Monitor\allow-uninstall"
  Goto tm_allow_uninstall
tm_block_uninstall:
  MessageBox MB_ICONSTOP|MB_OK "Only the Team Monitor admin can remove this app."
  Abort
tm_allow_uninstall:
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'schtasks /Delete /F /TN "Team Monitor Teammate Guard"'
  Pop $0
  Delete "$APPDATA\Team Monitor\guard.ps1"
  Delete "$APPDATA\Team Monitor\guard.vbs"
  Delete "$APPDATA\Team Monitor\paused"
!macroend
