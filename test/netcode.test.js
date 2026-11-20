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
  test(`player ${side + 1}'s moving serve stays forward through a delayed handoff`, () => {
    const game = engine.create();
    game.server = game.ball.lastHit = game.ball.side = side;
    const input = {swing:true, right:true, slow:true};
    const player = game.players[side];
    game.ball.x = player.x;
    game.ball.y = player.y + (side ? 23 : -23);
    const held = structuredClone(game);
    const sim = structuredClone(game);
    engine.movePlayer(sim.players[side], side, input);
    sim.ball.x = sim.players[side].x;
    assert.ok(engine.hit(sim, side, input));
    let preview = new net.ServePreview(sim, 0, 1);
    const buffer = new net.SnapshotBuffer();
    buffer.push(held, 0);
    const direction = side ? 1 : -1;
    let launched = false, handedOff = false;
    let rendered = held.ball;
    const packets = [];
    for (let tick = 1; tick <= 35; tick++) {
      const now = tick * net.stepMs;
      const inputs = [{}, {}];
      if (tick === 5) inputs[side] = input;
      engine.step(game, inputs);
      // 4 ticks each way (~133 ms round trip), with a gap in the first rally packets.
      if (tick % 2 === 0 && tick !== 8 && tick !== 10) packets.push(structuredClone(game));
      while (packets.length && packets[0].tick + 4 <= tick) buffer.push(packets.shift(), now);
      const buffered = buffer.sample(now);
      const sample = preview?.sample(buffered, now);
      if (!sample) {
        preview = null;
        handedOff = true;
      }
      const ball = sample?.ball || buffered.ball;
      const forward = direction * (ball.y - rendered.y);
      assert.ok(forward >= -1e-8, `shadow reversed on tick ${tick}`);
      assert.ok(forward + ball.z - rendered.z >= -1e-8, `ball reversed on tick ${tick}`);
      if (tick === 1) launched = forward > 0;
      rendered = ball;
    }
    assert.ok(launched);
    assert.ok(handedOff);
  });
}
