# Agentarium visual and interaction design

The approved reference governs the composition: a warm cream navigation bar, three connected Mediterranean islands, restrained project labels, and a quiet attention and activity panel. The world is the main surface. Operational text remains real HTML.

## Layout

On desktop, the connected environment occupies 76% of the overview and the attention panel occupies 24%. The village sits in the foreground, the observatory on the right, and the workshop on the left. The first three projects occupy those locations in source order. Replay changes their state without changing that order. Additional projects continue below the landscape with their tasks; Atlas retains the complete hierarchy.

Projects, Missions, and Replay share the primary navigation. Search, source choice, and Connect remain visible. Filters and Refresh snapshot are under Refine view. View options contains Atlas, motion, and cinematic view.

At 760px and below, the attention action precedes the map and the toolbar wraps. Project headings and counts stay together. A single task uses an island beside its title and action on desktop; mobile stacks these. Agent lots use two columns on desktop and one on mobile. Full names wrap below their scenes.

## Artwork and motion

`public/assets/sculpted/harbor-world.webp` is the shared 1536 by 1024 environment. The overview uses the whole image. `WorldArt.tsx` crops it through SVG view boxes with feathered masks for detail scenes. Detail crops include room around the landmarks and fade at their outer edges to blend into the page. The raster contains no UI text or robots. `harbor-robot.webp` supplies the decorative character. The harbor palette combines ivory limestone, terracotta, patinated bronze, olive foliage, and turquoise shallows.

`src/lib/island-routes.ts` owns the ground coordinates and crop transforms. Home, bend, and work points follow the visible paved courtyards. Both the image and the robot use the same coordinate plane, so responsive resizing preserves the route. These are authored two-dimensional paths, not general collision detection or free-roaming navigation.

Working agents travel through the bend; waiting and needs-you agents remain at work; quiet and complete agents remain at home. Pause and reduced motion return commuting agents to home. Overview crew previews show up to three active robots, or one stationary representative. Counts and task detail provide the full roster.

## Text and controls

The interface uses the system sans-serif stack, dark olive text, warm cream surfaces, and amber attention states. Body and control text remains at least 12px. Status always includes text; color and movement are supplemental. Names, evidence, selection, and actions remain semantic HTML, with native buttons, inputs, details, and the Inspector dialog.

The attention panel exposes the current task action. Inspector shows full names and bounded observed or derived evidence. Replay exposes only the evidence available at its cutoff. Connect states the real adapter and setup requirements. No decorative scene grants an approval or sends work to an agent.

## Verification

Run `npm run verify`. The route suite samples each courtyard segment, rejects planted off-ground points, and verifies coordinate transforms at narrow and wide widths. Browser review checks composition, overflow, labels, navigation, inspection, replay, and motion controls. Captures document the running Demo, with their resolution limitations recorded beside them. This is a close implementation of the approved reference, not a pixel-identical reconstruction.
