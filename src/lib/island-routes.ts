import type { CSSProperties } from 'react';

export type Point = readonly [number, number];
export interface IslandRoute { crop: readonly [number, number, number, number]; home: Point; bend: Point; work: Point }

// Coordinates refer to the 1536 × 1024 environment plate. Routes follow its paved courtyards.
export const ISLAND_ROUTES: readonly IslandRoute[] = [
  { crop: [108, 116, 624, 414], home: [437, 374], bend: [487, 363], work: [535, 338] },
  { crop: [818, 23, 634, 489], home: [1105, 340], bend: [1139, 367], work: [1202, 374] },
  { crop: [353, 358, 939, 579], home: [824, 595], bend: [785, 650], work: [901, 697] },
];
export function islandRoute(variant: number): IslandRoute {
  return ISLAND_ROUTES[Math.abs(Math.trunc(variant)) % ISLAND_ROUTES.length];
}
export function localPoint(point: Point, crop: IslandRoute['crop']): Point {
  return [(point[0] - crop[0]) / crop[2] * 100, (point[1] - crop[1]) / crop[3] * 100];
}
export function routeStyle(route: IslandRoute, wholeWorld = false): CSSProperties {
  const crop: IslandRoute['crop'] = wholeWorld ? [0, 0, 1536, 1024] : route.crop;
  const entries = Object.entries({ home: route.home, bend: route.bend, work: route.work }).flatMap(([key, point]) => {
    const [x, y] = localPoint(point, crop);
    return [[`--${key}-x`, `${x}%`], [`--${key}-y`, `${y}%`]];
  });
  return { ...Object.fromEntries(entries), '--island-ratio': `${crop[2]} / ${crop[3]}` } as CSSProperties;
}
