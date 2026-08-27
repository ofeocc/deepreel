' ============================================================
'  DEEPREEL proxy - autostart (hidden window, background run)
'  ------------------------------------------------------------
'  Usage:
'    1) Double-click this file once to start the proxy now
'    2) Put a shortcut to this file in shell:startup for autostart
'    3) To disable autostart: remove the startup shortcut / this file
'  Note: autostart does NOT open a browser (avoid popups at login).
'        Just use start.bat or open index.html afterwards.
' ============================================================
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' project dir = folder containing this script
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' 0 = hidden window; False = do not wait
sh.Run "cmd /c cd /d """ & dir & """ && set DEEPREEL_NO_OPEN=1 && node proxy.js", 0, False
