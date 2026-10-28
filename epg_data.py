#!/usr/bin/env python3
"""Data layer: logs in to the TV site, reads /api/channels + /api/guide, caches locally.
Password comes from the macOS Keychain (service aegis-tv-guide) or AEGIS_TV_PASS."""
import http.cookiejar, json, os, subprocess, sys, urllib.request

BASE = os.environ.get("AEGIS_TV_BASE", "https://tv.punksm4ck.com")
USER = os.environ.get("AEGIS_TV_USER", "punksm4ck")
SERVICE = "aegis-tv-guide"
CACHE = os.path.expanduser("~/.aegis_tv")
UA = {"User-Agent": "aegis-tv-guide/2.0"}


def _password():
    pw = os.environ.get("AEGIS_TV_PASS")
    if pw:
        return pw
    if sys.platform != "darwin":
        import keyring
        pw = keyring.get_password(SERVICE, USER)
        if not pw:
            raise RuntimeError("no password stored for %s / %s (use keyring.set_password)" % (SERVICE, USER))
        return pw
    r = subprocess.run(["security", "find-generic-password", "-a", USER, "-s", SERVICE, "-w"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("no password in Keychain: run  security add-generic-password -U -a "
                           + USER + " -s " + SERVICE + " -w")
    return r.stdout.strip()


def _fetch_live():
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    body = json.dumps({"username": USER, "password": _password()}).encode()
    req = urllib.request.Request(BASE + "/api/login", data=body,
                                 headers={**UA, "Content-Type": "application/json"})
    op.open(req, timeout=30).read()
    out = {}
    for name in ("channels", "guide"):
        req = urllib.request.Request(f"{BASE}/api/{name}", headers=UA)
        out[name] = op.open(req, timeout=60).read()
    return out


def _cache_path(name):
    return os.path.join(CACHE, name + ".json")


def load_all():
    """Returns (channels, stale). Each channel: name, group, id, url, progs, source."""
    os.makedirs(CACHE, mode=0o700, exist_ok=True)
    stale = False
    try:
        raw = _fetch_live()
        for k, v in raw.items():
            with open(_cache_path(k) + ".tmp", "wb") as f:
                f.write(v)
            os.replace(_cache_path(k) + ".tmp", _cache_path(k))
    except Exception as ex:
        if not all(os.path.exists(_cache_path(k)) for k in ("channels", "guide")):
            raise
        print("live fetch failed, using cache:", ex)
        raw = {k: open(_cache_path(k), "rb").read() for k in ("channels", "guide")}
        stale = True
    chans = json.loads(raw["channels"])
    guide = json.loads(raw["guide"]).get("channels", {})
    for c in chans:
        c["progs"] = guide.get(c["id"], [])
        c["source"] = ""
        c["url"] = f"{BASE}/s/{c['id']}"  # fallback only; launcher prefers the tuner's direct URL
    return chans, stale
