import {legacyIgniterMode} from './logic.js';
import {nameKey} from './presets.js';

/** Same-scene reach in grid units, measured between token bounds and including elevation. */
export function ignitionDistance(a,b) {
  if(!a?.parent || a.parent.id!==b?.parent?.id) return Infinity;
  if(a===b) return 0;
  const grid=a.parent.grid, size=Number(grid?.size);
  if(!(size>0) || ![a.x,a.y,b.x,b.y].every(Number.isFinite)) return Infinity;
  const rect=token=>{
    const width=Number(token.width)||1,height=Number(token.height)||1;
    const r=grid.getRect?.(width,height);
    return {x:token.x,y:token.y,w:r?.width??width*(grid.sizeX??size),h:r?.height??height*(grid.sizeY??size)};
  };
  const x=rect(a),y=rect(b);
  const dx=Math.max(0,x.x-y.x-y.w,y.x-x.x-x.w)/size;
  const dy=Math.max(0,x.y-y.y-y.h,y.y-x.y-x.h)/size;
  const dz=((Number(a.elevation)||0)-(Number(b.elevation)||0))/(Number(grid.distance)||1);
  return Math.hypot(dx,dy,dz);
}

/** Closed movement barriers block a hand-to-hand transfer in either direction, even off canvas. */
export class IgnitionReach {
  constructor(){this.walls=new WeakMap();}
  invalidate(scene){if(scene)this.walls.delete(scene);}
  within(target,donor,radius,{walls=true}={}) {
    if(ignitionDistance(target,donor)>radius+1e-8) return false;
    if(target===donor || !walls) return true;
    const scene=target.parent, grid=scene.grid;
    let barriers=this.walls.get(scene);
    if(!barriers){
      barriers=(scene.walls?.contents??[]).filter(w=>w.move>0 && !(w.door>0 && w.ds===1)).map(w=>w.c);
      this.walls.set(scene,barriers);
    }
    const center=token=>{
      const r=grid.getRect?.(token.width||1,token.height||1);
      return [token.x+(r?.width??(token.width||1)*(grid.sizeX??grid.size))/2,
        token.y+(r?.height??(token.height||1)*(grid.sizeY??grid.size))/2];
    };
    const a=center(target),b=center(donor);
    return !barriers.some(c=>c?.length===4 && intersects(a,b,c.slice(0,2),c.slice(2)));
  }
}

/** Include boundary contact and collinear barriers instead of allowing a flame through an endpoint. */
function intersects(a,b,c,d) {
  const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  const on=(p,q,r)=>Math.abs(cross(p,q,r))<1e-8 && r[0]>=Math.min(p[0],q[0])-1e-8 && r[0]<=Math.max(p[0],q[0])+1e-8 && r[1]>=Math.min(p[1],q[1])-1e-8 && r[1]<=Math.max(p[1],q[1])+1e-8;
  const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);
  return (x*y<0 && z*w<0) || on(a,b,c) || on(a,b,d) || on(c,d,a) || on(c,d,b);
}

/** One-time v1 migration: move each inventory's old source policy onto its actual igniter Items. */
export function legacyIgniterAssignments(items,index,runtimes=[]) {
  const modes=new Map();
  const sources=[...items.map(source=>({source,raw:source.getFlag?.('fbl-lightkeeper','light')})),...runtimes.map(raw=>({source:null,raw}))];
  for(const {source,raw} of sources) {
    const mode=legacyIgniterMode(raw);
    if(!mode || typeof raw.requiresIgnition==='boolean') continue;
    const resource=index.resourcesById.get(raw.ignitionResource);
    if(raw.ignitionResource && !resource) continue;
    for(const item of items) {
      if(item===source || item.getFlag?.('fbl-lightkeeper','ignition')) continue;
      if(resource?index.matches(item,resource):!!nameKey(raw.ignitionItem) && nameKey(item.name)===nameKey(raw.ignitionItem)) {
        if(!modes.has(item))modes.set(item,new Set());
        modes.get(item).add(mode);
      }
    }
  }
  return [...modes].map(([item,modes])=>({item,config:{mode:modes.size===1?[...modes][0]:'reusable'},conflict:modes.size>1}));
}
