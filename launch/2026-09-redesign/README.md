# Agentarium preview film

[Watch the film](agentarium-launch.mp4).

This 36-second, 1080p film combines fictional Demo captures, the application artwork, and an original synthesized score. It is an edited walkthrough, not a continuous screen recording. All displayed tasks and evidence are synthetic. The screenshots have reduced-resolution content, so small UI text is softer than the running application.

The film demonstrates the local browser application. Codex is the tested native adapter; JSON and JSONL accept normalized local snapshots. The prebuilt application runs with `npx --yes agentarium-map@latest` on Node.js 24 or newer.

The typeface license is included in `FONT-LICENSE.txt`. Source artwork provenance is recorded in `public/assets/sculpted/` at the repository root.

## Reproduce and verify

With Python 3.13+ and FFmpeg installed, run from the repository root:

```bash
python -m pip install -r launch/2026-09-redesign/requirements.txt
python launch/2026-09-redesign/render.py
python launch/2026-09-redesign/verify.py
```

CI audits the pinned film dependencies for known vulnerabilities and checks
caption and screen bounds and overlap at all 1,080 animation frames.
Regression probes recreate the caption collision and reject opaque scene artwork.
The export receipt records the renderer, input assets, and video digests; CI rejects
a changed input or video until a new export is rendered and reviewed.
Scene artwork uses transparency over one canvas background. The test saves
480- and 960-pixel previews in `output/film-verification` for visual review.
These checks cover composition geometry, not every visual defect or UI detail
inside a screenshot. Before publishing a new export, review those previews,
watch the encoded video at feed size, and verify that the platform upload matches it.

The renderer, font, and fictional captures are included so CI can exercise the
same composition as the export. Raw captures and editing intermediates remain local.

## Posting

Prepare the main post and first author reply together. Keep the main post focused
on the native video and put the install link in the reply. Check the destination
and one-line install before posting. This is the launch format, not a promise
about platform ranking. For an existing post, weigh any correction against
preserving engagement; do not delete and repost merely to move a link.
