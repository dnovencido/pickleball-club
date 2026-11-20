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

test('samples opponent positions 75 ms behind server time through burst arrivals and a dropped snapshot', () => {
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

for (const side of [0, 1]) {
  test(`player ${side + 1}'s serve uses the original physics until the confirmed bounce`, () => {
    const game = engine.create();
    game.server = game.ball.side = game.ball.lastHit = side;
    const player = game.players[side];
    game.ball.x = player.x;
    game.ball.y = player.y + (side ? 23 : -23);
    const initial = structuredClone(game);
    const ball = new net.MatchBall(initial, side, 0);
    const inputs = [{}, {}];
    inputs[side] = {swing:true, right:true, [side ? 'down' : 'up']:true};
    engine.step(game, inputs);
    ball.step(inputs[side], player, 1, 0);
    assert.deepEqual(ball.sample(0), game.ball);
    assert.equal(initial.phase, 'serve');
    assert.equal(initial.ball.serve, true);

    while (game.phase === 'rally' && !game.ball.bounces && game.tick < 100) {
      engine.step(game, [{}, {}]);
      const now = game.tick * net.stepMs;
      ball.step({}, player, 1, now);
      if (game.tick % 3 === 0 && !game.ball.bounces) {
        const packet = [...net.packState(game, []), 1];
        ball.receive(net.unpackState(packet, initial), now);
      }
      assert.deepEqual(ball.sample(now), game.ball);
    }
    assert.equal(game.ball.bounces, 1);
    const now = game.tick * net.stepMs;
    const before = ball.sample(now);
    const confirmed = net.unpackState([...net.packState(game, []), 1], initial);
    ball.receive(confirmed, now);
    assert.ok(ball.serve);
    assert.deepEqual(ball.sample(now), before);

    const returned = structuredClone(confirmed);
    returned.ball.lastHit = 1 - side;
    ball.receive(returned, now + net.stepMs);
    assert.equal(ball.serve, null);
    assert.equal(ball.sample(now + net.stepMs).y, before.y);
  });
}

test('rally playback interpolates the last update and projects through only a brief packet gap', () => {
  const game = engine.create();
  engine.step(game, [{swing:true}, {}]);
  const from = structuredClone(game);
  const playback = new net.MatchBall(from, 1, 0);
  engine.step(game, [{}, {}]);
  engine.step(game, [{}, {}]);
  const state = net.unpackState([...net.packState(game, []), 0], from);
  playback.receive(state, 40);
  const half = playback.sample(60);
  assert.equal(half.x, (from.ball.x + state.ball.x)/2);
  assert.equal(half.y, (from.ball.y + state.ball.y)/2);
  const late = playback.sample(200);
  assert.equal(late.x, state.ball.x + state.ball.vx*1.25);
  assert.ok(Math.abs(late.z - (state.ball.z + game.ball.vz*1.25 - 0.11*1.25**2)) < 0.011);
});

test('sends compact ball states for every physics tick', () => {
  assert.equal(net.statePacketMs, net.stepMs);
  assert.equal(net.packetMs, 2 * net.stepMs);
});

test('resumes from a packet gap without a burst of extra opponent speed', () => {
  const buffer = new net.SnapshotBuffer();
  const state = tick => ({tick,phase:'rally',players:[{x:tick,y:0}],ball:{x:tick,y:0,z:0}});
  buffer.push(state(0), 0);
  buffer.push(state(2), 2*net.stepMs);
  assert.equal(buffer.sample(200).players[0].x, 2);
  buffer.push(state(14), 14*net.stepMs);
  const x = buffer.sample(14*net.stepMs).players[0].x;
  assert.ok(x > 3.9 && x <= 4.11);
});
