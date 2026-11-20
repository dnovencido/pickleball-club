const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../public/engine');
test('predicted movement matches the authoritative simulation',()=>{
 const s=E.create();const predicted={...s.players[0]};
 for(const input of [{left:true},{up:true,left:true},{down:true,slow:true},{right:true}]){
  E.movePlayer(predicted,0,input);E.step(s,[input,{}]);
  assert.equal(predicted.x,s.players[0].x);assert.equal(predicted.y,s.players[0].y);
 }
});
test('a held movement input accelerates the player',()=>{
 const normal=E.create().players[0],held=E.create().players[0],fullyHeld=E.create().players[0];
 E.movePlayer(normal,0,{right:true});
 E.movePlayer(held,0,{right:true,sprint:true});
 E.movePlayer(fullyHeld,0,{right:true,moveBoost:1});
 assert.ok(held.x-normal.x>1,`expected held movement to be faster: ${held.x} vs ${normal.x}`);
 assert.ok(fullyHeld.x>held.x,'a longer hold should provide the fastest movement');
});
test('a serve travels diagonally and a missed return awards the server',()=>{const s=E.create();E.step(s,[{swing:true},{}]);assert.equal(s.phase,'rally');for(let i=0;i<200&&s.phase==='rally';i++)E.step(s,[{},{}]);assert.deepEqual(s.score,[1,0]);assert.equal(s.message,'DOUBLE BOUNCE')});
test('a player cannot hit the same shot twice',()=>{const s=E.create();E.step(s,[{swing:true},{}]);s.players[0].cooldown=0;const velocity=s.ball.vy;assert.equal(E.hit(s,0,{}),false);assert.equal(s.ball.vy,velocity)});
test('an early first-return swing is buffered until the ball bounces',()=>{const s=E.create();s.phase='rally';s.rallyHits=1;const p=s.players[1];Object.assign(s.ball,{serve:false,lastHit:0,side:0,bounces:0,x:p.x,y:p.y,z:20,vx:0,vy:0,vz:-1});E.step(s,[{}, {swing:true}]);assert.deepEqual(s.score,[0,0]);assert.ok(p.queuedSwing,'early swing should be queued instead of faulted');Object.assign(s.ball,{z:1,vz:-2});E.step(s,[{},{}]);assert.equal(s.ball.bounces,1);E.step(s,[{},{}]);assert.equal(s.ball.lastHit,1);assert.equal(s.rallyHits,2)});
test('a kitchen volley is a fault after the opening bounces',()=>{const s=E.create();s.phase='rally';s.rallyHits=3;s.ball.serve=false;s.ball.lastHit=0;s.ball.bounces=0;s.players[1].y=350;s.ball.x=s.players[1].x;s.ball.y=350;s.ball.z=10;E.hit(s,1,{});assert.equal(s.message,'KITCHEN VOLLEY FAULT')});
for (const difficulty of ['Easy', 'Medium', 'Hard', 'Difficult', 'Insane']) {
  test(`${difficulty} bots can sustain a short rally after a diagonal serve`, () => {
    const s=E.create();
    let longestRally=0;
    for(let tick=0;tick<1500 && longestRally<2;tick++) {
      E.step(s,[E.bot(s,0,difficulty),E.bot(s,1,difficulty)]);
      longestRally=Math.max(longestRally,s.rallyHits);
    }
    assert.ok(longestRally>=2,`longest rally was ${longestRally} hits`);
  });
}
test('advanced bots pursue long rallies and aim away from their opponent',()=>{
 for(const difficulty of ['Difficult','Insane']){
  const s=E.create();
  s.phase='rally';s.rallyHits=8;
  Object.assign(s.players[1],{x:300,y:250,cooldown:0});
  s.players[0].x=150;
  Object.assign(s.ball,{serve:false,lastHit:0,side:1,bounces:1,x:300,y:250,z:5,vx:0,vy:0,vz:1});
  const action=E.bot(s,1,difficulty);
  assert.equal(action.swing,true);
  assert.equal(action.right,true);
  assert.ok(action.moveBoost>0);
 }
});
test('a bot selects a dink strategy near the kitchen',()=>{
 const s=E.create();
 s.phase='rally';s.rallyHits=2;s.tick=11;
 Object.assign(s.ball,{serve:false,lastHit:0,side:1,bounces:1,x:300,y:300,z:5,vx:0,vy:0,vz:1});
 Object.assign(s.players[1],{x:300,y:300,cooldown:0});
 const action=E.bot(s,1,'Hard');
 assert.equal(action.swing,true);
 assert.equal(action.slow,true);
});
test('two bots score points and finish a match',()=>{
 const s=E.create({winningScore:7,botOnly:true});
 for(let tick=0;tick<12000&&!s.finished;tick++)E.step(s,[E.bot(s,0,'Medium'),E.bot(s,1,'Medium')]);
 assert.equal(s.finished,true,`bot match was stuck at ${s.score.join('–')}`);
 assert.ok(Math.max(...s.score)>=7);
});
test('a neutral return aims toward the middle of the court',()=>{
  const s=E.create();s.phase='rally';s.rallyHits=2;s.ball.serve=false;s.ball.lastHit=0;s.ball.side=1;s.ball.bounces=1;s.ball.x=140;s.ball.y=150;s.ball.z=5;s.players[1].x=140;s.players[1].y=150;
  assert.equal(E.hit(s,1,{}),true);
  assert.ok(s.ball.vx>0,'the return should travel toward the middle');
});
test('every successful hit creates a short-lived visual impact effect',()=>{
  const s=E.create();
  E.step(s,[{swing:true},{}]);
  assert.equal(s.ball.impact.kind,'normal');
  assert.equal(s.ball.impact.color,s.players[0].color);
  for(let tick=0;tick<14;tick++)E.step(s,[{},{}]);
  assert.equal(s.ball.impact,null);
});
for (const receiver of [0, 1]) {
  test(`player ${receiver+1} can return a ball after a legal bounce`, () => {
    const s=E.create();
    const p=s.players[receiver];
    s.phase='rally';s.rallyHits=1;
    Object.assign(s.ball,{serve:false,wasServe:false,lastHit:1-receiver,side:1-receiver,bounces:0,x:p.x,y:p.y,z:1,vx:0,vy:receiver?-2:2,vz:-2});
    E.step(s,[{},{}]);
    assert.equal(s.ball.bounces,1);
    assert.equal(s.ball.side,receiver);
    const inputs=[{},{}];inputs[receiver]={swing:true};
    E.step(s,inputs);
    assert.equal(s.phase,'rally');
    assert.equal(s.ball.lastHit,receiver);
    assert.equal(s.rallyHits,2);
  });
}
test('a neutral serve lands near its intended service box instead of at the baseline',()=>{
  const s=E.create();E.step(s,[{swing:true},{}]);
  for(let tick=0;tick<100&&s.phase==='rally'&&!s.ball.bounces;tick++)E.step(s,[{},{}]);
  assert.equal(s.ball.bounces,1);
  assert.ok(Math.abs(s.ball.y-175)<15,`serve bounced at ${s.ball.y}`);
});
