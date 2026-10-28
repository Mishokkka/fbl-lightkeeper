import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ActiveSourceIndex,isClockUpdate,panelUpdateKind} from '../scripts/runtime.js';
const NS='fbl-lightkeeper';

test('active index removes old actor/item keys, counts only finite lights and never resolves inactive actors',()=>{
  const index=new ActiveSourceIndex(token=>token.actor.uuid);
  let state={itemId:'A',config:{mode:'tank'}};
  const token={id:'T',parent:{id:'S'},actor:{uuid:'Actor.A'},getFlag:()=>state};
  const off={id:'OFF',parent:{id:'S'},getFlag:()=>null,get actor(){assert.fail('Inactive actor accessed');}};
  index.rebuild([{tokens:{contents:[token,off]}}]);assert.equal(index.finiteCount,1);assert.equal(index.findTank(token,'A'),token);
  token.actor={uuid:'Actor.B'};state={itemId:'B',config:{mode:'tank'}};index.sync(token);
  assert.equal(index.findTank({actor:{uuid:'Actor.A'}},'A'),null);assert.equal(index.findTank(token,'B'),token);
  state={itemId:'B',config:{mode:'infinite'}};index.sync(token);assert.equal(index.finiteCount,0);
  index.removeScene({id:'S'});assert.equal([...index.values()].length,0);
});

test('clock diffs tolerate server metadata but never hide structural changes',()=>{
  assert.ok(isClockUpdate({flags:{[NS]:{active:{remainingSeconds:10,lastAt:1}}},_stats:{modifiedTime:4}}));
  assert.ok(isClockUpdate({[`flags.${NS}.light.remainingSeconds`]:3}));
  assert.equal(isClockUpdate({flags:{[NS]:{active:null}}}),false);
  assert.equal(isClockUpdate({flags:{[NS]:{active:{config:{dim:9},remainingSeconds:10}}}}),false);
  assert.equal(isClockUpdate({flags:{[NS]:{active:{'-=lastAt':null}}}}),false);
});

test('movement filtering exits without resolving an unrelated token actor',()=>{
  const own={id:'A',parent:{id:'S'},actor:{uuid:'Actor.OWN'}};
  const other={id:'B',parent:{id:'S'},get actor(){assert.fail('Unrelated actor resolved');}};
  assert.equal(panelUpdateKind({type:'token',document:other,changes:{x:30,y:20}},own),'none');
  assert.equal(panelUpdateKind({type:'token',document:own,changes:{flags:{[NS]:{active:{lastAt:10}}}}},own),'clock');
  assert.equal(panelUpdateKind({type:'token',document:own,changes:{flags:{[NS]:{active:null}}}},own),'render');
});
