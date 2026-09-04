' Launch Si Pet - hidden background source-preview run
' Double-click this to start the pet with no terminal window.
' Log file: pet-app\.build\launcher.log
Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = "F:\ss_yong\si\pet-si\pet-app"
ws.Run "cmd /c npm run dev 1> .build\launcher.log 2>&1", 0, False
