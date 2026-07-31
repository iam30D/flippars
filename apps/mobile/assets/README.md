# Mobile artwork

`brand-mark.svg` is the editable, accessible source mark. The committed raster
assets are deterministic exports produced by:

```text
python scripts/generate-mobile-assets.py
```

- `icon.png` — 1024 × 1024, opaque sRGB PNG with no alpha channel.
- `splash-icon.png` — 1024 × 1024 sRGB PNG with generous safe-area padding.
- `notification-icon.png` — Android-only monochrome PNG.

Regenerate and visually review all three whenever the source mark changes.
