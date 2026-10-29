import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSoundPlayer} from '../scripts/audio.js';

function fixture(duration=4) {
  const calls={created:[],played:[],scheduled:[],fades:[],errors:[],stops:0};
  const sound={duration,async load(){},async play(options){calls.played.push(options);},schedule(fn,time){calls.scheduled.push({fn,time});},async fade(volume,options){calls.fades.push({volume,...options});},async stop(){calls.stops++;}};
  return {calls,sound,player:createSoundPlayer({create:src=>{calls.created.push(src);return sound;},onError:error=>calls.errors.push(error)})};
}
test('one-shot sound uses configured volume and fades at both ends',async()=>{
  const {calls,player}=fixture();
  assert.equal(await player({id:'cue',src:'sounds/match.ogg',volume:.35,fadeSeconds:1}),true);
  assert.deepEqual(calls.played,[{volume:.35,loop:false,fade:1000}]);assert.equal(calls.scheduled[0].time,3);
  calls.scheduled[0].fn();await Promise.resolve();assert.deepEqual(calls.fades,[{volume:0,duration:1000}]);player.close();
});
test('a fade cannot occupy more than half a short sound',async()=>{
  const {calls,player}=fixture(1);await player({id:'cue',src:'short.ogg',volume:2,fadeSeconds:30});
  assert.equal(calls.played[0].volume,1);assert.equal(calls.played[0].fade,500);assert.equal(calls.scheduled[0].time,.5);player.close();
});
test('duplicate, missing and muted cues do not start extra audio',async()=>{
  const {calls,player}=fixture();const cue={id:'cue',src:'light.ogg',volume:.5};
  await player(cue);await player(cue);await player({id:'mute',src:'light.ogg',volume:0});await player({id:'empty',src:''});
  assert.equal(calls.created.length,1);assert.equal(calls.scheduled.length,0);player.close();
});
test('audio failures are contained and reported',async()=>{
  const {calls,sound,player}=fixture();sound.load=async()=>{throw new Error('missing file');};
  assert.equal(await player({id:'cue',src:'missing.ogg'}),false);assert.equal(calls.errors.length,1);assert.equal(calls.played.length,0);player.close();
});
test('shutdown stops playback and cancels sounds still loading',async()=>{
  const {calls,sound,player}=fixture();let release;sound.load=()=>new Promise(resolve=>{release=resolve;});
  const pending=player({id:'cue',src:'slow.ogg'});player.close();release();
  assert.equal(await pending,false);assert.equal(calls.played.length,0);assert.equal(calls.stops,1);
});
