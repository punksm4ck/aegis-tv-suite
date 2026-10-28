# setup_windows.ps1 - set up AEGIS TV-OPS on this Windows PC.
# Run from the repo folder:
#   powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1 [-SoftwareDecode] [-DvrDir C:\path]
param([switch]$SoftwareDecode, [string]$DvrDir = "")

$repo = $PSScriptRoot
$dir = Join-Path $HOME ".aegis_tv"
New-Item -ItemType Directory -Force $dir | Out-Null
$ico = Join-Path $dir "tvops.ico"
$launcher = Join-Path $dir "tvops_launcher.pyw"

# 1. prerequisites
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pyCmd -or $pyCmd.Source -like "*WindowsApps*") {
  throw "Real Python not found. Install: winget install Python.Python.3.12  (then open a new terminal)"
}
$py = $pyCmd.Source
$pyw = Join-Path (Split-Path $py) "pythonw.exe"
if (-not (Test-Path $pyw)) { throw "pythonw.exe not found next to $py" }
$bits = (& python -c "import struct;print(struct.calcsize('P')*8)").Trim()
$vlc = @("C:\Program Files\VideoLAN\VLC\vlc.exe", "C:\Program Files (x86)\VideoLAN\VLC\vlc.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vlc) { throw "VLC not found. Install: winget install VideoLAN.VLC" }
"python ($bits-bit): $py"
"vlc: $vlc"
if ($bits -eq "64" -and $vlc -like "*(x86)*") {
  Write-Warning "VLC looks 32-bit but Python is 64-bit; embedded video will not load. Install 64-bit VLC."
}

# 2. packages
python -m pip install PyQt6 python-vlc keyring
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# 3. site password, encrypted for this Windows account (DPAPI)
$pwf = Join-Path $dir "pw.dpapi"
if (-not (Test-Path $pwf)) {
  Read-Host "TV site password" -AsSecureString | ConvertFrom-SecureString | Set-Content $pwf
  "password saved (encrypted for this Windows account)"
} else { "password file already present" }
Push-Location $repo
$chk = & python -c "import epg_data; print('password length:', len(epg_data._password()))" 2>&1
$chk | Select-Object -Last 3
Pop-Location

# 4. icon (uses ~\.aegis_tv\icon_src.png if you put one there, otherwise draws one)
@'
import os, struct, sys
os.environ["QT_QPA_PLATFORM"] = "offscreen"
from PyQt6.QtGui import QGuiApplication, QImage, QPainter, QColor, QPen, QBrush, QFont
from PyQt6.QtCore import Qt, QRectF, QBuffer, QByteArray, QIODevice
app = QGuiApplication(sys.argv)
d = os.path.join(os.path.expanduser("~"), ".aegis_tv")
os.makedirs(d, exist_ok=True)
src = os.path.join(d, "icon_src.png")
if not os.path.isfile(src):
    N = 1024
    img = QImage(N, N, QImage.Format.Format_ARGB32)
    img.fill(Qt.GlobalColor.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setBrush(QBrush(QColor("#0a0d08"))); p.setPen(QPen(QColor("#ffb000"), 28))
    p.drawRoundedRect(QRectF(60, 60, N - 120, N - 120), 190, 190)
    p.setBrush(QBrush(QColor("#11160e"))); p.setPen(QPen(QColor("#3f6020"), 18))
    p.drawRoundedRect(QRectF(190, 230, N - 380, 440), 40, 40)
    p.setPen(QPen(QColor("#1f3010"), 6))
    for y in range(250, 660, 28):
        p.drawLine(200, y, N - 200, y)
    f = QFont("Consolas"); f.setBold(True); f.setPixelSize(250)
    p.setFont(f); p.setPen(QColor("#ffb000"))
    p.drawText(QRectF(190, 230, N - 380, 440), Qt.AlignmentFlag.AlignCenter, "TV")
    f.setPixelSize(120); p.setFont(f); p.setPen(QColor("#ff3b3b"))
    p.drawText(QRectF(60, 720, N - 120, 180), Qt.AlignmentFlag.AlignCenter, "OPS // AEGIS")
    p.end()
    img.save(src)
img = QImage(src)
if img.isNull():
    sys.exit("cannot read " + src)
entries = []
for n in (256, 48, 32, 16):
    im = img.scaled(n, n, Qt.AspectRatioMode.IgnoreAspectRatio, Qt.TransformationMode.SmoothTransformation)
    ba = QByteArray(); buf = QBuffer(ba); buf.open(QIODevice.OpenModeFlag.WriteOnly)
    im.save(buf, "PNG"); buf.close()
    entries.append((n, bytes(ba)))
head = struct.pack("<HHH", 0, 1, len(entries))
off = 6 + 16 * len(entries)
dirs, data = b"", b""
for n, png in entries:
    w = 0 if n >= 256 else n
    dirs += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(png), off + len(data))
    data += png
open(os.path.join(d, "tvops.ico"), "wb").write(head + dirs + data)
print("tvops.ico written")
'@ | python -
if (-not (Test-Path $ico)) { throw "icon was not created" }

# 5. console-less launcher that logs to ~\.aegis_tv\launch.log
$extra = ""
if ($SoftwareDecode) { $extra += 'os.environ.setdefault("AEGIS_VLC_ARGS", "--avcodec-hw=none")' + "`n" }
if ($DvrDir) { $extra += 'os.environ.setdefault("AEGIS_DVR_DIR", r"' + $DvrDir + '")' + "`n" }
$code = @'
import os, sys
__EXTRA__
root = r"__REPO__"
os.chdir(root)
sys.path.insert(0, root)
d = os.path.join(os.path.expanduser("~"), ".aegis_tv")
os.makedirs(d, exist_ok=True)
sys.stdout = sys.stderr = open(os.path.join(d, "launch.log"), "a", buffering=1, encoding="utf-8")
import aegis_tv_qt
aegis_tv_qt.main()
'@
$code = $code.Replace("__REPO__", $repo).Replace("__EXTRA__", $extra.TrimEnd())
Set-Content -Encoding utf8 $launcher $code

# 6. shortcuts: Desktop + Start Menu
$ws = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = $ws.CreateShortcut((Join-Path $folder "AEGIS TV-OPS.lnk"))
  $lnk.TargetPath = $pyw
  $lnk.Arguments = '"' + $launcher + '"'
  $lnk.WorkingDirectory = $repo
  $lnk.IconLocation = "$ico,0"
  $lnk.Description = "AEGIS // TV-OPS"
  $lnk.Save()
  "created: " + (Join-Path $folder "AEGIS TV-OPS.lnk")
}
"Done. Open AEGIS TV-OPS from the Desktop or Start Menu. Errors go to $dir\launch.log"
