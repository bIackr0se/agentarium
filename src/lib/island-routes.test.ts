import { describe, expect, it } from 'vitest';
import { ISLAND_ROUTES, localPoint, routeStyle, type Point } from './island-routes';

// Independently traced ground corridors on the approved environment plate, not image alpha bounds.
const ground: Point[][] = [
  [[419,383],[551,357],[546,318],[424,347]],
  [[1091,335],[1101,361],[1131,385],[1219,390],[1216,358],[1124,327]],
  [[815,580],[842,602],[802,643],[920,680],[914,714],[772,665],[764,639]],
];
function onGround(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const [xi,yi]=polygon[i], [xj,yj]=polygon[j];
    if ((yi>point[1]) !== (yj>point[1]) && point[0] < (xj-xi)*(point[1]-yi)/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}
function segment(a:Point,b:Point) {
  return Array.from({length:101},(_,i):Point=>[a[0]+(b[0]-a[0])*i/100,a[1]+(b[1]-a[1])*i/100]);
}
describe('artwork-anchored routes',()=>{
  it('keeps both legs of every path on the traced courtyard at every interpolation step',()=>{
    ISLAND_ROUTES.forEach((r,i)=>{
      for(const p of [...segment(r.home,r.bend),...segment(r.bend,r.work)]) expect(onGround(p,ground[i]),`route ${i} at ${p}`).toBe(true);
    });
  });
  it('rejects a planted water endpoint and a route that cuts across the wrong part of the island',()=>{
    expect(onGround([30,800],ground[0])).toBe(false);
    expect(segment([437,374],[40,850]).every(p=>onGround(p,ground[0]))).toBe(false);
    expect(onGround([600,500],ground[2])).toBe(false);
  });
  it('projects the same ground point through overview and cropped task scenes at narrow and wide widths',()=>{
    for(const r of ISLAND_ROUTES) for(const p of [r.home,r.bend,r.work]) for(const width of [280,689,1320,1890]) {
      const [x,y]=localPoint(p,r.crop), height=width*r.crop[3]/r.crop[2];
      expect(x/100*width/width*r.crop[2]+r.crop[0]).toBeCloseTo(p[0],9);
      expect(y/100*height/height*r.crop[3]+r.crop[1]).toBeCloseTo(p[1],9);
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(100);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(100);
    }
    expect(routeStyle(ISLAND_ROUTES[0],true)).toHaveProperty('--home-x',`${437/1536*100}%`);
  });
});
