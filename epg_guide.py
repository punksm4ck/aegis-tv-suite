#!/usr/bin/env python3
"""AEGIS TV EPG grid (Tkinter). Reads guide.json + playlist.m3u published by the site."""
import json, os, re, threading, time, urllib.request
import tkinter as tk
from tkinter import ttk
from datetime import datetime

BASE = os.environ.get("AEGIS_TV_BASE", "https://tv.punksm4ck.com")
CACHE = os.path.expanduser("~/.aegis_tv")
PX_MIN, ROW_H, NAME_W, HEAD_H, SLOT, HOURS = 4, 34, 190, 28, 30, 72
BG, PANEL, GRID, CELL, AIR, EMPTY, FG, DIM, RED = (
    "#0b0f14", "#141b24", "#26313f", "#1c2735", "#1f4d7a", "#10151c", "#d7e2ee", "#7f93a8", "#ff3b3b")


def norm(s):  # must match norm() in epg_build.py and gnorm() in server.js
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", (s or "").lower())
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\b(pluto|hd|channel)\b", " ", s))


def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    try:
        req = urllib.request.Request(f"{BASE}/{name}", headers={"User-Agent": "aegis-tv-guide/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        with open(path + ".tmp", "wb") as f:
            f.write(data)
        os.replace(path + ".tmp", path)
        return data.decode("utf-8", "ignore"), False
    except Exception:
        if os.path.exists(path):
            return open(path, encoding="utf-8", errors="ignore").read(), True
        raise


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


def _old_load_all():
    m3u, stale1 = fetch("playlist.m3u")
    gj, stale2 = fetch("guide.json")
    guide = json.loads(gj).get("channels", {})
    chans = parse_m3u(m3u)
    for c in chans:
        g = guide.get(norm(c["name"]), {})
        c["progs"] = g.get("programmes", [])
        c["source"] = g.get("source", "")
    return chans, (stale1 or stale2)

from epg_data import load_all  # noqa: E402


class GuideWindow(tk.Toplevel):
    def __init__(self, master, play_cb):
        super().__init__(master)
        self.title("AEGIS TV Guide")
        self.geometry("1280x720")
        self.configure(bg=BG)
        self.play_cb, self.channels, self.view, self.items, self.t0 = play_cb, [], [], {}, 0

        bar = tk.Frame(self, bg=PANEL)
        bar.pack(fill="x")
        self.group = tk.StringVar(value="All")
        self.q = tk.StringVar()
        self.cb = ttk.Combobox(bar, textvariable=self.group, state="readonly", width=24, values=["All"])
        self.cb.pack(side="left", padx=6, pady=6)
        self.cb.bind("<<ComboboxSelected>>", lambda e: self.redraw())
        tk.Label(bar, text="Search", bg=PANEL, fg=DIM).pack(side="left")
        ttk.Entry(bar, textvariable=self.q, width=24).pack(side="left", padx=6)
        self.q.trace_add("write", lambda *a: self.redraw())
        tk.Button(bar, text="Now", command=self.jump_now).pack(side="left", padx=4)
        tk.Button(bar, text="Refresh", command=self.refresh).pack(side="left", padx=4)

        self.status = tk.Label(self, anchor="w", bg=PANEL, fg=FG, text="Loading guide...")
        self.status.pack(side="bottom", fill="x")

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True)
        body.rowconfigure(1, weight=1)
        body.columnconfigure(1, weight=1)
        self.head = tk.Canvas(body, height=HEAD_H, bg=PANEL, highlightthickness=0)
        self.names = tk.Canvas(body, width=NAME_W, bg=PANEL, highlightthickness=0)
        self.grid_c = tk.Canvas(body, bg=EMPTY, highlightthickness=0)
        vsb = ttk.Scrollbar(body, orient="vertical", command=self.grid_c.yview)
        hsb = ttk.Scrollbar(body, orient="horizontal", command=self.grid_c.xview)
        self.grid_c.configure(
            yscrollcommand=lambda a, b: (vsb.set(a, b), self.names.yview_moveto(a)),
            xscrollcommand=lambda a, b: (hsb.set(a, b), self.head.xview_moveto(a)))
        self.head.grid(row=0, column=1, sticky="ew")
        self.names.grid(row=1, column=0, sticky="ns")
        self.grid_c.grid(row=1, column=1, sticky="nsew")
        vsb.grid(row=1, column=2, sticky="ns")
        hsb.grid(row=2, column=1, sticky="ew")
        for w in (self.grid_c, self.names):
            w.bind("<MouseWheel>", self._wheel)
            w.bind("<Shift-MouseWheel>", self._hwheel)
        self.refresh()

    def _step(self, e):
        return -e.delta if abs(e.delta) < 120 else -(e.delta // 120)

    def _wheel(self, e):
        self.grid_c.yview_scroll(self._step(e), "units")

    def _hwheel(self, e):
        self.grid_c.xview_scroll(self._step(e) * 3, "units")

    def refresh(self):
        self.status.config(text="Loading guide...")

        def work():
            try:
                data, err = load_all(), None
            except Exception as ex:
                data, err = None, str(ex)
            try:
                self.after(0, lambda: self._loaded(data, err))
            except Exception:
                pass
        threading.Thread(target=work, daemon=True).start()

    def _loaded(self, data, err):
        if err:
            self.status.config(text=f"Guide unavailable: {err}")
            return
        self.channels, stale = data
        groups = sorted({c["group"] for c in self.channels if c["group"]})
        self.cb.configure(values=["All"] + groups)
        self.redraw()
        self.jump_now()
        n = sum(1 for c in self.channels if c["progs"])
        self.status.config(text=f"{len(self.channels)} channels, {n} with guide data"
                                + ("  (offline: showing cached copy)" if stale else ""))

    def redraw(self):
        for c in (self.head, self.names, self.grid_c):
            c.delete("all")
        self.items.clear()
        g, q = self.group.get(), self.q.get().lower().strip()
        self.view = [c for c in self.channels if (g == "All" or c["group"] == g) and q in c["name"].lower()]
        now = time.time()
        self.t0 = int(now // (SLOT * 60)) * SLOT * 60
        span = HOURS * 60
        W, H = span * PX_MIN, max(len(self.view) * ROW_H, 1)
        self.head.configure(scrollregion=(0, 0, W, HEAD_H))
        self.names.configure(scrollregion=(0, 0, NAME_W, H))
        self.grid_c.configure(scrollregion=(0, 0, W, H))
        for i in range(span // SLOT + 1):
            x = i * SLOT * PX_MIN
            t = datetime.fromtimestamp(self.t0 + i * SLOT * 60)
            lab = t.strftime("%a %m/%d %I:%M %p") if (i == 0 or (t.hour == 0 and t.minute == 0)) else t.strftime("%I:%M %p")
            self.head.create_line(x, 0, x, HEAD_H, fill=GRID)
            self.head.create_text(x + 4, HEAD_H / 2, anchor="w", text=lab, fill=FG, font=("Helvetica", 10))
            self.grid_c.create_line(x, 0, x, H, fill=GRID)
        for r, ch in enumerate(self.view):
            y = r * ROW_H
            self.names.create_line(0, y + ROW_H, NAME_W, y + ROW_H, fill=GRID)
            tag = f"n{r}"
            nm = ch["name"] if len(ch["name"]) <= 26 else ch["name"][:25] + "…"
            self.names.create_text(8, y + ROW_H / 2, anchor="w", text=nm, fill=FG, font=("Helvetica", 11), tags=(tag,))
            self.items[tag] = (ch, None)
            self.names.tag_bind(tag, "<Button-1>", lambda e, t=tag: self._click(t))
            self.grid_c.create_line(0, y + ROW_H, W, y + ROW_H, fill=GRID)
            if not ch["progs"]:
                tag = f"e{r}"
                self.grid_c.create_text(10, y + ROW_H / 2, anchor="w", fill=DIM, tags=(tag,),
                                        text="No guide data - click to tune", font=("Helvetica", 10, "italic"))
                self.grid_c.create_rectangle(0, y + 1, W, y + ROW_H - 1, outline="", fill="", tags=(tag,))
                self.items[tag] = (ch, None)
                self.grid_c.tag_bind(tag, "<Button-1>", lambda e, t=tag: self._click(t))
                continue
            for i, p in enumerate(ch["progs"]):
                x1 = max(0, (p["s"] - self.t0) / 60 * PX_MIN)
                x2 = min(W, (p["e"] - self.t0) / 60 * PX_MIN)
                if x2 <= x1:
                    continue
                tag = f"p{r}_{i}"
                airing = p["s"] <= now < p["e"]
                self.grid_c.create_rectangle(x1 + 1, y + 2, x2 - 1, y + ROW_H - 2, fill=AIR if airing else CELL,
                                             outline=GRID, tags=(tag,))
                chars = int((x2 - x1 - 10) / 7)
                if chars >= 3:
                    t = p["t"] if len(p["t"]) <= chars else p["t"][:chars - 1] + "…"
                    self.grid_c.create_text(x1 + 6, y + ROW_H / 2, anchor="w", text=t, fill=FG,
                                            font=("Helvetica", 10), tags=(tag,))
                self.items[tag] = (ch, p)
                self.grid_c.tag_bind(tag, "<Button-1>", lambda e, t=tag: self._click(t))
                self.grid_c.tag_bind(tag, "<Enter>", lambda e, t=tag: self._hover(t))
        x = (now - self.t0) / 60 * PX_MIN
        self.grid_c.create_line(x, 0, x, H, fill=RED, width=2)
        self.head.create_line(x, 0, x, HEAD_H, fill=RED, width=2)

    def jump_now(self):
        W = HOURS * 60 * PX_MIN
        x = (time.time() - self.t0) / 60 * PX_MIN
        self.grid_c.xview_moveto(max(0, (x - 60) / W))
        self.grid_c.yview_moveto(0)

    def _hover(self, tag):
        ch, p = self.items[tag]
        if p:
            f = lambda t: datetime.fromtimestamp(t).strftime("%I:%M %p").lstrip("0")
            d = f"  -  {p['d']}" if p.get("d") else ""
            self.status.config(text=f"{ch['name']}: {p['t']} ({f(p['s'])} - {f(p['e'])}){d}")

    def _click(self, tag):
        ch, _ = self.items[tag]
        self.status.config(text=f"Tuning {ch['name']}...")
        self.play_cb(ch["name"], ch["url"])


_win = None


def open_guide(master, play_cb):
    global _win
    try:
        if _win is not None and _win.winfo_exists():
            _win.lift()
            return _win
    except Exception:
        pass
    _win = GuideWindow(master, play_cb)
    return _win


if __name__ == "__main__":
    import subprocess, sys
    root = tk.Tk()
    root.withdraw()
    w = open_guide(root, lambda n, u: subprocess.Popen(["open", "-a", "VLC", u]))
    w.protocol("WM_DELETE_WINDOW", root.destroy)
    root.mainloop()
