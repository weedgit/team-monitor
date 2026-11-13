!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Team Monitor Admin 3921"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Team Monitor Admin 3921" dir=in action=allow protocol=TCP localport=3921 profile=any remoteip=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16'
  Pop $0
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Team Monitor Admin 3921"'
  Pop $0
!macroend
