(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PickleEngine=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const W=600,H=800, LEFT=90,RIGHT=510,TOP=75,BOTTOM=725,NET=400,KITCHEN=105;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function create(options={}){let s={players:[player(0,options.players?.[0]),player(1,options.players?.[1])],ball:null,score:[0,0],server:0,serveSide:0,phase:'serve',message:'SERVE IT UP',timer:0,winningScore:options.winningScore||7,botOnly:!!options.botOnly,powerUps:!!options.powerUps,orb:null,orbTimer:480,finished:false,tick:0};resetBall(s);return s}
function player(i,data={}){return {x:300,y:i?150:650,side:i,name:data.name||(!i?'PLAYER 1':'PLAYER 2'),badge:data.badge||(!i?'player-01':'player-03'),color:data.color||(!i?'#d4fa62':'#ff886b'),skin:data.skin||'Classic Wood',stamina:100,swing:0,cooldown:0,trail:0,giant:0,speed:0,curve:0,freezeShot:0,frozen:0,queuedSwing:null,input:{}}}
function movePlayer(p,i,a){const heldBoost=clamp(Number(a.moveBoost)||0,0,1),boost=a.slow?0:Math.max(a.sprint?.35:0,heldBoost*.45);let sp=(p.speed?4.3:3.2)*(p.frozen?.48:1)*(a.slow?.56:1)*(1+boost);let dx=(a.right?1:0)-(a.left?1:0),dy=(a.down?1:0)-(a.up?1:0);if(dx&&dy)sp*=.707;p.x=clamp(p.x+dx*sp,LEFT-12,RIGHT+12);p.y=clamp(p.y+dy*sp,i?TOP-5:NET+22,i?NET-22:BOTTOM+5)}
function resetBall(s){let p=s.players[s.server];s.ball={x:p.x,y:p.y+(s.server?23:-23),z:14,vx:0,vy:0,vz:0,spin:0,lastHit:s.server,bounces:0,side:s.server,serve:true,trail:0};s.phase='serve';s.timer=0;s.rallyHits=0;s.players.forEach((p,i)=>{p.x= s.serveSide===0?(i===s.server?405:195):(i===s.server?195:405);p.y=i?150:650;p.swing=0;p.queuedSwing=null});s.ball.x=p.x;s.ball.y=p.y+(s.server?23:-23)}
function point(s,winner,reason){if(s.phase==='point'||s.finished)return;s.score[winner]++;s.server=winner;s.serveSide=s.score[winner]%2;s.message=reason;s.phase='point';s.timer=100;s.players.forEach(p=>p.queuedSwing=null);const reachesDecider=s.botOnly&&s.score[winner]>=s.winningScore+2;if(s.score[winner]>=s.winningScore&&(s.score[winner]-s.score[1-winner]>=2||reachesDecider)){s.finished=true;s.phase='finished';s.message=s.players[winner].name+' WINS!'}}
function hit(s,i,input){let p=s.players[i],b=s.ball,forward=i?1:-1;let dx=b.x-p.x,dy=b.y-p.y;if(Math.abs(dx)>42*(p.giant?1.5:1)||Math.abs(dy)>52||b.z>85||p.cooldown)return false;
if(b.serve&&i!==s.server)return false;if(!b.serve&&b.lastHit===i)return false;
if(!b.serve&&b.bounces===0&&s.rallyHits<2){p.queuedSwing={...input,expires:s.tick+45};return false}
if(!b.serve&&b.bounces===0&&Math.abs(p.y-NET)<KITCHEN){point(s,1-i,'KITCHEN VOLLEY FAULT');return false}
if(b.freezeOnReturn){p.frozen=120;b.freezeOnReturn=false}
let kind=input.slow?'dink':input.back?'lob':input.forward?'drive':'normal';if(b.z>39&&Math.abs(p.y-NET)>KITCHEN&&!b.serve)kind='smash';
let aim=(input.right?1:0)-(input.left?1:0);let targetX=b.serve?(s.serveSide===0?195:405):clamp(300+aim*155,LEFT+25,RIGHT-25);
let targetY=kind==='dink'?NET+forward*65:kind==='lob'?(i?680:120):(i?625:175);
// Aim for the actual landing time, including the ball's current height.
// Fixed flight times sent otherwise valid returns past the baseline.
let launch=kind==='lob'?8.4:kind==='dink'?4.3:kind==='smash'?1.7:kind==='drive'?4.4:5.2;
let flight=(launch+.11+Math.sqrt((launch+.11)**2+.44*b.z))/.22;
b.shot=kind;b.vx=(targetX-b.x)/flight;b.vy=(targetY-b.y)/flight;b.vz=launch;b.spin=p.curve?(aim||1)*.045:kind==='drive'?.008*aim:0;b.lastHit=i;b.bounces=0;b.side=i;b.serve=false;b.wasServe=s.phase==='serve';b.serveTarget=b.wasServe?(s.serveSide===0?0:1):null;b.trail=kind==='smash'?35:0;b.impact={x:b.x,y:b.y,z:b.z,life:14,maxLife:14,kind,color:p.color};p.curve=0;p.swing=12;p.cooldown=20;p.stamina=Math.max(0,p.stamina-(kind==='smash'?22:kind==='drive'?12:6));s.rallyHits++;if(p.freezeShot){p.freezeShot=0;b.freezeOnReturn=true}s.phase='rally';s.event=kind;return true}
function step(s,inputs){if(s.finished)return;s.tick++;s.event=null;if(s.phase==='point'){if(--s.timer<=0)resetBall(s);return}let b=s.ball;
s.players.forEach((p,i)=>{let a=inputs[i]||{};p.input=a;['giant','speed','frozen'].forEach(k=>{if(p[k]>0)p[k]--});if(p.cooldown)p.cooldown--;if(p.swing)p.swing--;if(p.queuedSwing&&p.queuedSwing.expires<s.tick)p.queuedSwing=null;p.stamina=Math.min(100,p.stamina+.08);movePlayer(p,i,a);if(s.phase==='serve'&&i===s.server){b.x=p.x;b.y=p.y+(i?23:-23)}const press=a.swing?{...a,forward:i?a.down:a.up,back:i?a.up:a.down}:null;if(press){if(hit(s,i,press))p.queuedSwing=null}else if(p.queuedSwing&&!b.serve&&b.lastHit!==i&&!(b.bounces===0&&s.rallyHits<2)&&Math.abs(b.x-p.x)<=42*(p.giant?1.5:1)&&Math.abs(b.y-p.y)<=52&&b.z<=85&&!p.cooldown){if(hit(s,i,p.queuedSwing))p.queuedSwing=null}});
if(s.phase!=='rally')return;let oldY=b.y;b.x+=b.vx;b.y+=b.vy;b.z+=b.vz;b.vz-=.22;b.vx+=b.spin;b.spin*=.994;if(b.trail)b.trail--;if(b.impact&&--b.impact.life<=0)b.impact=null;
if((oldY-NET)*(b.y-NET)<=0&&b.z<25){point(s,1-b.lastHit,'INTO THE NET');s.event='net';return}
if(b.z<=0){b.z=0;let side=b.y<NET?1:0;if(b.x<LEFT||b.x>RIGHT||b.y<TOP||b.y>BOTTOM){point(s,b.bounces?b.lastHit:1-b.lastHit,b.bounces?'DOUBLE BOUNCE':'OUT OF BOUNDS');s.event='fault';return}if(side===b.lastHit){point(s,1-b.lastHit,'DIDN’T CLEAR THE NET');return}if(b.wasServe){let correctHalf=b.serveTarget===0?b.x<300:b.x>=300;if(!correctHalf||Math.abs(b.y-NET)<KITCHEN){point(s,1-b.lastHit,'SERVE FAULT');return}b.wasServe=false}if(b.side!==side){b.side=side;b.bounces=0}b.bounces++;if(b.bounces>1){point(s,b.lastHit,'DOUBLE BOUNCE');return}b.vz=Math.max(2.8,-b.vz*.57);b.vx*=.8;b.vy*=b.shot==='drive'?.9:.7;s.event='bounce'}
if(s.powerUps){if(!s.orb&&--s.orbTimer<=0){s.orb={x:200+Math.random()*200,y:NET+(Math.random()-.5)*55,type:['giant','speed','curve','freezeShot'][Math.floor(Math.random()*4)]};s.orbTimer=700}if(s.orb&&Math.hypot(b.x-s.orb.x,b.y-s.orb.y)<28){let p=s.players[b.lastHit];p[s.orb.type]=s.orb.type==='giant'||s.orb.type==='speed'?480:1;s.orb=null;s.event='power'}}
if(b.y<TOP-130||b.y>BOTTOM+130||b.x<LEFT-150||b.x>RIGHT+150)point(s,b.bounces?b.lastHit:1-b.lastHit,b.bounces?'DOUBLE BOUNCE':'OUT OF BOUNDS')}
// Predict the incoming ball rather than following its current position.  A
// receiver must get to the landing point before the first bounce, particularly
// on diagonal serves where chasing the ball leaves it on the wrong side.
function bot(s,i,difficulty='Medium'){
 const p=s.players[i],b=s.ball, action={up:false,down:false,left:false,right:false,swing:false,slow:false};
 const advanced=difficulty==='Difficult'||difficulty==='Insane';
 const boost=difficulty==='Insane'?1:difficulty==='Difficult'?.5:0;
 if(boost)action.moveBoost=boost;
 if(s.phase==='serve'){
  if(s.server===i) action.swing=s.tick%35===0;
  return action;
 }
 if(s.phase!=='rally')return action;
 if(b.lastHit===i){
  // Recover toward the middle while the opponent prepares their return.
  action.left=p.x>308;action.right=p.x<292;
  const home=i?205:595;action.up=p.y>home+10;action.down=p.y<home-10;
  return action;
 }
 const dead={Easy:12,Medium:7,Hard:4,Difficult:3,Insane:2}[difficulty]||7;
 let x=b.x,y=b.y,z=b.z,vx=b.vx,vy=b.vy,vz=b.vz,spin=b.spin;
 let bounced=b.side===i&&b.bounces>0, target=null;
 // Project the first legal bounce and a few frames of its outgoing path.
 for(let t=1;t<=110;t++){
  x+=vx;y+=vy;z+=vz;vz-=.22;vx+=spin;spin*=.994;
  if(z<=0){
   z=0;
   if(!bounced){
    if((i?y>=NET:y<=NET)||x<LEFT||x>RIGHT||y<TOP||y>BOTTOM)break;
    bounced=true;vz=Math.max(2.8,-vz*.57);vx*=.8;vy*=b.shot==='drive'?.9:.7;
   } else break;
  }
  if(bounced){
   target={x,y};
   const dist=Math.hypot(x-p.x,y-p.y);
   if(dist<=3.2*(1+boost*.45)*t+26)break;
  }
 }
 if(!target && bounced)target={x:b.x+b.vx*3,y:b.y+b.vy*3};
 if(!target)return action;
 target.x=clamp(target.x,LEFT,RIGHT);
 target.y=clamp(target.y,i?TOP:NET+25,i?NET-25:BOTTOM);
 action.left=p.x>target.x+dead;action.right=p.x<target.x-dead;
 action.up=p.y>target.y+dead;action.down=p.y<target.y-dead;
 const legalBounce=b.side===i&&b.bounces>0;
 // Give computer-only rallies a natural conclusion. Short, varied rally
 // limits keep tournament rounds moving instead of letting two calculated
 // returns loop indefinitely.
 const baseRallyLimit=3+((s.score[0]*3+s.score[1]*5+s.server*2+s.serveSide)%3);
 // When behind, a bot presses for an earlier winner. That extra risk prevents
 // bot-only matches from trading points forever at deuce.
 const rallyLimit=Math.max(2,baseRallyLimit-(s.score[i]<s.score[1-i]?1:0));
 if((!advanced||s.botOnly)&&s.rallyHits>=rallyLimit)return action;
 if(legalBounce&&Math.abs(b.x-p.x)<36&&Math.abs(b.y-p.y)<45&&b.z<75&&!p.cooldown){
  action.swing=true;
  // Movement keys also select shots, so stop chasing while swinging and then
  // deliberately choose an attacking or defensive strategy.
  action.up=false;action.down=false;action.left=false;action.right=false;
  const towardNet=i?'down':'up',awayFromNet=i?'up':'down';
  const plan=(s.tick+s.rallyHits*3+i*7+s.score[0]*2+s.score[1])%12;
  const aimRight=advanced?s.players[1-i].x<300:(s.rallyHits+s.server+i)%2===0;
  const canDink=Math.abs(p.y-NET)<165;
  // Dink when established at the kitchen; drive through an open side in most
  // exchanges; periodically lob to push an aggressive opponent backwards.
  if(difficulty!=='Easy'&&canDink&&(plan===0||plan===1)){
   action.slow=true;
   action[aimRight?'right':'left']=true;
  }else if(plan===6&&canDink){
   action[awayFromNet]=true;
   action[aimRight?'right':'left']=true;
  }else{
   action[towardNet]=true;
   action[aimRight?'right':'left']=true;
  }
 }
 return action;
}
return {create,step,hit,bot,movePlayer,constants:{W,H,LEFT,RIGHT,TOP,BOTTOM,NET,KITCHEN}}});
