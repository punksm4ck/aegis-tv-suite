import os, json, time, re, uuid
from datetime import datetime
from PyQt6.QtCore import QObject, QTimer, pyqtSignal, Qt
from PyQt6.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QTabWidget, QTableWidget,
                             QTableWidgetItem, QPushButton, QHeaderView, QAbstractItemView,
                             QLabel, QMenu, QMessageBox)
import vlc

def _pick_dir():
    home = os.path.expanduser("~")
    for d in (os.environ.get("AEGIS_DVR_DIR"), os.path.join(home, "Videos", "AegisDVR"), os.path.join(home, "AegisDVR")):
        if not d:
            continue
        try:
            os.makedirs(d, exist_ok=True)
            return d
        except OSError as ex:
            print("dvr dir unusable:", d, ex)
    raise RuntimeError("no writable DVR folder")


DIR = _pick_dir()
SCHED = os.path.join(os.path.expanduser("~"), ".aegis_tv", "dvr_schedule.json")
PRE, POST = 60, 120          # start 1 min early, stop 2 min late
INSTANCE = None


def to_ts(v):
    try:
        if isinstance(v, (int, float)):
            v = float(v)
            return v / 1000.0 if v > 1e11 else v
        s = str(v).strip()
        if re.fullmatch(r"\d+(\.\d+)?", s):
            return to_ts(float(s))
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def safe(n):
    return re.sub(r"[^\w\- ]+", "", n or "").strip().replace(" ", "_")[:60] or "rec"


def hm(ts):
    return datetime.fromtimestamp(ts).strftime("%a %m/%d %I:%M %p")


def mb(p):
    try:
        return os.path.getsize(p) / 1048576.0
    except Exception:
        return 0.0


def _open_dir(path):
    """Cross-platform 'open folder' (os.startfile is Windows-only)."""
    try:
        os.makedirs(path, exist_ok=True)
        from PyQt6.QtCore import QUrl
        from PyQt6.QtGui import QDesktopServices
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))
    except Exception as ex:
        print("open folder failed:", ex)


class DVR(QObject):
    changed = pyqtSignal()
    play_file = pyqtSignal(str, str)

    def __init__(self, parent=None):
        super().__init__(parent)
        os.makedirs(DIR, exist_ok=True)
        os.makedirs(os.path.dirname(SCHED), exist_ok=True)
        self.inst = vlc.Instance("--quiet", "--no-video", "--no-stats")
        self.active = {}
        self.jobs = self._load()
        self.timer = QTimer(self)
        self.timer.setInterval(5000)
        self.timer.timeout.connect(self.tick)
        self.timer.start()
        QTimer.singleShot(1000, self.tick)

    def _load(self):
        try:
            with open(SCHED, encoding="utf-8") as f:
                jobs = json.load(f)
        except Exception:
            return []
        now = time.time()
        for j in jobs:
            if j.get("status") == "recording":   # app was closed mid-recording
                j["status"] = "scheduled" if now < j["end"] + POST else "done"
        return jobs

    def _save(self):
        tmp = SCHED + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.jobs, f, indent=1)
        os.replace(tmp, SCHED)

    def add(self, name, url, title, start, end, record_now=False):
        j = {"id": uuid.uuid4().hex[:8], "channel": name, "url": url, "title": title,
             "start": start, "end": end, "status": "scheduled", "path": ""}
        self.jobs.append(j)
        if record_now:
            self._start(j)
        self._save()
        self.changed.emit()
        return j

    def _launch(self, j):
        mp = self.inst.media_player_new()
        m = self.inst.media_new(j["url"])
        m.add_option(':sout=#std{access=file{append},mux=ts,dst="%s"}' % j["path"].replace("\\", "/"))
        m.add_option(":sout-keep")
        mp.set_media(m)
        mp.play()
        return mp

    def _start(self, j):
        if j["id"] in self.active:
            return
        p = j.get("path") or ""
        if not (p and os.path.exists(p)):
            base = "%s_%s" % (safe(j["title"]), datetime.now().strftime("%Y%m%d_%H%M"))
            p = os.path.join(DIR, base + ".ts")
            n = 1
            while os.path.exists(p):
                n += 1
                p = os.path.join(DIR, "%s_%d.ts" % (base, n))
        j["path"] = p
        j["status"] = "recording"
        self.active[j["id"]] = {"mp": self._launch(j), "tries": 0, "t": time.time()}
        self._save()
        self.changed.emit()

    def tick(self):
        now = time.time()
        dirty = False
        for j in list(self.jobs):
            jid = j["id"]
            if j["status"] == "scheduled":
                if now >= j["end"] + POST:
                    j["status"] = "missed"
                    dirty = True
                elif now >= j["start"] - PRE:
                    self._start(j)
            a = self.active.get(jid)
            if a:
                if now >= j["end"] + POST:
                    self.finish(jid)
                elif now - a["t"] > 20 and a["mp"].get_state() in (vlc.State.Error, vlc.State.Ended):
                    if a["tries"] >= 8:
                        self.finish(jid)
                    else:
                        a["tries"] += 1
                        a["t"] = now
                        try:
                            a["mp"].stop()
                            a["mp"].release()
                        except Exception:
                            pass
                        a["mp"] = self._launch(j)
        if dirty:
            self._save()
        self.changed.emit()

    def finish(self, jid):
        a = self.active.pop(jid, None)
        if a:
            try:
                a["mp"].stop()
                a["mp"].release()
            except Exception:
                pass
        for j in self.jobs:
            if j["id"] == jid:
                p = j.get("path", "")
                j["status"] = "done" if p and os.path.exists(p) and os.path.getsize(p) > 200000 else "failed"
        self._save()
        self.changed.emit()

    def stop(self, jid):
        if jid in self.active:
            self.finish(jid)
        else:
            self.jobs = [j for j in self.jobs if not (j["id"] == jid and j["status"] in ("scheduled", "missed"))]
            self._save()
            self.changed.emit()

    def delete(self, jid):
        if jid in self.active:
            self.finish(jid)
        for j in self.jobs:
            if j["id"] == jid and j.get("path") and os.path.exists(j["path"]):
                try:
                    os.remove(j["path"])
                except Exception as ex:
                    print("dvr delete:", ex)
        self.jobs = [j for j in self.jobs if j["id"] != jid]
        self._save()
        self.changed.emit()

    def shutdown(self):
        for a in self.active.values():
            try:
                a["mp"].stop()
            except Exception:
                pass


def init(parent=None):
    global INSTANCE
    INSTANCE = DVR(parent)
    return INSTANCE


def prog_menu(ch, prog, pos):
    if INSTANCE is None:
        return
    s, e = to_ts(prog.get("s")), to_ts(prog.get("e"))
    if s is None or e is None:
        return
    now = time.time()
    title = "%s - %s" % (ch.name, prog.get("t", ""))
    m = QMenu()
    if e <= now:
        m.addAction("Already ended").setEnabled(False)
        act = None
    else:
        live = s <= now
        act = m.addAction("Record from now until end" if live else "Schedule recording")
        if not ch.url:
            act.setEnabled(False)
            act.setText("No stream URL for this channel")
        for j in INSTANCE.jobs:
            if j["channel"] == ch.name and j["status"] in ("scheduled", "recording") and abs(j["start"] - max(s, now)) < 120:
                act.setEnabled(False)
                act.setText("Already scheduled / recording")
    pick = m.exec(pos)
    if act is not None and pick is act and act.isEnabled():
        if s <= now:
            INSTANCE.add(ch.name, ch.url, title, now, e, True)
        else:
            INSTANCE.add(ch.name, ch.url, title, s, e, False)


class DVRPanel(QDialog):
    def __init__(self, dvr, parent=None):
        super().__init__(parent)
        self.dvr = dvr
        self.setWindowTitle("AEGIS // DVR")
        self.resize(940, 520)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("Right-click a program in the guide to record or schedule it.  "
                             "Recordings stop if the app is closed.  Folder: " + DIR))
        self.tabs = QTabWidget()
        self.tabs.setStyleSheet("QTabBar::tab{color:#ffb000;background:#1a1a14;padding:6px 16px;border:1px solid #555;}QTabBar::tab:selected{background:#3a3a10;}")
        self.t_rec = self._table(["TITLE", "CHANNEL", "STARTED", "SIZE", "STATUS"])
        self.t_sch = self._table(["TITLE", "CHANNEL", "STARTS", "ENDS", "STATUS"])
        self.tabs.addTab(self.t_rec, "RECORDINGS")
        self.tabs.addTab(self.t_sch, "SCHEDULED")
        lay.addWidget(self.tabs)
        row = QHBoxLayout()
        for text, fn in (("PLAY", self.play), ("STOP / CANCEL", self.stop),
                         ("DELETE", self.delete), ("OPEN FOLDER", lambda: _open_dir(DIR))):
            b = QPushButton(text)
            b.clicked.connect(fn)
            row.addWidget(b)
        row.addStretch(1)
        lay.addLayout(row)
        self.t_rec.doubleClicked.connect(self.play)
        dvr.changed.connect(self.refresh)
        self.refresh()

    def _table(self, cols):
        t = QTableWidget(0, len(cols))
        t.setHorizontalHeaderLabels(cols)
        t.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        t.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        t.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        t.verticalHeader().setVisible(False)
        t.horizontalHeader().setStretchLastSection(True)
        t.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        return t

    def _sel_id(self, t):
        r = t.currentRow()
        it = t.item(r, 0) if r >= 0 else None
        return it.data(Qt.ItemDataRole.UserRole) if it else None

    def _fill(self, t, rows):
        sel = self._sel_id(t)
        t.setRowCount(len(rows))
        keep = -1
        for r, (jid, cells) in enumerate(rows):
            for c, txt in enumerate(cells):
                it = QTableWidgetItem(txt)
                if c == 0:
                    it.setData(Qt.ItemDataRole.UserRole, jid)
                t.setItem(r, c, it)
            if jid == sel:
                keep = r
        if keep >= 0:
            t.selectRow(keep)

    def refresh(self):
        if not self.isVisible():
            return
        rec, sch = [], []
        for j in sorted(self.dvr.jobs, key=lambda j: j["start"], reverse=True):
            if j["status"] in ("recording", "done", "failed"):
                st = "REC" if j["status"] == "recording" else j["status"].upper()
                rec.append((j["id"], [j["title"], j["channel"], hm(j["start"]),
                                      "%.0f MB" % mb(j.get("path", "")), st]))
            else:
                sch.append((j["id"], [j["title"], j["channel"], hm(j["start"]), hm(j["end"]),
                                      j["status"].upper()]))
        sch.reverse()
        self._fill(self.t_rec, rec)
        self._fill(self.t_sch, sch)
        self.tabs.setTabText(0, "RECORDINGS (%d)" % len(rec))
        self.tabs.setTabText(1, "SCHEDULED (%d)" % len(sch))

    def show_panel(self, *_):
        try:
            par = self.parent()
            if par is not None:
                g = par.geometry()
                self.resize(min(940, g.width() - 40), min(520, g.height() - 40))
                self.move(g.x() + (g.width() - self.width()) // 2, g.y() + (g.height() - self.height()) // 2)
            self.showNormal()
            self.raise_()
            self.activateWindow()
            self.refresh()
            print("DVR panel shown:", self.geometry(), "visible:", self.isVisible())
        except Exception:
            import traceback
            traceback.print_exc()

    def _cur(self):
        t = self.t_rec if self.tabs.currentIndex() == 0 else self.t_sch
        return self._sel_id(t)

    def play(self, *_):
        jid = self._sel_id(self.t_rec)
        for j in self.dvr.jobs:
            if j["id"] == jid and j.get("path") and os.path.exists(j["path"]):
                self.dvr.play_file.emit(j["path"], "DVR: " + j["title"])
                return

    def stop(self):
        jid = self._cur()
        if jid:
            self.dvr.stop(jid)

    def delete(self):
        jid = self._cur()
        if jid and QMessageBox.question(self, "Delete", "Delete this entry and its file?") == QMessageBox.StandardButton.Yes:
            self.dvr.delete(jid)
