"""Taua map: public export.

Reads the working tables in Core Data and writes only what the public map shows
into map-src/ in the blog repo. Standard library only, so any Python 3.9+ runs it.

    python map/export_public.py                      # Core Data at the default path
    python map/export_public.py "D:\\Taua\\Taua\\Assets\\Core Data"

Nothing here edits the source tables. The map is a 1810 snapshot.
"""
import base64
import csv
import gzip
import hashlib
import html
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(REPO, "map-src")
CORE = sys.argv[1] if len(sys.argv) > 1 else r"D:\Taua\Taua\Assets\Core Data"
YEAR = 1810

SV2 = os.path.join(CORE, "Settlements_v2")
WHENUA_DIR = os.path.join(CORE, "Whenua")
WHENUA_HTML = os.path.join(CORE, "Whenua_Editor.html")
TILES = os.path.join(CORE, "basemap_tiles")

# Grid and warp constants shared by every Taua editor (warped degrees).
W0, N0, PPD = 165.79373, -34.12567, 2773.5644637053088
GRID_W = GRID_H = 1534
FINE = 6136


def say(msg):
    print("  " + msg, flush=True)


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_json(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)


def num(s, cast=float):
    try:
        return cast(s)
    except (TypeError, ValueError):
        return None


def r6(x):
    return None if x is None else round(x, 6)


# ── note cleaning ─────────────────────────────────────────────
# Presentation only: drops the bookkeeping tags the pipeline writes into notes
# (decision numbers, editor merges, sync markers, grade letters). The words of
# the note, the sources and the reasoning all stay.
META_TAGS = [
    r"\[[A-D]\]",
    r"\[decision [^\]]*\]",
    r"\[Lewis \d{4}-\d\d-\d\d\]",
    r"\[merged in editor[^\]]*\]",
    r"\[added in editor\]",
    r"\[REMAP:[^\]]*\]",
    r"\[v3 sync:[^\]]*\]",
    r"\[v29[^\]]*\]",
]
META_RE = re.compile("|".join(META_TAGS))
COORD_RE = re.compile(r"Coordinate moved [\d.]+ km onto [^.]*?(?:coordinate|point|entry)\.(?:\s|$)")


def clean(text):
    if not text:
        return ""
    t = html.unescape(text).replace('""', '"')
    t = META_RE.sub("", t)
    t = COORD_RE.sub("", t)
    parts = [re.sub(r"\s+", " ", p).strip(" ;|") for p in re.split(r"\s*\|\|?\s*", t)]
    return "\n".join(p for p in parts if p and p not in ("[]", "."))


APPROX = {"estimated", "region", "taylor_location_approx", "crosby_location_approx", "approx_locality",
          "approx_from_map", "gazetteer_ambiguous", "gazetteer_far", "town"}


def places_and_territory():
    P = read_csv(os.path.join(SV2, "places.csv"))
    O = read_csv(os.path.join(SV2, "place_occupancy.csv"))
    links = read_csv(os.path.join(SV2, "place_links.csv"))
    names = {p["place_id"]: p["name"] for p in P}

    occ = {}
    for o in O:
        if o.get("reference_only"):
            continue
        fy, ty = num(o.get("from_year"), int), num(o.get("to_year"), int)
        if fy is not None and fy > YEAR:
            continue
        if ty is not None and ty <= YEAR:
            continue
        occ.setdefault(o["place_id"], []).append(o)

    def occ_row(o):
        row = {
            "role": o["role"] or "",
            "kind": o["group_type"] or "",
            "conf": o["confederation"] or "",
            "iwi": o["iwi"] or "",
            "hapu": o["hapu"] or "",
            "pop": num(o["population"], int),
            "seat": o["is_seat"] == "Y",
            "rangatira": o["seated_rangatira"] or "",
            "basis": clean(o["seat_basis"]),
            "status": o["status"] or "",
            "confidence": o["confidence"] or "",
            "source": clean(o["source"]),
            "notes": clean(o["notes"]),
            "affiliated": o.get("affiliated_iwi") or "",
        }
        return {k: v for k, v in row.items() if v not in ("", None, False)}

    ROLE_ORDER = {"controller": 0, "resident": 1, "vacated": 2}
    out, ctrl_of = [], {}
    for p in P:
        x, y = num(p["wlon"]), num(p["wlat"])
        if x is None or y is None:
            continue
        rows = sorted(occ.get(p["place_id"], []), key=lambda o: ROLE_ORDER.get(o["role"], 3))
        ctrl = next((o for o in rows if o["role"] == "controller"), None)
        if ctrl:
            ctrl_of[p["place_id"]] = ctrl
        notes = clean(p["notes"])
        flags = []
        if ctrl and ctrl["status"] == "needs_confirm":
            flags.append("unconfirmed")
        if p["coord_confidence"] in APPROX or "approx" in (p["coord_confidence"] or ""):
            flags.append("approx")
        if re.match(r"^\s*(\[D\]\s*)?Placeholder", html.unescape(p["notes"] or "")):
            flags.append("placeholder")
        refuge = [names.get(l["to_place_id"], l["to_place_id"]) for l in links
                  if l["link_type"] == "refuge_pa" and l["from_place_id"] == p["place_id"]]
        rec = {
            "id": p["place_id"],
            "name": html.unescape(p["name"]),
            "aka": html.unescape(p["aliases"] or ""),
            "type": p["place_type"] or "",
            "w": [r6(x), r6(y)],
            "size": p["size"] or "",
            "features": (p["features"] or "").replace(";", ", "),
            "fortN": num(p["fort_natural"], int),
            "fortB": num(p["fort_built"], int),
            "contact": p["contact_1810"] or "",
            "coord": p["coord_confidence"] or "",
            "coordSrc": html.unescape(p["coord_source"] or ""),
            "notes": notes,
            "check": clean(p.get("review_flag") or ""),
            "src": [u for u in (p["primary_source_url"], p["secondary_source_url"]) if u],
            "refuge": refuge,
            "occ": [occ_row(o) for o in rows],
            "flags": flags,
        }
        out.append({k: v for k, v in rec.items() if v not in ("", None, [], False)})

    # Territories: each parcel follows the 1810 holder of its host place.
    parcels = read_csv(os.path.join(SV2, "parcels.csv"))
    with open(os.path.join(SV2, "parcels_grid.json"), encoding="utf-8") as f:
        grid = json.load(f)
    pid_row = {pid: i for i, pid in enumerate(grid["ids"])}
    keys, key_idx = [], {}

    def key_for(hapu, iwi, conf):
        k = (hapu or "", iwi or "", conf or "")
        if k not in key_idx:
            key_idx[k] = len(keys)
            keys.append(k)
        return key_idx[k] + 1

    conf_of_iwi = {}
    for o in O:
        if o["iwi"] and o["confederation"]:
            conf_of_iwi.setdefault(o["iwi"], o["confederation"])
    label_of_row = [0] * (len(grid["ids"]) + 1)
    by_id = {r["parcel_id"]: r for r in parcels}
    for pid, i in pid_row.items():
        r = by_id.get(pid)
        if not r:
            continue
        c = ctrl_of.get(r["host_place_id"])
        if c:
            label_of_row[i + 1] = key_for(c["hapu"], c["iwi"], c["confederation"])
        else:
            label_of_row[i + 1] = key_for(r["hapu"], r["iwi"], conf_of_iwi.get(r["iwi"], ""))
    rle, src = [], grid["rle"]
    for j in range(0, len(src), 2):
        v = label_of_row[src[j]] if src[j] < len(label_of_row) else 0
        n = src[j + 1]
        if rle and rle[-2] == v:
            rle[-1] += n
        else:
            rle += [v, n]
    terr = {"w": grid["w"], "h": grid["h"], "w0": grid["w0"], "n0": grid["n0"], "cell": grid["cell_deg"],
            "groups": [{"hapu": h, "iwi": i, "conf": c} for h, i, c in keys], "rle": rle}
    return out, terr


def tracks():
    T = read_csv(os.path.join(SV2, "tracks.csv"))
    out = []
    for t in T:
        try:
            pts = json.loads(t["wcoords"])
        except (ValueError, TypeError):
            continue
        if len(pts) < 2:
            continue
        out.append({
            "id": t["track_id"], "type": t["track_type"], "name": html.unescape(t["name"] or ""),
            "status": t["status"], "source": clean(t["source"]), "notes": clean(t["notes"]),
            "w": [[round(a, 5), round(b, 5)] for a, b in pts],
        })
    return out


# ── Whenua editor: grids, legend, pins ────────────────────────
def whenua():
    with open(WHENUA_HTML, encoding="utf-8") as f:
        s = f.read()
    m = re.search(r'<script type="application/json" id="data">(.*?)</script>', s, re.S)
    D = json.loads(m.group(1))
    ov = re.search(r'const OV_SRC = "data:image/jpeg;base64,([^"]+)"', s)
    # Saved work in Whenua/ wins over the editor's built snapshot, as it does
    # when the editor opens the Core Data folder.
    def saved(name):
        p = os.path.join(WHENUA_DIR, name)
        return p if os.path.exists(p) else None

    notes = []
    kits_p = saved("biome_kits_grid.bin.gz")
    if kits_p:
        shutil.copyfile(kits_p, os.path.join(OUT, "whenua_kits.bin.gz"))
        notes.append("kits from Whenua/ (saved)")
    else:
        open(os.path.join(OUT, "whenua_kits.bin.gz"), "wb").write(base64.b64decode(D["fine"]))
        notes.append("kits from the editor's built snapshot")
    st_p = saved("biome_state_grid.bin.gz")
    if st_p:
        shutil.copyfile(st_p, os.path.join(OUT, "whenua_state.bin.gz"))
    else:
        open(os.path.join(OUT, "whenua_state.bin.gz"), "wb").write(base64.b64decode(D["state"]))
    cl_p = saved("biome_cliff_grid.bin.gz")
    cliff_path = os.path.join(OUT, "whenua_cliff.bin.gz")
    if cl_p:
        shutil.copyfile(cl_p, cliff_path)
    elif os.path.exists(cliff_path):
        os.remove(cliff_path)

    state = {}
    st_json = saved("whenua_state.json")
    if st_json:
        with open(st_json, encoding="utf-8") as f:
            state = json.load(f)
        notes.append("pins and colours from Whenua/whenua_state.json")
    pins = state.get("pins") or D["pins"]
    colors = state.get("kitColors") or {}

    legend = {
        "kits": [{"id": k["id"], "name": k["name"], "color": colors.get(str(k["id"])) or k["color"],
                  "group": k["group"], "forest": bool(k.get("forest")), "note": k.get("note", ""),
                  "examples": k.get("examples", "")} for k in D["kits"]],
        "lake": {"id": 36, "name": "Lake", "color": "#b9d3e0"},
        "looks": {"2": 12, "4": 11, "5": 10},
        "states": ["None", "Forested", "Fern", "Garden", "Scrub", "Mosaic"],
        "garden": "#9c4f2e", "cliff": "#111111",
    }
    lm = []
    for p in pins:
        if not p.get("w") or p.get("kind", "landmark") != "landmark":
            continue
        approx = bool(re.search(r"approximate|check", p.get("coord") or "", re.I))
        rec = {"id": p.get("id"), "name": html.unescape(p.get("name", "")), "cat": p.get("cat", ""),
               "region": p.get("region", ""), "iwi": p.get("iwi", ""), "why": p.get("why", ""),
               "source": p.get("source", ""), "w": [r6(p["w"][0]), r6(p["w"][1])],
               "consult": bool(p.get("consult")), "approx": approx}
        lm.append({k: v for k, v in rec.items() if v not in ("", None, False)})
    if ov:
        open(os.path.join(OUT, "overview.jpg"), "wb").write(base64.b64decode(ov.group(1)))
    return legend, lm, D["meta"], notes


def copy_tiles():
    dst = os.path.join(OUT, "tiles")
    os.makedirs(dst, exist_ok=True)
    n = changed = 0
    for name in sorted(os.listdir(TILES)):
        if not re.match(r"r\d+_c\d+\.jpg$", name):
            continue
        a, b = os.path.join(TILES, name), os.path.join(dst, name)
        n += 1
        if os.path.exists(b) and os.path.getsize(a) == os.path.getsize(b) and \
                hashlib.md5(open(a, "rb").read()).digest() == hashlib.md5(open(b, "rb").read()).digest():
            continue
        shutil.copyfile(a, b)
        changed += 1
    return n, changed


def main():
    print("Taua map export")
    print("  Core Data: " + CORE)
    for p in (SV2, WHENUA_HTML, TILES):
        if not os.path.exists(p):
            sys.exit("  Missing: " + p)
    os.makedirs(OUT, exist_ok=True)

    places, terr = places_and_territory()
    say("places: %d (%d KB)" % (len(places), write_json("places.json", places) // 1024))
    say("territory groups: %d (%d KB)" % (len(terr["groups"]), write_json("territory.json", terr) // 1024))
    tr = tracks()
    say("tracks: %d (%d KB)" % (len(tr), write_json("tracks.json", tr) // 1024))
    legend, lm, meta, notes = whenua()
    write_json("whenua_legend.json", legend)
    say("landmarks: %d (%d consult)" % (len(lm), sum(1 for x in lm if x.get("consult"))))
    write_json("landmarks.json", lm)
    for n in notes:
        say(n)
    n, changed = copy_tiles()
    say("base map tiles: %d (%d changed)" % (n, changed))
    write_json("meta.json", {
        "exported": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "year": YEAR, "W0": W0, "N0": N0, "PPD": PPD, "fine": FINE, "grid": GRID_W,
        "tile": 2048, "tiles": 18, "regions": meta.get("regions", []),
        "counts": {"places": len(places), "tracks": len(tr), "landmarks": len(lm),
                   "groups": len(terr["groups"])},
    })
    print("Done. Wrote " + OUT)


if __name__ == "__main__":
    main()
