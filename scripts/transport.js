/** Short, bounded handoffs for Multilevel Tokens' delete-before-create teleportation. No polling. */
export class TokenTransfers {
  constructor({limit=128,lifetime=300000,now=()=>Date.now()}={}) {
    this.limit=limit;this.lifetime=lifetime;this.now=now;this.entries=new Map();
  }
  prune() {
    const cutoff=this.now()-this.lifetime;
    for(const [key,entry] of this.entries)if(entry.at<cutoff)this.entries.delete(key);
  }
  remember(key,data) {
    this.prune();this.entries.delete(key);
    this.entries.set(key,{at:this.now(),data,claimed:false,destination:null});
    while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value);
  }
  claim(key) {
    this.prune();const entry=this.entries.get(key);
    if(!entry || entry.claimed)return null;
    entry.claimed=true;return entry.data;
  }
  arrive(origin,destination) {
    const entry=this.entries.get(origin);if(entry)entry.destination=destination;
  }
  complete(destination) {
    for(const [key,entry] of this.entries)if(entry.destination===destination)this.entries.delete(key);
  }
  /** Preserve pause boundaries until a detached source has reached its new document. */
  oldestAt() {
    this.prune();let oldest=Infinity;
    for(const {data} of this.entries.values()) {
      const active=data.flags.active;
      if(active?.config.mode!=='infinite' && Number.isFinite(active?.lastAt))oldest=Math.min(oldest,active.lastAt);
    }
    return oldest;
  }
  clear() {this.entries.clear();}
}
