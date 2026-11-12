@echo off
rem Khoi dong MTD: dung Python trong ml\.venv (co san PhoWhisper nhan dang giong noi tieng Viet).
rem Neu chua co ml\.venv thi dung Python cua may (MTD van chay, nhan dang giong bang trinh duyet).
cd /d "%~dp0"
if exist "ml\.venv\Scripts\python.exe" (
  start "" http://localhost:5500
  "ml\.venv\Scripts\python.exe" server.py
) else (
  start "" http://localhost:5500
  python server.py
)
pause
