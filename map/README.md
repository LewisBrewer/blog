# The Taua map

A read-only, zoomable map of Aotearoa in 1810 at `/map/`, built from the Taua
working tables. Nothing on the page can change the data.

## Updating it

Double-click `update_map.bat` in the repo folder. It:

1. runs `map/export_public.py`, which reads Core Data
   (`D:\Taua\Taua\Assets\Core Data`) and writes only what the map shows into
   `map-src/`;
2. commits `map-src/` and pushes to GitHub;
3. GitHub builds the tiles and publishes. It takes a few minutes, longer the
   first time or after the base map changes.

`update_map.bat preview` does the same but pushes to a `map-preview` branch
and publishes nothing. Run the workflow on that branch with **Preview only**
ticked to download a copy you can open from a folder.

## What it reads

| Layer | Source in Core Data |
|---|---|
| Places, holders, seats, populations | `Settlements_v2/places.csv`, `place_occupancy.csv`, `place_links.csv` (refuge pā) |
| Territories | grown from the places, as the Place Editor does: each place with an 1810 holder spreads over land by terrain cost (`terrain_grid.bin.gz`, `terrain_cost_weights.json`, tracks, and the editor's rough-country areas). Moving or adding a place moves its territory |
| Tracks and waterways | `Settlements_v2/tracks.csv` |
| Whenua (plant cover) and landmarks | `Whenua/` saved files when present, otherwise the snapshot built into `Whenua_Editor.html` |
| Base map | `basemap_tiles/` |

Save in the Whenua Editor (open the Core Data folder in its Files tab, then
Ctrl+S) before updating, so painting that only lives in the browser reaches
the map.

## What it shows

1810 rows only: occupancy with `reference_only` set, or dated after 1810, is
left out. Notes keep their words and sources; the export drops the
bookkeeping tags (decision numbers, editor merges, sync markers, grade
letters) and moves "Coordinate moved…" lines out of the note. Places carry
three marks: **unconfirmed** (the 1810 holder's row is `needs_confirm`),
**approximate** (coordinate confidence is estimated, regional or approximate)
and **placeholder**. Landmarks flagged `consult` stay on the map with a red
edge and a note.

## Files

```
map/export_public.py   PC side: Core Data → map-src/ (Python standard library only)
map/build.mjs          GitHub side: map-src/ → map-build/ (tiles, territory shapes, data.js)
map/territory.mjs      grows the 1810 territories, ported from the Place Editor's computeTerr
map/vectorize.mjs      territory borders, ported from the Place Editor's vec.js
map/viewer.js          the page's script (Leaflet 1.9.4)
map/map.css            the page's styles, on top of site.css
src/map/index.njk      the page
map-src/               the public export, committed
map-build/             built output, cached by the workflow, not committed
```

To embed the map in a post, use **Copy a link** on the map and paste the link
into the Doc as its own paragraph. The converter turns it into an embedded map
at that view.
