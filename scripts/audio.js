/** One-shot client playback. Events are broadcast separately through authenticated User updates. */
export function createSoundPlayer({create,onError=console.error}) {
  const seen=new Set(),sounds=new Set();let closed=false;
  const bound=(value,max,fallback)=>Number.isFinite(Number(value))?Math.max(0,Math.min(max,Number(value))):fallback;
  const report=error=>onError(error);
  const play=async cue=>{
    if(closed || !cue?.id || typeof cue.src!=='string' || !cue.src.trim() || seen.has(cue.id)) return false;
    seen.add(cue.id);if(seen.size>128)seen.delete(seen.values().next().value);
    const volume=bound(cue.volume,1,0.5);if(!volume)return false;
    let sound;
    try {
      sound=create(cue.src);sounds.add(sound);
      for(const event of ['end','stop'])sound.addEventListener?.(event,()=>sounds.delete(sound),{once:true});
      await sound.load();if(closed){sounds.delete(sound);return false;}
      const fade=Math.min(bound(cue.fadeSeconds,30,0)*1000,Number.isFinite(sound.duration)?sound.duration*500:Infinity);
      await sound.play({volume,loop:false,fade});
      if(fade && Number.isFinite(sound.duration))sound.schedule(()=>{void sound.fade(0,{duration:fade}).catch(report);},Math.max(0,sound.duration-fade/1000));
      return true;
    } catch(error){if(sound)sounds.delete(sound);report(error);return false;}
  };
  play.close=()=>{closed=true;for(const sound of sounds)void sound.stop().catch(report);sounds.clear();};
  return play;
}
