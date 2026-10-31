#!/usr/bin/env python3
"""Launcher: runs the existing tuner and adds the Guide (button + G key).
Playback goes to the external VLC app; embedding VLC in Tk segfaults on macOS."""
import re, subprocess, webbrowser
import tkinter as tk
import aegis_tv_suite as suite
from epg_guide import open_guide


def norm(s):
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", (s or "").lower())
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\b(pluto|hd|channel)\b", " ", s))


def external_play(url):
    subprocess.Popen(["open", "-a", "VLC", url])


def tuner_play_channel(self, event=None):
    sel = self.guide_tree.selection()
    if not sel:
        return
    item = sel[0]
    name = self.guide_tree.item(item, "values")[0]
    url = self.guide_tree.item(item, "tags")[0]
    self.now_playing.set(f"Tuning in VLC: {name}")
    external_play(url)


def tuner_stop_playback(self):
    self.now_playing.set("Status: close the VLC window to stop")


def tuner_init_player(self):
    self.vlc_available = False  # never create the embedded player


suite.UnifiedTVApp.play_channel = tuner_play_channel
suite.UnifiedTVApp.stop_playback = tuner_stop_playback
suite.UnifiedTVApp.init_player = tuner_init_player


def direct_urls(app):
    """name -> stream URL from the tuner's own channel list."""
    out = {}
    try:
        for item in app.guide_tree.get_children():
            vals = app.guide_tree.item(item, "values")
            tags = app.guide_tree.item(item, "tags")
            if vals and tags:
                out.setdefault(norm(vals[0]), tags[0])
    except Exception as ex:
        print("could not read tuner list:", ex)
    return out


def main():
    root = tk.Tk()
    app = suite.UnifiedTVApp(root)

    def tune(name, fallback_url):
        url = direct_urls(app).get(norm(name))
        if url:
            external_play(url)
        else:
            webbrowser.open(fallback_url)  # site player; needs your browser login

    show = lambda: open_guide(root, tune)
    tk.Button(root, text="Guide (G)", command=show).place(relx=1.0, x=-8, y=4, anchor="ne")
    root.bind("<g>", lambda e: show() if e.widget.winfo_class() not in ("Entry", "TEntry", "Text") else None)
    root.mainloop()


if __name__ == "__main__":
    main()
