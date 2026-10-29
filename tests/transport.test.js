import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TokenTransfers} from '../scripts/transport.js';

test('a transfer snapshot is claimed once and protects its clock until its destination commits',()=>{
  const transfers=new TokenTransfers(),data={flags:{active:{config:{mode:'tank'},lastAt:42}}};
  transfers.remember('S1:T1',data);assert.equal(transfers.claim('S1:T1'),data);assert.equal(transfers.claim('S1:T1'),null);
  transfers.arrive('S1:T1','S2:T2');assert.equal(transfers.oldestAt(),42);
  transfers.complete('S2:UNRELATED');assert.equal(transfers.oldestAt(),42);
  transfers.complete('S2:T2');assert.equal(transfers.oldestAt(),Infinity);
});

test('abandoned transfers are bounded and expire without creating background timers',()=>{
  let now=0;const transfers=new TokenTransfers({limit:2,lifetime:100,now:()=>now});
  const data={flags:{active:{config:{mode:'tank'},lastAt:0}}};
  for(const key of ['A','B','C'])transfers.remember(key,data);
  assert.equal(transfers.claim('A'),null);assert.equal(transfers.entries.size,2);
  now=101;assert.equal(transfers.oldestAt(),Infinity);assert.equal(transfers.claim('C'),null);assert.equal(transfers.entries.size,0);
});
