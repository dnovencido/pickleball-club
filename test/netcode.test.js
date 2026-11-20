const {test} = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../public/engine');
const net = require('../public/netcode');

test('predicts every movement step before acknowledgement and preserves a one-tick swing', () => {
  const game = engine.create(), queue = new net.InputQueue();
  const prediction = new net.Prediction(game.players[0], 0);
  const packets = [];
  for (let tick = 0; tick <= 6; tick++) {
    const packet = prediction.step({right:true, swing:tick === 1}, tick * 17);
    if (packet) packets.push(packet);
  }
  assert.equal(packets.length, 4);
  assert.ok(prediction.player.x > game.players[0].x + 20);
  packets.forEach(packet => queue.push(packet));
  assert.equal(queue.ack, 0);
  const predicted = prediction.position();
  for (let seq = 1; seq <= 7; seq++) {
    const input = queue.next();
    assert.equal(input.swing, seq === 2);
    engine.step(game, [input, {}]);
    assert.equal(queue.ack, seq);
    prediction.reconcile(game.players[0], queue.ack, false);
    assert.deepEqual(prediction.position(), predicted);
    assert.ok(Math.abs(prediction.player.x - predicted.x) < 0.001);
  }
  assert.equal(game.phase, 'rally');
  assert.equal(prediction.step({}, 150), undefined);
  assert.deepEqual(queue.next(), {});
});

test('ignores malformed and stale input and bounds the catch-up queue', () => {
  const queue = new net.InputQueue();
  queue.push([1,8]);
  queue.push([1,4]);
  queue.push([2,2.5]);
  queue.push([2,Infinity]);
  queue.push([2,-1]);
  queue.push([2,128 * 21]);
  assert.equal(queue.next().right, true);
  assert.deepEqual(queue.next(), {});
  queue.push([2,1,1,1,1,1,1,1,1]);
  queue.push([10,8,8]);
  queue.next();
  assert.equal(queue.ack, 4);
});

test('ignores tiny position errors, eases larger errors and resets at a new serve', () => {
  const player = engine.create().players[1], prediction = new net.Prediction(player, 1);
  prediction.reconcile({...player, x:player.x + 1}, 0, false);
  assert.equal(prediction.player.x, player.x);
  const corrected = {...player, x:player.x + 20};
  prediction.reconcile(corrected, 0, false);
  assert.equal(prediction.position().x, player.x);
  prediction.step({}, 0);
  assert.ok(prediction.position().x > player.x && prediction.position().x < corrected.x);
  for (let i = 1; i < 30; i++) prediction.step({}, i * 17);
  assert.ok(corrected.x - prediction.position().x < 0.1);
  prediction.reconcile(player, 0, true);
  assert.equal(prediction.position().x, player.x);
});

test('samples positions 75 ms behind server time through burst arrivals and a dropped snapshot', () => {
  const buffer = new net.SnapshotBuffer();
  const state = tick => ({tick, phase:'rally', ball:{x:tick,y:tick,z:tick},
    players:[{x:tick,y:tick},{x:2*tick,y:tick}]});
  buffer.push(state(0), 0);
  buffer.push(state(2), 50);
  buffer.push(state(4), 67);
  buffer.push(state(8), 8 * net.stepMs);
  buffer.push(state(10), 10 * net.stepMs);
  assert.equal(buffer.push(state(8), 180), false);
  const sampled = buffer.sample(175);
  assert.equal(sampled.ball.x, 6);
  assert.equal(sampled.players[1].x, 12);
  assert.equal(buffer.sample(500).ball.x, 10);
  const reset = {...state(20), phase:'serve'};
  buffer.push(reset, 510);
  assert.equal(buffer.sample(510), reset);
});

test('compact snapshots retain rendering data, effects, events, settings and per-player acknowledgement', () => {
  const initial = engine.create({powerUps:true});
  const game = structuredClone(initial);
  engine.step(game, [{swing:true, up:true},{}]);
  game.orb = {x:201.1,y:398.6,type:'speed'};
  const packet = JSON.parse(JSON.stringify([...net.packState(game, ['drive']), 8]));
  const decoded = net.unpackState(packet, initial);
  assert.equal(decoded.ack, 8);
  assert.deepEqual(decoded.events, ['drive']);
  assert.equal(decoded.powerUps, true);
  assert.deepEqual(decoded.orb, game.orb);
  assert.equal(decoded.players[0].badge, initial.players[0].badge);
  assert.equal(decoded.players[0].swing, game.players[0].swing);
  assert.equal(decoded.ball.impact.life, game.ball.impact.life);
  assert.ok(Math.abs(decoded.ball.y - game.ball.y) <= 0.005);
  assert.ok(!JSON.stringify(packet).includes(initial.players[0].name));
});

test('a serve enters the buffered ball path without pausing the playback clock', () => {
  const buffer = new net.SnapshotBuffer();
  for (let tick = 0; tick <= 10; tick += 2) {
    buffer.push({tick, phase:tick < 6 ? 'serve' : 'rally',
      ball:{x:Math.max(0,tick-4),y:0,z:10}, players:[]}, tick * net.stepMs);
  }
  assert.ok(Math.abs(buffer.sample(5 * net.stepMs + 75).ball.x - 1) < 1e-8);
});

for (const side of [0, 1]) {
  test(`player ${side + 1}'s moving serve follows the server arc at game speed`, () => {
    const game = engine.create();
    game.server = game.ball.side = game.ball.lastHit = side;
    game.ball.x = game.players[side].x;
    game.ball.y = game.players[side].y + (side ? 23 : -23);
    const history = [structuredClone(game)];
    for (let tick = 1; tick <= 50; tick++) {
      const inputs = [{}, {}];
      inputs[side] = tick <= 7 ? {right:true, swing:tick === 7} : {left:true};
      engine.step(game, inputs);
      history.push(structuredClone(game));
    }

    const buffer = new net.SnapshotBuffer();
    const sample = (tick, now) => {
      const packet = JSON.parse(JSON.stringify([...net.packState(history[tick], []), 0]));
      buffer.push(net.unpackState(packet, history[0]), now);
    };
    const travelMs = side ? 65 : 22;
    const arrival = tick => tick * net.stepMs + travelMs + (tick % 4 ? 7 : 0);
    let next = 0;
    for (let frame = 0; frame < 84; frame++) {
      const now = travelMs + 75 + frame * net.stepMs / 2;
      // Omit the launch packet and vary arrival time without draining the buffer.
      while (next < history.length && arrival(next) <= now) {
        if (next !== 8) sample(next, arrival(next));
        next += 2;
      }
      const view = buffer.sample(now);
      const tick = buffer.cursor;
      if (tick < 6) continue;
      const lo = Math.floor(tick), hi = Math.ceil(tick), t = tick - lo;
      const from = lo === 6 ? history[7].ball.impact : history[lo].ball;
      const to = hi === 6 ? from : history[hi].ball;
      const expected = key => from[key] + (to[key] - from[key]) * t;
      if (tick < 7) assert.equal(view.ball.serve, false);
      assert.ok(Math.abs(view.ball.x - expected('x')) < 0.04, `horizontal position at ${tick}`);
      assert.ok(Math.abs(view.ball.y - expected('y')) < 0.04, `ground speed at ${tick}`);
      assert.ok(Math.abs(view.ball.z - expected('z')) < 0.5, `ball height at ${tick}`);
    }
  });
}

test('plays through the last airborne frames before showing the score', () => {
  const buffer = new net.SnapshotBuffer();
  const state = (tick,phase) => ({tick,phase,finished:phase==='finished',players:[],ball:{x:tick,y:0,z:0}});
  buffer.push(state(10,'rally'), 10*net.stepMs);
  buffer.push(state(12,'finished'), 12*net.stepMs);
  assert.ok(Math.abs(buffer.sample(11*net.stepMs+75).ball.x - 11) < 1e-8);
  assert.equal(buffer.sample(13*net.stepMs+75).phase, 'finished');
});

test('resumes from a packet gap without a burst of extra ball speed', () => {
  const buffer = new net.SnapshotBuffer();
  const state = tick => ({tick,phase:'rally',players:[],ball:{x:tick,y:0,z:0}});
  buffer.push(state(0), 0);
  buffer.push(state(2), 2*net.stepMs);
  assert.equal(buffer.sample(200).ball.x, 2);
  buffer.push(state(14), 14*net.stepMs);
  const x = buffer.sample(14*net.stepMs).ball.x;
  assert.ok(x > 3.9 && x <= 4.11);
});
