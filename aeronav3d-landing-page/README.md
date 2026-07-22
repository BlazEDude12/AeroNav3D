# AeroNav3D Landing Page

Local, dependency-free landing page for AeroNav3D.

## Open locally

Open `dist/index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 5180 --bind 127.0.0.1 --directory dist
```

Then visit `http://127.0.0.1:5180`.

## Source assets

- `dist/assets/aeronav3d-logo-orb.svg` is the orb-only logo derived from the provided AeroNav3D SVG.
- `design-system/` stores the designlang files from `designlang-2026-07-07.zip`.

The page uses the designlang palette, typography posture, radii, and motion timing, translated into a dark AeroNav3D glass interface.
