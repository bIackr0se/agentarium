/**
 * Small, deterministic pixel-art primitives used by the live village.
 *
 * The files under /public/assets/village are unmodified 16 x 16 Kenney tiles.
 * These components intentionally keep the art separate from live state. The
 * parent decides where a house or villager belongs and can scale a primitive
 * with `--pixel-scale` without changing its nearest-neighbour pixels.
 */

const TOWN_ASSET_ROOT = "/assets/village/town";
const CHARACTER_ASSET_ROOT = "/assets/village/characters";
const PROP_ASSET_ROOT = "/assets/village/props";

function joinClassNames(...names: Array<string | undefined>): string | undefined {
  const value = names.filter(Boolean).join(" ");
  return value || undefined;
}

function normalizedIndex(value: number | undefined, length: number): number {
  if (!Number.isFinite(value) || length < 1) return 0;
  return Math.abs(Math.trunc(value as number)) % length;
}

function tilePath(id: string): string {
  return `${TOWN_ASSET_ROOT}/tile_${id}.png`;
}

function characterPath(id: string): string {
  return `${CHARACTER_ASSET_ROOT}/tile_${id}.png`;
}

interface TileProps {
  src: string;
  className?: string;
}

function DecorativeTile({ src, className }: TileProps) {
  return (
    <img
      className={joinClassNames("pixel-art__tile", className)}
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{
        display: "block",
        width: "calc(16px * var(--pixel-scale, 1))",
        height: "calc(16px * var(--pixel-scale, 1))",
        imageRendering: "pixelated",
        pointerEvents: "none",
        userSelect: "none",
      }}
    />
  );
}

export interface PixelHouseVariant {
  /** Three roof tiles, left to right. */
  roof: readonly [string, string, string];
  /** Three wall tiles, left to right. */
  wall: readonly [string, string, string];
  name: string;
}

/**
 * Eight colour/material variants built from Tiny Town's original roof and
 * wall tiles. A house is deliberately a 3 x 2 tile block, large enough to
 * read as a home at the 480 x 270 world scale.
 */
export const PIXEL_HOUSE_VARIANTS: readonly PixelHouseVariant[] = [
  { name: "blue roof, warm wall", roof: ["0048", "0049", "0050"], wall: ["0072", "0073", "0074"] },
  { name: "orange roof, warm wall", roof: ["0052", "0053", "0054"], wall: ["0072", "0073", "0074"] },
  { name: "blue roof, cool wall", roof: ["0060", "0061", "0062"], wall: ["0076", "0077", "0078"] },
  { name: "orange roof, cool wall", roof: ["0064", "0065", "0066"], wall: ["0076", "0077", "0078"] },
  { name: "blue roof, cool wall two", roof: ["0048", "0049", "0050"], wall: ["0076", "0077", "0078"] },
  { name: "orange roof, cool wall two", roof: ["0052", "0053", "0054"], wall: ["0076", "0077", "0078"] },
  { name: "blue roof, warm wall two", roof: ["0060", "0061", "0062"], wall: ["0072", "0073", "0074"] },
  { name: "orange roof, warm wall two", roof: ["0064", "0065", "0066"], wall: ["0072", "0073", "0074"] },
];

export interface PixelHouseProps {
  /** Stable project/task hash, not an animation frame. */
  variant?: number;
  className?: string;
}

export function PixelHouse({ variant = 0, className }: PixelHouseProps) {
  const selected = PIXEL_HOUSE_VARIANTS[normalizedIndex(variant, PIXEL_HOUSE_VARIANTS.length)];
  const tiles = [...selected.roof, ...selected.wall];
  return (
    <span
      className={joinClassNames("pixel-art", "pixel-house", className)}
      data-pixel-variant={normalizedIndex(variant, PIXEL_HOUSE_VARIANTS.length)}
      data-pixel-name={selected.name}
      aria-hidden="true"
      role="presentation"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, calc(16px * var(--pixel-scale, 1)))",
        gridTemplateRows: "repeat(2, calc(16px * var(--pixel-scale, 1)))",
        width: "calc(48px * var(--pixel-scale, 1))",
        height: "calc(32px * var(--pixel-scale, 1))",
        overflow: "visible",
        imageRendering: "pixelated",
      }}
    >
      {tiles.map((id, index) => (
        <DecorativeTile key={`${id}-${index}`} src={tilePath(id)} />
      ))}
    </span>
  );
}

export interface PixelHomeVariant {
  /** Stable visual treatment for a home and its small yard. */
  name: "garden cottage" | "woodland lodge" | "maker cottage" | "lookout cottage";
  houseOffset: number;
  treeOffset: number;
  treeSide: "left" | "right";
  prop: "mail" | "well" | "tools" | "shrub";
  propSide: "left" | "right";
}

/**
 * Four small yard compositions made from the same licensed 16 x 16 tiles as
 * the rest of the world. The house stays recognizable, while the surrounding
 * path, tree, and prop give each agent a distinct home silhouette at a glance.
 */
export const PIXEL_HOME_VARIANTS: readonly PixelHomeVariant[] = [
  { name: "garden cottage", houseOffset: 0, treeOffset: 2, treeSide: "right", prop: "mail", propSide: "left" },
  { name: "woodland lodge", houseOffset: 2, treeOffset: 4, treeSide: "left", prop: "well", propSide: "right" },
  { name: "maker cottage", houseOffset: 4, treeOffset: 6, treeSide: "right", prop: "tools", propSide: "left" },
  { name: "lookout cottage", houseOffset: 6, treeOffset: 8, treeSide: "left", prop: "shrub", propSide: "right" },
];

export interface PixelHomeProps {
  /** Stable task-local agent index used to choose a distinct yard composition. */
  variant?: number;
  className?: string;
}

export function PixelHome({ variant = 0, className }: PixelHomeProps) {
  const index = normalizedIndex(variant, PIXEL_HOME_VARIANTS.length);
  const selected = PIXEL_HOME_VARIANTS[index];
  return (
    <span
      className={joinClassNames("pixel-art", "pixel-home", `pixel-home--${index}`, className)}
      data-pixel-home-style={selected.name}
      data-pixel-home-variant={index}
      aria-hidden="true"
      role="presentation"
    >
      <span className="pixel-home__ground" />
      <span className="pixel-home__path"><PixelProp kind="path" /></span>
      <span className="pixel-home__house"><PixelHouse variant={variant + selected.houseOffset} /></span>
      <PixelTree variant={variant + selected.treeOffset} className={`pixel-home__tree pixel-home__tree--${selected.treeSide}`} />
      <PixelProp kind={selected.prop} className={`pixel-home__prop pixel-home__prop--${selected.propSide}`} />
      <span className="pixel-home__fence pixel-home__fence--front"><PixelProp kind="fence" /></span>
      <span className="pixel-home__fence pixel-home__fence--back"><PixelProp kind="rail" /></span>
    </span>
  );
}

/**
 * Twelve distinct front-facing character cells from Tiny Dungeon. They are
 * intentionally neutral characters, not copies of any recognizable person.
 * The village can add a project colour ring or state effect around them.
 */
export const PIXEL_VILLAGER_SPRITES = [
  "0084", "0085", "0086", "0087", "0088", "0096",
  "0097", "0098", "0099", "0100", "0109", "0111",
] as const;

export interface PixelVillagerProps {
  /** Stable agent hash used to choose a sprite. */
  variant?: number;
  className?: string;
  /** Non-empty alt text keeps the character in the accessibility tree. */
  alt?: string;
}

export function PixelVillager({ variant = 0, className, alt = "" }: PixelVillagerProps) {
  const index = normalizedIndex(variant, PIXEL_VILLAGER_SPRITES.length);
  const accessible = alt.trim().length > 0;
  const image = (
    <img
      className="pixel-art__character"
      src={characterPath(PIXEL_VILLAGER_SPRITES[index])}
      alt={accessible ? alt : ""}
      {...(accessible ? {} : { "aria-hidden": true })}
      draggable={false}
      style={{
        display: "block",
        width: "calc(16px * var(--pixel-scale, 2))",
        height: "calc(16px * var(--pixel-scale, 2))",
        imageRendering: "pixelated",
        pointerEvents: "none",
        userSelect: "none",
      }}
    />
  );

  return (
    <span
      className={joinClassNames("pixel-art", "pixel-villager", className)}
      data-pixel-variant={index}
      {...(accessible ? {} : { "aria-hidden": true })}
      role={accessible ? undefined : "presentation"}
      style={{
        display: "inline-grid",
        width: "calc(16px * var(--pixel-scale, 2))",
        height: "calc(16px * var(--pixel-scale, 2))",
        overflow: "visible",
        imageRendering: "pixelated",
      }}
    >
      {image}
    </span>
  );
}

/** Tree cells deliberately include both tall and round silhouettes. */
export const PIXEL_TREE_SPRITES = [
  "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011",
] as const;

export interface PixelTreeProps {
  variant?: number;
  className?: string;
}

export function PixelTree({ variant = 0, className }: PixelTreeProps) {
  const index = normalizedIndex(variant, PIXEL_TREE_SPRITES.length);
  return (
    <span
      className={joinClassNames("pixel-art", "pixel-tree", className)}
      data-pixel-variant={index}
      aria-hidden="true"
      role="presentation"
      style={{
        display: "inline-grid",
        width: "calc(16px * var(--pixel-scale, 2))",
        height: "calc(16px * var(--pixel-scale, 2))",
        overflow: "visible",
        imageRendering: "pixelated",
      }}
    >
      <DecorativeTile src={tilePath(PIXEL_TREE_SPRITES[index])} />
    </span>
  );
}

export type PixelPropKind =
  | "grass"
  | "flower"
  | "shrub"
  | "mushroom"
  | "path"
  | "stone"
  | "fence"
  | "rail"
  | "sign"
  | "book"
  | "tools"
  | "mail"
  | "well";

export const PIXEL_PROP_SPRITES: Readonly<Record<PixelPropKind, string>> = {
  grass: "grass-tuft.png",
  flower: "flower.png",
  shrub: "shrub.png",
  mushroom: "mushroom.png",
  path: "path.png",
  stone: "stone.png",
  fence: "fence.png",
  rail: "fence-rail.png",
  sign: "sign.png",
  book: "book.png",
  tools: "tools.png",
  mail: "mail.png",
  well: "well.png",
};

export interface PixelPropProps {
  kind: PixelPropKind | (string & {});
  className?: string;
}

export function PixelProp({ kind, className }: PixelPropProps) {
  const knownKind = (Object.prototype.hasOwnProperty.call(PIXEL_PROP_SPRITES, kind) ? kind : "grass") as PixelPropKind;
  return (
    <span
      className={joinClassNames("pixel-art", "pixel-prop", `pixel-prop--${knownKind}`, className)}
      data-pixel-kind={knownKind}
      aria-hidden="true"
      role="presentation"
      style={{
        display: "inline-grid",
        width: "calc(16px * var(--pixel-scale, 2))",
        height: "calc(16px * var(--pixel-scale, 2))",
        overflow: "visible",
        imageRendering: "pixelated",
      }}
    >
      <img
        className="pixel-art__prop"
        src={`${PROP_ASSET_ROOT}/${PIXEL_PROP_SPRITES[knownKind]}`}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{
          display: "block",
          width: "calc(16px * var(--pixel-scale, 2))",
          height: "calc(16px * var(--pixel-scale, 2))",
          imageRendering: "pixelated",
          pointerEvents: "none",
          userSelect: "none",
        }}
      />
    </span>
  );
}

export const PIXEL_ART_DIMENSIONS = Object.freeze({
  tile: { width: 16, height: 16 },
  house: { width: 48, height: 32 },
  home: { width: 128, height: 96 },
  villager: { width: 16, height: 16 },
  tree: { width: 16, height: 16 },
  prop: { width: 16, height: 16 },
});

export default PixelVillager;
