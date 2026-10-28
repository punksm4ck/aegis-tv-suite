#!/usr/bin/env python3
"""AEGIS TV // OPS  -  PyQt6 live TV console with embedded VLC and a 72h program guide.

Data : site login (macOS Keychain) via epg_data.load_all() for the lineup + guide,
       plus the large channel playlist used by the original tuner for direct stream URLs.
Video: libvlc embedded in a native Qt widget. Set AEGIS_TV_EXTERNAL=1 to force the
       external VLC app instead (safe mode).
Keys : F2 guide  F3 now  F4 mute  F5 refresh  F11 fullscreen  Ctrl+F search
"""
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urlparse

try:
    import vlc
    VLC_ERR = ""
except (Exception, SystemExit) as _ex:  # python-vlc missing or libvlc not found
    vlc = None
    VLC_ERR = str(_ex) or 'libvlc not found'

try:
    from epg_data import load_all
    EPG_ERR = ""
except Exception as _ex:
    load_all = None
    EPG_ERR = str(_ex)

from PyQt6.QtCore import Qt, QObject, QThread, QTimer, pyqtSignal
from PyQt6.QtGui import (QBrush, QColor, QFont, QFontMetrics, QKeySequence,
                         QPen, QShortcut)
from PyQt6.QtWidgets import (
    QAbstractItemView, QApplication, QCheckBox, QComboBox, QFileDialog, QFrame,
    QGraphicsItem, QGraphicsRectItem, QGraphicsScene, QGraphicsSimpleTextItem,
    QGraphicsView, QGridLayout, QHBoxLayout, QHeaderView, QLabel, QLineEdit,
    QMainWindow, QPushButton, QSlider, QSplitter, QTreeWidget, QTreeWidgetItem,
    QVBoxLayout, QWidget)

BASE = os.environ.get("AEGIS_TV_BASE", "https://tv.punksm4ck.com")
CACHE = os.path.expanduser("~/.aegis_tv")
SUITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aegis_tv_suite.py")
EXTERNAL = os.environ.get("AEGIS_TV_EXTERNAL") == "1"
MONO = "Menlo" if sys.platform == "darwin" else "Consolas"
DEFAULT_M3U = "https://iptv-org.github.io/iptv/countries/us.m3u"

PX_MIN, ROW_H, NAME_W, HEAD_H, SLOT, HOURS = 4, 34, 200, 28, 30, 72
BG, PANEL, GRID, CELL, AIR, EMPTY = "#0a0d08", "#11160e", "#2a3722", "#162012", "#3f6020", "#0d110a"
FG, DIM, ACCENT, RED = "#c8d8b0", "#6f8060", "#ffb000", "#ff3b3b"

QSS = f"""
* {{ color: {FG}; }}
QMainWindow, QWidget {{ background: {BG}; }}
QLineEdit, QComboBox, QTreeWidget {{ background: {PANEL}; border: 1px solid {GRID};
    selection-background-color: {AIR}; selection-color: {FG}; padding: 3px; }}
QComboBox QAbstractItemView {{ background: {PANEL}; selection-background-color: {AIR}; }}
QPushButton {{ background: {PANEL}; border: 1px solid {GRID}; padding: 4px 10px; color: {ACCENT}; }}
QPushButton:hover {{ border-color: {ACCENT}; }}
QPushButton:pressed {{ background: {AIR}; }}
QPushButton:disabled {{ color: {DIM}; }}
QHeaderView::section {{ background: {PANEL}; color: {ACCENT}; border: 0;
    border-bottom: 1px solid {GRID}; padding: 3px; }}
QSplitter::handle {{ background: {GRID}; }}
QStatusBar {{ background: {PANEL}; }}
QLabel#info, QLabel#title {{ color: {ACCENT}; }}
QScrollBar:vertical {{ background: {PANEL}; width: 12px; margin: 0; }}
QScrollBar::handle:vertical {{ background: {GRID}; min-height: 24px; }}
QScrollBar:horizontal {{ background: {PANEL}; height: 12px; margin: 0; }}
QScrollBar::handle:horizontal {{ background: {GRID}; min-width: 24px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: {PANEL}; }}
QSlider::groove:horizontal {{ height: 4px; background: {GRID}; }}
QSlider::handle:horizontal {{ background: {ACCENT}; width: 10px; margin: -5px 0; }}
QGraphicsView {{ border: 0; background: {EMPTY}; }}
"""


# ----------------------------------------------------------------- helpers
def norm(s):  # same normalizer as epg_build.py / server.js gnorm()
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", (s or "").lower())
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\b(pluto|hd|channel)\b", " ", s))


def safe_url(u):
    """Only plain http(s) URLs ever reach VLC or the OS."""
    u = (u or "").strip()
    p = urlparse(u)
    return u if p.scheme in ("http", "https") and p.netloc and not u.startswith("-") else ""


def fmt_t(t):
    return datetime.fromtimestamp(t).strftime("%I:%M %p").lstrip("0")


def parse_m3u(text):
    out, cur = [], None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXTINF"):
            g = re.search(r'group-title="([^"]*)"', line)
            cur = {"name": line.rsplit(",", 1)[-1].strip(), "group": g.group(1) if g else ""}
        elif line and not line.startswith("#") and cur:
            cur["url"] = line
            out.append(cur)
            cur = None
    return out


def fetch_text(url, cache_name, timeout=60):
    os.makedirs(CACHE, mode=0o700, exist_ok=True)
    path = os.path.join(CACHE, cache_name)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "aegis-tv-qt/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode("utf-8", "ignore")
        if "#EXTM3U" not in text[:1024]:
            raise ValueError("not an M3U playlist")
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(path + ".tmp", path)
        return text, False
    except Exception:
        if os.path.exists(path):
            with open(path, encoding="utf-8", errors="ignore") as f:
                return f.read(), True
        raise


def find_source_url():
    env = os.environ.get("AEGIS_TV_M3U", "").strip()
    if env:
        return safe_url(env)
    try:
        with open(SUITE, encoding="utf-8", errors="ignore") as f:
            src = f.read()
        m = re.search(r"def fetch_channels\(.*?(?=\n    def |\Z)", src, re.S)
        if m:
            for u in re.findall(r"https?://[^\s'\")\]]+", m.group(0)):
                if "{" not in u and "}" not in u:
                    return safe_url(u)
    except OSError:
        pass
    return DEFAULT_M3U


def external_open(url):
    url = safe_url(url)
    if not url:
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-a", "VLC", url])
    else:
        exe = shutil.which("vlc") or next((x for x in (
            r"C:\Program Files\VideoLAN\VLC\vlc.exe",
            r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe") if os.path.exists(x)), None)
        if exe:
            subprocess.Popen([exe, url])
        else:
            webbrowser.open(url)


@dataclass
class Channel:
    name: str
    group: str = ""
    url: str = ""
    site_id: str = ""
    progs: list = field(default_factory=list)
    in_lineup: bool = False
    num: int = 0


def now_prog(ch, t=None):
    t = t or time.time()
    for p in ch.progs:
        if p["s"] <= t < p["e"]:
            return p
    return None


# ----------------------------------------------------------------- loader
class Loader(QThread):
    done = pyqtSignal(object)

    def run(self):
        out = {"site": [], "site_stale": False, "site_err": "",
               "avail": [], "avail_stale": False, "avail_err": "", "avail_src": ""}
        try:
            if load_all is None:
                raise RuntimeError("epg_data.py not importable: " + EPG_ERR)
            chans, stale = load_all()
            out["site"], out["site_stale"] = chans, stale
        except Exception as ex:
            out["site_err"] = str(ex)
        try:
            url = find_source_url()
            if not url:
                raise RuntimeError("no playlist source found (set AEGIS_TV_M3U or use Load M3U)")
            out["avail_src"] = url
            text, stale = fetch_text(url, "available.m3u")
            out["avail"], out["avail_stale"] = parse_m3u(text), stale
        except Exception as ex:
            out["avail_err"] = str(ex)
        self.done.emit(out)


# ------------------------------------------------------------ guide items
class Bus(QObject):
    tune = pyqtSignal(object)
    hover = pyqtSignal(object, object)


class NameCell(QGraphicsRectItem):
    def __init__(self, ch, bus, w, h, font):
        super().__init__(0, 0, w, h)
        self.ch, self.bus = ch, bus
        self.setPen(QPen(Qt.PenStyle.NoPen))
        self.setBrush(QBrush(QColor(PANEL)))
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip(ch.name)
        fm = QFontMetrics(font)
        t = QGraphicsSimpleTextItem(fm.elidedText(ch.name, Qt.TextElideMode.ElideRight, int(w - 14)), self)
        t.setFont(font)
        t.setBrush(QBrush(QColor(FG if ch.url else DIM)))
        t.setPos(8, (h - fm.height()) / 2)
        t.setAcceptedMouseButtons(Qt.MouseButton.NoButton)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.bus.tune.emit(self.ch)
        e.accept()


class ProgItem(QGraphicsRectItem):
    def contextMenuEvent(self, e):
        try:
            import dvr
            dvr.prog_menu(self.ch, self.prog, e.screenPos())
        except Exception as ex:
            print("dvr menu:", ex)
        e.accept()

    def __init__(self, x, y, w, h, ch, prog, bus, airing, font):
        super().__init__(0, 0, w, h)
        self.setPos(x, y)
        self.ch, self.prog, self.bus = ch, prog, bus
        self.setAcceptHoverEvents(True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemClipsChildrenToShape, True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setBrush(QBrush(QColor(AIR if airing else CELL)))
        self.setPen(QPen(QColor(GRID)))
        self.setToolTip(f"{prog['t']}\n{fmt_t(prog['s'])} - {fmt_t(prog['e'])}")
        if w >= 24:
            fm = QFontMetrics(font)
            t = QGraphicsSimpleTextItem(
                fm.elidedText(prog["t"], Qt.TextElideMode.ElideRight, int(w - 10)), self)
            t.setFont(font)
            t.setBrush(QBrush(QColor(FG)))
            t.setPos(6, (h - fm.height()) / 2)
            t.setAcceptedMouseButtons(Qt.MouseButton.NoButton)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.bus.tune.emit(self.ch)
        e.accept()

    def hoverEnterEvent(self, e):
        self.bus.hover.emit(self.ch, self.prog)


class EmptyCell(QGraphicsRectItem):
    def __init__(self, ch, bus, w, h, font):
        super().__init__(0, 0, w, h)
        self.ch, self.bus = ch, bus
        self.setPen(QPen(Qt.PenStyle.NoPen))
        self.setBrush(QBrush(Qt.BrushStyle.NoBrush))
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        fm = QFontMetrics(font)
        f = QFont(font)
        f.setItalic(True)
        t = QGraphicsSimpleTextItem("No guide data - click to tune" if ch.url
                                    else "No guide data, no stream URL", self)
        t.setFont(f)
        t.setBrush(QBrush(QColor(DIM)))
        t.setPos(10, (h - fm.height()) / 2)
        t.setAcceptedMouseButtons(Qt.MouseButton.NoButton)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.bus.tune.emit(self.ch)
        e.accept()


class FollowView(QGraphicsView):
    """Header / name column: no user scrolling, wheel is forwarded to the grid."""

    def __init__(self, scene, target):
        super().__init__(scene)
        self.target = target

    def wheelEvent(self, e):
        pd, ad = e.pixelDelta(), e.angleDelta()
        dx, dy = (pd.x(), pd.y()) if not pd.isNull() else (ad.x() // 2, ad.y() // 2)
        v, h = self.target.verticalScrollBar(), self.target.horizontalScrollBar()
        v.setValue(v.value() - dy)
        h.setValue(h.value() - dx)
        e.accept()


class GuidePanel(QWidget):
    def __init__(self, bus):
        super().__init__()
        self.bus = bus
        self.font_ = QFont(MONO, 10)
        self.t0, self.H = 0, 1
        self.now_g = self.now_h = None
        self.head_scene, self.names_scene, self.grid_scene = QGraphicsScene(), QGraphicsScene(), QGraphicsScene()
        self.grid_view = QGraphicsView(self.grid_scene)
        self.head_view = FollowView(self.head_scene, self.grid_view)
        self.names_view = FollowView(self.names_scene, self.grid_view)
        al = Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop
        on, off = Qt.ScrollBarPolicy.ScrollBarAlwaysOn, Qt.ScrollBarPolicy.ScrollBarAlwaysOff
        for v in (self.grid_view, self.head_view, self.names_view):
            v.setFrameShape(QFrame.Shape.NoFrame)
            v.setAlignment(al)
            v.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.MinimalViewportUpdate)
        self.grid_view.setHorizontalScrollBarPolicy(on)
        self.grid_view.setVerticalScrollBarPolicy(on)
        self.head_view.setHorizontalScrollBarPolicy(off)
        self.head_view.setVerticalScrollBarPolicy(on)    # matches the grid's width
        self.names_view.setVerticalScrollBarPolicy(off)
        self.names_view.setHorizontalScrollBarPolicy(on)  # matches the grid's height
        self.head_view.setFixedHeight(HEAD_H)
        self.names_view.setFixedWidth(NAME_W)
        self.grid_view.horizontalScrollBar().valueChanged.connect(self.head_view.horizontalScrollBar().setValue)
        self.grid_view.verticalScrollBar().valueChanged.connect(self.names_view.verticalScrollBar().setValue)

        title = QLabel("PROGRAM GUIDE // 72H")
        title.setObjectName("title")
        self.btn_now = QPushButton("NOW (F3)")
        self.btn_now.clicked.connect(self.jump_now)
        top = QHBoxLayout()
        top.setContentsMargins(6, 4, 6, 4)
        top.addWidget(title)
        top.addStretch()
        top.addWidget(self.btn_now)
        grid = QGridLayout()
        grid.setSpacing(0)
        grid.setContentsMargins(0, 0, 0, 0)
        corner = QLabel("  CHANNEL")
        corner.setFixedSize(NAME_W, HEAD_H)
        corner.setObjectName("info")
        grid.addWidget(corner, 0, 0)
        grid.addWidget(self.head_view, 0, 1)
        grid.addWidget(self.names_view, 1, 0)
        grid.addWidget(self.grid_view, 1, 1)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        lay.addLayout(top)
        lay.addLayout(grid, 1)

    def rebuild(self, chans):
        now = time.time()
        self.t0 = int(now // (SLOT * 60)) * SLOT * 60
        span = HOURS * 60
        GRP_H = 22
        runs, prev = 0, None
        for _c in chans:
            _k = (_c.group or 'Other').split(';')[0]
            if _k != prev:
                runs += 1
                prev = _k
        W, H = span * PX_MIN, max(len(chans) * ROW_H + runs * GRP_H, 1)
        self.H = H
        self.now_g = self.now_h = None
        for s in (self.head_scene, self.names_scene, self.grid_scene):
            s.clear()
        self.head_scene.setSceneRect(0, 0, W, HEAD_H)
        self.names_scene.setSceneRect(0, 0, NAME_W, H)
        self.grid_scene.setSceneRect(0, 0, W, H)
        pen_g = QPen(QColor(GRID))
        fm = QFontMetrics(self.font_)
        for i in range(span // SLOT + 1):
            x = i * SLOT * PX_MIN
            t = datetime.fromtimestamp(self.t0 + i * SLOT * 60)
            lab = t.strftime("%a %m/%d %I:%M %p") if (i == 0 or (t.hour == 0 and t.minute == 0)) \
                else t.strftime("%I:%M %p")
            self.head_scene.addLine(x, 0, x, HEAD_H, pen_g)
            ti = self.head_scene.addSimpleText(lab, self.font_)
            ti.setBrush(QBrush(QColor(FG)))
            ti.setPos(x + 4, (HEAD_H - fm.height()) / 2)
            self.grid_scene.addLine(x, 0, x, H, pen_g)
        ycur = 0
        prev_grp = None
        fb = type(self.font_)(self.font_)
        fb.setBold(True)
        band = QBrush(QColor('#0f0f16'))
        for r, ch in enumerate(chans):
            grp = (ch.group or 'Other').split(';')[0]
            if grp != prev_grp:
                prev_grp = grp
                for sc, w_ in ((self.names_scene, NAME_W), (self.grid_scene, W)):
                    b = sc.addRect(0, ycur, w_, GRP_H, QPen(Qt.PenStyle.NoPen), band)
                    b.setZValue(1)
                gt = self.names_scene.addSimpleText(grp.upper(), fb)
                gt.setBrush(QBrush(QColor(RED)))
                gt.setPos(8, ycur + (GRP_H - fm.height()) / 2)
                gt.setZValue(2)
                ycur += GRP_H
            y = ycur
            ycur += ROW_H
            nt = self.names_scene.addSimpleText(str(ch.num or ''), fb)
            nt.setBrush(QBrush(QColor(RED)))
            nt.setPos(6, y + (ROW_H - fm.height()) / 2)
            cell = NameCell(ch, self.bus, NAME_W - 30, ROW_H, self.font_)
            cell.setPos(30, y)
            self.names_scene.addItem(cell)
            self.names_scene.addLine(0, y + ROW_H, NAME_W, y + ROW_H, pen_g)
            self.grid_scene.addLine(0, y + ROW_H, W, y + ROW_H, pen_g)
            if not ch.progs:
                e = EmptyCell(ch, self.bus, W, ROW_H, self.font_)
                e.setPos(0, y)
                self.grid_scene.addItem(e)
                continue
            for p in ch.progs:
                x1 = max(0, (p["s"] - self.t0) / 60 * PX_MIN)
                x2 = min(W, (p["e"] - self.t0) / 60 * PX_MIN)
                if x2 <= x1:
                    continue
                self.grid_scene.addItem(ProgItem(
                    x1 + 1, y + 2, x2 - x1 - 2, ROW_H - 4, ch, p, self.bus,
                    p["s"] <= now < p["e"], self.font_))
        pen_r = QPen(QColor(RED))
        pen_r.setWidth(2)
        self.now_g = self.grid_scene.addLine(0, 0, 0, H, pen_r)
        self.now_g.setZValue(10)
        self.now_h = self.head_scene.addLine(0, 0, 0, HEAD_H, pen_r)
        self.now_h.setZValue(10)
        self.update_now_line()
        self.jump_now()

    def update_now_line(self):
        if self.now_g is None:
            return
        x = (time.time() - self.t0) / 60 * PX_MIN
        self.now_g.setLine(x, 0, x, self.H)
        self.now_h.setLine(x, 0, x, HEAD_H)

    def jump_now(self):
        x = (time.time() - self.t0) / 60 * PX_MIN
        self.grid_view.horizontalScrollBar().setValue(max(0, int(x - 60)))
        self.grid_view.verticalScrollBar().setValue(0)


# ----------------------------------------------------------------- player
class VideoFrame(QFrame):
    doubleClicked = pyqtSignal()
    rightClicked = pyqtSignal()

    def mouseDoubleClickEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.doubleClicked.emit()
        e.accept()

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.RightButton:
            self.rightClicked.emit()
        e.accept()


class ChannelOverlay(QWidget):
    """Translucent channel picker shown over the video in fullscreen."""
    chosen = pyqtSignal(object)

    def __init__(self, parent=None):
        super().__init__(parent, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint
                         | Qt.WindowType.WindowStaysOnTopHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.chans = []
        box = QFrame(self)
        box.setObjectName("ovlbox")
        self.q = QLineEdit()
        self.q.setPlaceholderText("filter channels  (Esc closes)")
        self.tree = QTreeWidget()
        self.tree.setHeaderHidden(True)
        self.tree.setRootIsDecorated(False)
        self.tree.setColumnCount(2)
        self.tree.setColumnWidth(0, 250)
        inner = QVBoxLayout(box)
        inner.addWidget(self.q)
        inner.addWidget(self.tree, 1)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(box)
        self.setStyleSheet(
            "QFrame#ovlbox { background: rgba(10,13,8,215); border: 1px solid " + GRID + "; }"
            "QTreeWidget, QLineEdit { background: rgba(17,22,14,170); border: 1px solid " + GRID
            + "; color: " + FG + "; selection-background-color: " + AIR + "; }")
        self.q.textChanged.connect(lambda _t: self.fill())
        self.q.returnPressed.connect(self.pick_current)
        self.tree.itemClicked.connect(lambda it, _c: self.pick(it))
        self.tree.itemActivated.connect(lambda it, _c: self.pick(it))

    def open_with(self, chans):
        self.chans = [c for c in chans if c.url]
        self.q.clear()
        self.fill()
        self.show()
        self.raise_()
        self.q.setFocus()

    def fill(self):
        t = self.q.text().lower().strip()
        self.tree.clear()
        for c in self.chans:
            if t in c.name.lower():
                p = now_prog(c)
                it = QTreeWidgetItem([c.name, p["t"] if p else ""])
                it.setData(0, Qt.ItemDataRole.UserRole, c)
                self.tree.addTopLevelItem(it)

    def pick_current(self):
        it = self.tree.currentItem() or self.tree.topLevelItem(0)
        if it is not None:
            self.pick(it)

    def pick(self, it):
        if not self.isVisible():
            return
        self.hide()
        self.chosen.emit(it.data(0, Qt.ItemDataRole.UserRole))

    def keyPressEvent(self, e):
        if e.key() == Qt.Key.Key_Escape:
            self.hide()
        else:
            super().keyPressEvent(e)


class Player(QWidget):
    def __init__(self):
        super().__init__()
        self.url, self.label, self.inst, self.mp = "", "", None, None
        self.ok = False
        self.video = VideoFrame()
        self.video.setStyleSheet("background: #000;")
        self.video.setAttribute(Qt.WidgetAttribute.WA_NativeWindow, True)
        self.video.setMinimumSize(320, 180)
        self.info = QLabel("STANDBY")
        self.info.setObjectName("info")
        self.btn_pause, self.btn_stop = QPushButton("PAUSE"), QPushButton("STOP")
        self.btn_mute, self.btn_pop = QPushButton("MUTE (F4)"), QPushButton("POP OUT")
        self.btn_full = QPushButton("FULLSCREEN (F11)")
        self.vol = QSlider(Qt.Orientation.Horizontal)
        self.vol.setRange(0, 100)
        self.vol.setValue(100)
        self.vol.setFixedWidth(120)
        self.btn_pause.clicked.connect(self.toggle_pause)
        self.btn_stop.clicked.connect(self.stop)
        self.btn_mute.clicked.connect(self.toggle_mute)
        self.btn_pop.clicked.connect(self.pop_out)
        self.vol.valueChanged.connect(self.set_volume)
        bar = QHBoxLayout()
        bar.setContentsMargins(6, 4, 6, 4)
        for w in (self.btn_pause, self.btn_stop, self.btn_mute, self.vol, self.btn_full, self.btn_pop):
            bar.addWidget(w)
        bar.addStretch()
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        lay.addWidget(self.info)
        lay.addWidget(self.video, 1)
        lay.addLayout(bar)
        self.chrome = [self.info, self.btn_pause, self.btn_stop, self.btn_mute,
                       self.vol, self.btn_full, self.btn_pop]
        self.poll = QTimer(self)
        self.poll.setInterval(1000)
        self.poll.timeout.connect(self.check_state)

        if EXTERNAL:
            self.info.setText("EXTERNAL MODE (AEGIS_TV_EXTERNAL=1): streams open in the VLC app")
        elif vlc is None:
            self.info.setText("EMBEDDED PLAYER OFF: " + VLC_ERR + "  (streams open in the VLC app)")
        else:
            try:
                self.inst = vlc.Instance("--quiet", "--no-video-title-show",
                                         "--network-caching=6000", "--no-stats", *os.environ.get("AEGIS_VLC_ARGS", "").split())
                self.mp = self.inst.media_player_new()
                self.ok = True
            except Exception as ex:
                self.info.setText("EMBEDDED PLAYER OFF: " + str(ex))

    def _attach(self):
        wid = int(self.video.winId())
        if sys.platform == "darwin":
            self.mp.set_nsobject(wid)
        elif sys.platform.startswith("win"):
            self.mp.set_hwnd(wid)
        else:
            self.mp.set_xwindow(wid)

    def play(self, url, label):
        self.url, self.label = url, label
        if not self.ok:
            external_open(url)
            self.info.setText("EXTERNAL VLC: " + label)
            return
        self.mp.stop()
        self.mp.set_media(self.inst.media_new(url))
        self._attach()
        self.mp.play()
        try:
            self.mp.video_set_mouse_input(False)
            self.mp.video_set_key_input(False)
        except Exception:
            pass
        self._force_audio()
        QTimer.singleShot(1500, self._force_audio)
        self.info.setText("TUNING: " + label)
        self.poll.start()

    def _force_audio(self):
        if self.ok:
            try:
                self.mp.audio_set_mute(False)
                self.mp.audio_set_volume(self.vol.value())
            except Exception:
                pass

    def check_state(self):
        if not self.ok:
            return
        st = self.mp.get_state()
        names = {vlc.State.Opening: "TUNING", vlc.State.Buffering: "BUFFERING",
                 vlc.State.Playing: "ON AIR", vlc.State.Paused: "PAUSED",
                 vlc.State.Stopped: "STOPPED", vlc.State.Ended: "STREAM ENDED",
                 vlc.State.Error: "STREAM ERROR (dead or geo-blocked URL?)"}
        self.info.setText(f"{names.get(st, str(st))}: {self.label}")
        if st in (vlc.State.Error, vlc.State.Ended, vlc.State.Stopped):
            self.poll.stop()

    def set_chrome(self, visible):
        for w in self.chrome:
            w.setVisible(visible)

    def toggle_pause(self):
        if self.ok:
            self.mp.pause()

    def stop(self):
        self.poll.stop()
        if self.ok:
            self.mp.stop()
        self.info.setText("STANDBY")

    def toggle_mute(self):
        if self.ok:
            self.mp.audio_toggle_mute()

    def set_volume(self, v):
        if self.ok:
            self.mp.audio_set_volume(v)

    def pop_out(self):
        if self.url:
            self.stop()
            external_open(self.url)

    def shutdown(self):
        self.poll.stop()
        try:
            if self.ok:
                self.mp.stop()
                self.mp.release()
                self.inst.release()
        except Exception:
            pass
        self.ok = False


# ------------------------------------------------------------ main window
class Main(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("AEGIS // TV-OPS")
        self.resize(1500, 920)
        self.site, self.avail, self.user = [], [], []
        self.lineup, self.other = [], []
        self.loader = None
        self.bus = Bus()
        self.player = Player()
        self.guide = GuidePanel(self.bus)
        self.bus.tune.connect(self.tune)
        self.bus.hover.connect(self.on_hover)
        self.overlay = ChannelOverlay(self)
        self.overlay.chosen.connect(self.tune)
        self.player.video.doubleClicked.connect(self.toggle_full)
        self.player.video.rightClicked.connect(self.toggle_overlay)
        self.player.btn_full.clicked.connect(self.toggle_full)

        self.search = QLineEdit()
        self.search.setPlaceholderText("search channels (Ctrl+F)")
        self.group = QComboBox()
        self.group.addItem("ALL")
        self.lineup_only = QCheckBox("LINEUP ONLY")
        self.lineup_only.setChecked(True)
        self.btn_refresh, self.btn_m3u, self.btn_site = QPushButton("REFRESH"), QPushButton("LOAD M3U"), QPushButton("SITE")
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["STATION", "GROUP", "NOW"])
        self.tree.setRootIsDecorated(False)
        self.tree.setUniformRowHeights(True)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.tree.setColumnWidth(0, 230)
        self.tree.setColumnWidth(1, 90)
        self.tree.header().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.tree.itemActivated.connect(lambda it, _c: self.tune(it.data(0, Qt.ItemDataRole.UserRole)))
        self.info = QLabel("LOADING...")
        self.info.setObjectName("info")
        self.statusBar().addPermanentWidget(self.info)

        self.debounce = QTimer(self)
        self.debounce.setSingleShot(True)
        self.debounce.setInterval(250)
        self.debounce.timeout.connect(self.apply_filter)
        self.search.textChanged.connect(lambda _t: self.debounce.start())
        self.group.currentIndexChanged.connect(lambda _i: self.apply_filter())
        self.lineup_only.toggled.connect(self.on_lineup_toggle)
        self.btn_refresh.clicked.connect(self.refresh)
        self.btn_m3u.clicked.connect(self.load_m3u)
        self.btn_site.clicked.connect(lambda: webbrowser.open(BASE + "/"))

        left = self.left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(6, 6, 6, 6)
        r1, r2 = QHBoxLayout(), QHBoxLayout()
        r1.addWidget(self.search, 1)
        r1.addWidget(self.group)
        r2.addWidget(self.lineup_only)
        r2.addStretch()
        for b in (self.btn_refresh, self.btn_m3u, self.btn_site):
            r2.addWidget(b)
        lv.addLayout(r1)
        lv.addLayout(r2)
        lv.addWidget(self.tree, 1)

        self.right = QSplitter(Qt.Orientation.Vertical)
        self.right.addWidget(self.player)
        self.right.addWidget(self.guide)
        self.right.setSizes([520, 380])
        self.right.setStretchFactor(0, 3)
        self.right.setStretchFactor(1, 2)
        split = self.split = QSplitter(Qt.Orientation.Horizontal)
        split.addWidget(left)
        split.addWidget(self.right)
        split.setSizes([430, 1070])
        split.setStretchFactor(1, 1)
        self.setCentralWidget(split)
        self._stall = {"t": None, "n": 0}
        self.stall_timer = QTimer(self)
        self.stall_timer.setInterval(3000)
        self.stall_timer.timeout.connect(self._stall_check)
        self.stall_timer.start()

        self.dvr = None
        try:
            import dvr as dvr_mod
            self.dvr_mod = dvr_mod
            self.dvr = dvr_mod.init(self)
            self.dvr_panel = dvr_mod.DVRPanel(self.dvr, self)
            self.dvr.play_file.connect(self._dvr_play)
            self.btn_rec = QPushButton("REC (F8)")
            self.btn_rec.clicked.connect(self.dvr_rec_toggle)
            self.btn_dvr = QPushButton("DVR (F7)")
            self.btn_dvr.clicked.connect(self.dvr_panel.show_panel)
            self.statusBar().addPermanentWidget(self.btn_rec)
            self.statusBar().addPermanentWidget(self.btn_dvr)
            for key, fn in (("F7", self.dvr_panel.show_panel), ("F8", self.dvr_rec_toggle),
                            ("Alt+Left", lambda: self.dvr_seek(-30)), ("Alt+Right", lambda: self.dvr_seek(30))):
                QShortcut(QKeySequence(key), self).activated.connect(fn)
            from PyQt6.QtWidgets import QApplication
            QApplication.instance().aboutToQuit.connect(self.dvr.shutdown)
        except Exception as ex:
            print("DVR disabled:", ex)

        for key, fn in (("F2", self.toggle_guide), ("F3", self.guide.jump_now),
                        ("F4", self.player.toggle_mute), ("F5", self.refresh),
                        ("F11", self.toggle_full), ("F6", self.toggle_overlay), ("Esc", self.leave_full),
                        ("Ctrl+F", lambda: (self.search.setFocus(), self.search.selectAll()))):
            QShortcut(QKeySequence(key), self).activated.connect(fn)

        self.clock = QTimer(self)
        self.clock.setInterval(30000)
        self.clock.timeout.connect(self.tick)
        self.clock.start()
        self.refresh()

    def _dvr_play(self, path, label):
        from pathlib import Path
        self.player.play(Path(path).as_uri(), label)

    def dvr_seek(self, secs):
        try:
            mp = self.player.mp
            mp.set_time(max(0, mp.get_time() + secs * 1000))
        except Exception:
            pass

    def dvr_rec_toggle(self):
        import time
        if self.dvr is None:
            return
        url = getattr(self.player, "url", "") or ""
        label = getattr(self.player, "label", "") or "recording"
        for j in self.dvr.jobs:
            if j["status"] == "recording" and j["url"] == url:
                self.dvr.stop(j["id"])
                self.statusBar().showMessage("REC stopped: " + j["title"], 6000)
                return
        if not url or url.startswith("file:"):
            self.statusBar().showMessage("Tune a live channel first", 5000)
            return
        now, end, name = time.time(), None, label
        for c in self.lineup + self.other:
            if c.url == url:
                name = c.name
                for pr in c.progs:
                    ps, pe = self.dvr_mod.to_ts(pr.get("s")), self.dvr_mod.to_ts(pr.get("e"))
                    if ps and pe and ps <= now < pe:
                        end = pe
                        label = "%s - %s" % (c.name, pr.get("t", ""))
                break
        self.dvr.add(name, url, label, now, end or now + 6 * 3600, True)
        self.statusBar().showMessage("REC started: " + label, 6000)

    def _stall_check(self):
        try:
            pl = self.player
            if not pl.ok or not getattr(pl, "url", "") or str(pl.url).startswith("file:"):
                return
            if pl.mp.get_state() not in (vlc.State.Playing, vlc.State.Buffering):
                self._stall["n"] = 0
                return
            t = pl.mp.get_time()
            if t == self._stall["t"]:
                self._stall["n"] += 1
            else:
                self._stall["t"], self._stall["n"] = t, 0
            if self._stall["n"] >= 4:
                self._stall["n"] = 0
                self.statusBar().showMessage("Stream stalled, re-tuning...", 4000)
                pl.play(pl.url, pl.label)
        except Exception:
            pass

    # ---- data
    def refresh(self):
        if self.loader is not None and self.loader.isRunning():
            return
        self.btn_refresh.setEnabled(False)
        self.info.setText("LOADING...")
        self.loader = Loader()
        self.loader.done.connect(self.on_loaded)
        self.loader.start()

    def on_loaded(self, out):
        self.btn_refresh.setEnabled(True)
        if out["site"] or not self.site:
            self.site = out["site"]
        if out["avail"] or not self.avail:
            self.avail = out["avail"]
        self.rebuild_channels()
        self.refresh_groups()
        self.apply_filter()
        withg = sum(1 for c in self.lineup if c.progs)
        notes = []
        if out["site_err"]:
            notes.append("SITE: " + out["site_err"])
        if out["avail_err"]:
            notes.append("PLAYLIST: " + out["avail_err"])
        if out["site_stale"] or out["avail_stale"]:
            notes.append("OFFLINE: cached copy")
        self.info.setText(f"LINEUP {len(self.lineup)} ({withg} w/ guide)  AVAILABLE {len(self.avail)}")
        if notes:
            self.statusBar().showMessage("  |  ".join(notes), 15000)
        elif out["avail_src"]:
            self.statusBar().showMessage("Playlist source: " + out["avail_src"], 8000)

    def rebuild_channels(self):
        urlmap = {}
        for c in self.avail:
            urlmap.setdefault(norm(c["name"]), c["url"])
        for c in self.user:
            urlmap[norm(c["name"])] = c["url"]
        self.lineup = [Channel(name=c["name"], group=c.get("group", ""),
                               url=safe_url(urlmap.get(norm(c["name"]), "")),
                               site_id=c.get("id", ""), progs=c.get("progs", []), in_lineup=True)
                       for c in self.site]
        _cnt = {}
        for c in self.lineup:
            _k = (c.group or 'Other').split(';')[0]
            _cnt[_k] = _cnt.get(_k, 0) + 1
            c.num = _cnt[_k]
        seen = {norm(c.name) for c in self.lineup}
        self.other = []
        for c in self.user + self.avail:
            k = norm(c["name"])
            if k and k not in seen:
                seen.add(k)
                self.other.append(Channel(name=c["name"], group=c.get("group", ""), url=safe_url(c["url"])))

    def load_m3u(self):
        path, _ = QFileDialog.getOpenFileName(self, "Load M3U", os.path.expanduser("~"),
                                              "Playlists (*.m3u *.m3u8);;All files (*)")
        if not path:
            return
        try:
            with open(path, encoding="utf-8", errors="ignore") as f:
                items = parse_m3u(f.read())
        except OSError as ex:
            self.statusBar().showMessage(f"Could not read {path}: {ex}", 8000)
            return
        self.user = items + self.user
        self.rebuild_channels()
        self.refresh_groups()
        self.apply_filter()
        self.statusBar().showMessage(f"Loaded {len(items)} channels from {os.path.basename(path)}", 8000)

    # ---- views
    def pool(self):
        return self.lineup if self.lineup_only.isChecked() else self.lineup + self.other

    def refresh_groups(self):
        keep = self.group.currentText()
        _lg = list(dict.fromkeys(c.group for c in self.lineup if c.group))
        groups = _lg + sorted({c.group for c in self.pool() if c.group} - set(_lg))
        self.group.blockSignals(True)
        self.group.clear()
        self.group.addItems(["ALL"] + groups)
        i = self.group.findText(keep)
        self.group.setCurrentIndex(i if i >= 0 else 0)
        self.group.blockSignals(False)

    def on_lineup_toggle(self, _on):
        self.refresh_groups()
        self.apply_filter()

    def apply_filter(self):
        q, g = self.search.text().lower().strip(), self.group.currentText()
        vis = [c for c in self.pool() if (g == "ALL" or c.group == g) and q in c.name.lower()]
        self.tree.setUpdatesEnabled(False)
        self.tree.clear()
        for c in vis:
            p = now_prog(c)
            it = QTreeWidgetItem([c.name, c.group, p["t"] if p else ""])
            it.setData(0, Qt.ItemDataRole.UserRole, c)
            if not c.url:
                it.setForeground(0, QBrush(QColor(DIM)))
            self.tree.addTopLevelItem(it)
        self.tree.setUpdatesEnabled(True)
        self.guide.rebuild([c for c in vis if c.in_lineup])

    def tick(self):
        self.guide.update_now_line()
        for i in range(self.tree.topLevelItemCount()):
            it = self.tree.topLevelItem(i)
            c = it.data(0, Qt.ItemDataRole.UserRole)
            if c and c.progs:
                p = now_prog(c)
                it.setText(2, p["t"] if p else "")

    # ---- actions
    def tune(self, ch):
        if ch is None:
            return
        p = now_prog(ch)
        label = ch.name + (f"  -  {p['t']}" if p else "")
        if not ch.url:
            self.statusBar().showMessage(
                f"No direct stream URL for {ch.name}. Use LOAD M3U or the SITE button.", 8000)
            return
        self.statusBar().showMessage(f"Tuning {ch.name}...", 4000)
        self.player.play(ch.url, label)

    def on_hover(self, ch, p):
        if p:
            d = f"  -  {p['d']}" if p.get("d") else ""
            self.statusBar().showMessage(
                f"{ch.name}: {p['t']} ({fmt_t(p['s'])} - {fmt_t(p['e'])}){d}")

    def toggle_guide(self):
        self.guide.setVisible(not self.guide.isVisible())

    def toggle_full(self):
        if self.isFullScreen():
            self.leave_full()
        else:
            self.enter_full()

    def enter_full(self):
        self._sizes = (self.split.sizes(), self.right.sizes())
        self._guide_was = self.guide.isVisible()
        self.overlay.hide()
        self.left.hide()
        self.guide.hide()
        self.player.set_chrome(False)
        self.statusBar().hide()
        self.showFullScreen()

    def leave_full(self):
        if not self.isFullScreen():
            return
        self.overlay.hide()
        self.showNormal()
        self.left.show()
        self.guide.setVisible(self._guide_was)
        self.player.set_chrome(True)
        self.statusBar().show()
        try:
            self.split.setSizes(self._sizes[0])
            self.right.setSizes(self._sizes[1])
        except Exception:
            pass

    def toggle_overlay(self):
        if not self.isFullScreen():
            return
        if self.overlay.isVisible():
            self.overlay.hide()
            return
        g = self.geometry()
        w = max(360, int(g.width() * 0.36))
        self.overlay.setGeometry(g.x() + g.width() - w, g.y(), w, g.height())
        self.overlay.open_with(self.lineup)

    def closeEvent(self, e):
        self.clock.stop()
        self.overlay.close()
        self.player.shutdown()
        if self.loader is not None and self.loader.isRunning():
            if not self.loader.wait(3000):
                self.loader.terminate()
                self.loader.wait(1000)
        super().closeEvent(e)


def _hook(et, ev, tb):
    import traceback
    msg = "".join(traceback.format_exception(et, ev, tb))
    sys.stderr.write(msg)
    try:
        os.makedirs(CACHE, exist_ok=True)
        with open(os.path.join(CACHE, "error.log"), "a", encoding="utf-8") as f:
            f.write(time.strftime("%F %T ") + msg + "\n")
    except OSError:
        pass


def main():
    sys.excepthook = _hook
    app = QApplication(sys.argv)
    app.setApplicationName("AEGIS TV-OPS")
    app.setFont(QFont(MONO, 11))
    app.setStyleSheet(QSS)
    w = Main()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
