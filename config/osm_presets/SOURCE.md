# OSM place-type dictionary

`presets.min.json` + `en.min.json` from `@openstreetmap/id-tagging-schema` 7.2.0 (ISC licence), the
preset registry of OpenStreetMap's iD editor: every kind of mapped place, its OSM tags, and the English
name, aliases and search terms people use for it. Downloaded 2026-10-01 from cdn.jsdelivr.net with his OK.

Used by `jarvis-os/businessfinder.js` to turn "salons" into `shop=hairdresser` when Nominatim's own
special phrases read no category — the fallback for when Google Maps (in Brave) fails or Brave is closed.
A machine-owned registry (like config/sites.json), not a word list of ours.
