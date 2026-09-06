import { useId, type CSSProperties } from 'react';
import { islandRoute } from '../lib/island-routes';

export function IslandArt({ variant = 0, className = '' }: { variant?: number; className?: string }) {
  const route = islandRoute(variant);
  const id = useId();
  const masks = [
    'M110 130H685V390L610 495H110Z',
    'M819 30H1450V494H1080L978 465L818 386Z',
    'M351 670L475 526L604 432L804 358L996 413L1155 493L1315 648V930H351Z',
  ];
  return <svg className={`island-art ${className}`} viewBox={route.crop.join(' ')} aria-hidden="true" focusable="false">
    <defs>
      <filter id={`${id}-edge`}><feGaussianBlur stdDeviation="12" /></filter>
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="1536" height="1024">
        <path d={masks[Math.abs(Math.trunc(variant)) % 3]} fill="white" filter={`url(#${id}-edge)`} />
      </mask>
    </defs>
    <image href="/assets/sculpted/reference-world.webp" width="1536" height="1024" mask={`url(#${id})`} />
  </svg>;
}

export function Robot({ variant = 0, className = '', alt = '' }: { variant?: number; className?: string; alt?: string }) {
  return <span className={`robot pixel-villager ${className}`} style={{ '--robot-variant': variant % 4 } as CSSProperties} aria-hidden={alt ? undefined : true}>
    <img src="/assets/sculpted/robot.webp" alt={alt} draggable={false} width="256" height="256" />
  </span>;
}
