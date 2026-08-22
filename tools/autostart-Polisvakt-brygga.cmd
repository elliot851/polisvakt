@echo off
rem Polisvakt — startar bryggan vid inloggning.
rem
rem VARFOR AUTOSTART-MAPPEN OCH INTE SCHEMALAGGAREN
rem
rem Schemalaggaren provades i flera former: direkt mot brygg-daemon.ps1, med
rem -Command och omdirigering, och via ett mellanlager som startade daemonen i
rem eget fonster. Varje gang startade processen, drog CPU och skrev inte en
rem enda rad i loggen — inte ens sin egen STARTrad. Samma kommando kort for
rem hand gick igenom varje gang.
rem
rem Miljon uteslots med tools\brygg-diag.ps1, som kordes SOM EN UPPGIFT och
rem gjorde precis det daemonen gor innan sin forsta loggrad: samma anvandare,
rem samma LOCALAPPDATA, skrivning ok, Write-Host ok, Global-mutex ok, lasning
rem av bryggfilen ok. Allt gront. Skillnaden sitter i sjalva sessionen
rem Schemalaggaren skapar, inte i rattigheter eller sokvagar.
rem
rem Autostart-mappen startas av Utforskaren i anvandarens vanliga
rem interaktiva session. Det ar samma sorts process som ett dubbelklick, och
rem dubbelklick fungerar bevisligen.
rem
rem Dubbelstart ar ofarlig: brygg-daemon.ps1 tar en namngiven mutex och den
rem andra sager ifran och avslutar.

start "Polisvakt-brygga" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\ellio\OneDrive\Claude code 2GNDTN\polisvakt\tools\brygg-daemon.ps1" -Felsokningsport 9222
