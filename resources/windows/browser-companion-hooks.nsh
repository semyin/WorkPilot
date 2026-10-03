; Current-user registration only. The test harness supplies a private registry prefix.
!define /ifndef WP_NATIVE_ROOT "Software"
!define WP_NATIVE_HOST "com.workpilot.browser_companion"

!macro WP_REMOVE_OWNED_HOST VENDOR VIEW
  Push $0
  Push $1
  SetRegView ${VIEW}
  ClearErrors
  ReadRegStr $0 HKCU "${WP_NATIVE_ROOT}\${VENDOR}\NativeMessagingHosts\${WP_NATIVE_HOST}" ""
  ${IfNot} ${Errors}
  ${AndIf} $0 == "$INSTDIR\browser-companion\${WP_NATIVE_HOST}.json"
    ClearErrors
    DeleteRegValue HKCU "${WP_NATIVE_ROOT}\${VENDOR}\NativeMessagingHosts\${WP_NATIVE_HOST}" ""
    ${If} ${Errors}
      SetRegView lastused
      Pop $1
      Pop $0
      MessageBox MB_OK|MB_ICONSTOP "WorkPilot: cannot remove this installation's browser connection. Uninstall stopped; application files were preserved." /SD IDOK
      Abort
    ${EndIf}
    ; NSIS /ifempty alone ignores values. Check both values and subkeys first.
    ClearErrors
    EnumRegValue $1 HKCU "${WP_NATIVE_ROOT}\${VENDOR}\NativeMessagingHosts\${WP_NATIVE_HOST}" 0
    ${If} ${Errors}
      ClearErrors
      EnumRegKey $1 HKCU "${WP_NATIVE_ROOT}\${VENDOR}\NativeMessagingHosts\${WP_NATIVE_HOST}" 0
      ${If} ${Errors}
        DeleteRegKey /ifempty HKCU "${WP_NATIVE_ROOT}\${VENDOR}\NativeMessagingHosts\${WP_NATIVE_HOST}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  SetRegView lastused
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
  !insertmacro WP_REMOVE_OWNED_HOST "Google\Chrome" 32
  !insertmacro WP_REMOVE_OWNED_HOST "Google\Chrome" 64
  !insertmacro WP_REMOVE_OWNED_HOST "Microsoft\Edge" 32
  !insertmacro WP_REMOVE_OWNED_HOST "Microsoft\Edge" 64
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
  Push $0
  ; The manifest is generated at setup time, so it is not in the static resource list.
  ; Never follow a substituted installation or companion directory junction.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntOp $0 $0 & 0x400
  ${If} $0 = 0
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\browser-companion") i.r0'
    IntOp $0 $0 & 0x400
    ${If} $0 = 0
      Delete "$INSTDIR\browser-companion\${WP_NATIVE_HOST}.json"
      RMDir "$INSTDIR\browser-companion"
      RMDir "$INSTDIR"
    ${EndIf}
  ${EndIf}
  Pop $0
  ${EndIf}
!macroend
