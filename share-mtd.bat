@echo off
chcp 65001 >nul
rem ============================================================
rem  CHIA SE MTD QUA INTERNET (Cloudflare Tunnel - mien phi, khong can tai khoan)
rem  - Tao mot link https://....trycloudflare.com de gui cho nguoi khac.
rem  - Link chi song khi cua so nay con mo VA may tinh dang bat.
rem  - Dong cua so nay = link ngung hoat dong ngay lap tuc.
rem  - Moi lan chay lai se ra mot link MOI (link cu het hieu luc).
rem ============================================================
cd /d "%~dp0"
set CF=D:\cloudflared\cloudflared.exe

if not exist "%CF%" (
  echo Chua co cloudflared. Tai file "cloudflared-windows-amd64.exe" tai:
  echo   https://github.com/cloudflare/cloudflared/releases/latest
  echo roi doi ten thanh cloudflared.exe va dat vao thu muc D:\cloudflared\
  pause
  exit /b 1
)

rem Neu server MTD chua chay thi bat no len (cua so rieng).
curl -s -o nul http://127.0.0.1:5500/ || (
  echo Dang bat server MTD...
  if exist "ml\.venv\Scripts\python.exe" (
    start "MTD server" "ml\.venv\Scripts\python.exe" server.py
  ) else (
    start "MTD server" python server.py
  )
  timeout /t 4 >nul
)

echo.
echo ============================================================
echo  Dang tao link... Tim dong co chu  https://....trycloudflare.com
echo  ben duoi, copy va gui cho ban be.  Dong cua so nay de tat link.
echo ============================================================
echo.
"%CF%" tunnel --url http://127.0.0.1:5500
pause
