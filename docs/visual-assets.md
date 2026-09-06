# Visual assets

## Current environment

The running world uses `public/assets/sculpted/reference-world.webp` (1536 x 1024) and `robot.webp` (256 x 256). The environment was created from the user-approved reference with UI text and characters removed. Its JSON sidecar records the source and generation prompt.

`src/components/WorldArt.tsx` renders the full environment in the overview and crops the same image for detail scenes using SVG view boxes and feathered masks. `src/lib/island-routes.ts` projects authored ground paths through the same coordinate system. Every name, state, count, and action is rendered in HTML. Raster art is decorative and hidden from assistive technology.

The earlier individual `workshop.webp`, `observatory.webp`, `garden.webp`, and `village.webp` scenes remain as prior artwork. They no longer define runtime island geometry. Keep provenance sidecars with their assets. A generation prompt is not a license statement.

The README screenshot and launch film show fictional Demo data. Captures have tool padding removed and reduced-resolution content. The film is an edited walkthrough with an original score. Working captures and editing intermediates are excluded from the source release.

## Retained legacy assets

The 16 x 16 PNG files under `public/assets/village/` are retained from the earlier pixel village. `src/components/PixelArt.tsx` still defines their composition helpers, but the current sculpted world does not import that module.

- `public/assets/village/town/` contains selected Tiny Town tiles and its original `LICENSE.txt`.
- `public/assets/village/characters/` contains selected Tiny Dungeon characters and its original `LICENSE.txt`.
- `public/assets/village/props/` contains semantic copies of selected cells used by the legacy helpers.

Tiny Town 1.1 (2023) and Tiny Dungeon 1.0 (2022) were created and distributed by Kenney. Their retained notices state Creative Commons Zero (CC0 1.0): [Tiny Town](https://kenney.nl/assets/tiny-town), [Tiny Dungeon](https://kenney.nl/assets/tiny-dungeon), and [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). This CC0 record applies to those retained Kenney assets. It does not establish a license for the generated sculpted WebP files.
