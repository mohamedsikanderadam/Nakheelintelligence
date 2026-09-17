# Nakheel Intelligence — workshop demo

Static demo: open a UAE farm on satellite imagery, scan the dashed box, and the palm detector runs in the browser on ~0.5 m Esri World Imagery tiles; detected palms are drawn on the map and converted to a harvest/revenue range. A Sentinel-2 (summer 2025) canopy-water (NDMI) layer is available for Liwa and Al Dhaid (`data/`).

Run locally: `python3 -m http.server 8000` then open http://localhost:8000 (needs internet for map tiles). No build step.

Caveats: detector is a hand-tuned dark-crown blob finder (~85-90% on grid farms, false positives on roads/scrub); yield and price assumptions in `app.js` are indicative, not measured. Esri imagery is used under its free tier for demo purposes only.

Live demo: https://mohamedsikanderadam.github.io/Nakheelintelligence/
