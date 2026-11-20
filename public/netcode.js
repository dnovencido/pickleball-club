(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.PickleNet = factory(root.PickleEngine);
})(globalThis, function (engine) {
  'use strict';
  const stepMs = 1000 / 60;
  const packetMs = 2 * stepMs;
  const delayMs = 75;
  const maxBatch = 8;
  const actions = ['up', 'down', 'left', 'right', 'swing', 'slow', 'sprint'];

  function packInput(input) {
    const flags = actions.reduce((bits, key, i) => bits | (input[key] ? 1 << i : 0), 0);
    return flags + 128 * Math.round(20 * (input.moveBoost || 0));
  }

  function unpackInput(word) {
    const input = {moveBoost: (word >> 7) / 20};
    actions.forEach((key, i) => { input[key] = !!(word & (1 << i)); });
    return input;
  }

  // Consume one sample per physics step, even when several arrive together.
  class InputQueue {
    samples = [];
    received = 0;
    ack = 0;

    push(packet) {
      if (!Array.isArray(packet) || packet.length < 2 || packet.length > maxBatch + 1) return;
      const [first, ...words] = packet;
      if (!Number.isSafeInteger(first) || first <= 0 || !Number.isSafeInteger(first + words.length)) return;
      if (!words.every(w => Number.isInteger(w) && w >= 0 && w < 21 * 128)) return;
      words.forEach((word, i) => {
        const seq = first + i;
        if (seq > this.received) {
          this.samples.push({seq, word});
          this.received = seq;
        }
      });
      // After a long stall, prefer recent controls to a growing input delay.
      this.samples.splice(0, Math.max(0, this.samples.length - maxBatch));
    }

    next() {
      const sample = this.samples.shift();
      if (!sample) return {};
      this.ack = sample.seq;
      return unpackInput(sample.word);
    }
  }

  function move(player, side, input) {
    if (player.speed > 0) player.speed--;
    if (player.frozen > 0) player.frozen--;
    engine.movePlayer(player, side, input);
  }

  class Prediction {
    constructor(player, side) {
      this.player = {...player};
      this.side = side;
      this.seq = 0;
      this.pending = [];
      this.batch = [];
      this.lastSend = -Infinity;
      this.offsetX = this.offsetY = 0;
    }

    step(input, now) {
      const word = packInput(input);
      const quantized = unpackInput(word);
      move(this.player, this.side, quantized);
      // Keep idle samples between batched taps, then go silent when idle.
      if (word || this.batch.length) {
        this.seq++;
        this.pending.push({seq: this.seq, input: quantized});
        if (this.pending.length > 180) this.pending.shift();
        this.batch.push(word);
        if (this.batch.length > maxBatch) this.batch.shift();
      }
      this.offsetX *= 0.8;
      this.offsetY *= 0.8;
      if (!this.batch.length || now - this.lastSend < packetMs) return;
      const packet = [this.seq - this.batch.length + 1, ...this.batch];
      this.batch = [];
      this.lastSend = now;
      return packet;
    }

    reconcile(authoritative, ack, reset) {
      if (reset) {
        this.pending = [];
        this.batch = [];
        this.player = {...authoritative};
        this.offsetX = this.offsetY = 0;
        return;
      }
      this.pending = this.pending.filter(sample => sample.seq > ack);
      const target = {...authoritative};
      for (const sample of this.pending) move(target, this.side, sample.input);
      const dx = this.player.x - target.x, dy = this.player.y - target.y;
      if (Math.hypot(dx, dy) <= 2) {
        target.x = this.player.x;
        target.y = this.player.y;
      } else {
        this.offsetX += dx;
        this.offsetY += dy;
      }
      this.player = target;
    }

    position() {
      return {x: this.player.x + this.offsetX, y: this.player.y + this.offsetY};
    }
  }

  const round = n => Math.round(n * 100) / 100;
  function packState(s, events) {
    const b = s.ball, impact = b.impact;
    return [s.tick, s.phase, s.message, s.score, s.server, s.serveSide, s.rallyHits,
      s.players.map(p => [round(p.x), round(p.y), round(p.stamina), p.swing, p.speed,
        p.frozen, p.giant, p.cooldown, p.curve, p.freezeShot]),
      [round(b.x), round(b.y), round(b.z), round(b.vx), round(b.vy), b.trail,
        +b.serve, b.lastHit, b.bounces, impact && [round(impact.x), round(impact.y),
          round(impact.z), impact.life, impact.maxLife, impact.kind, impact.color]],
      s.orb && [round(s.orb.x), round(s.orb.y), s.orb.type], events];
  }

  function unpackState(packet, initial) {
    const [tick, phase, message, score, server, serveSide, rallyHits, rows, ball, orb, events, ack] = packet;
    const [x,y,z,vx,vy,trail,serve,lastHit,bounces,impact] = ball;
    return {...initial, tick, phase, message, score, server, serveSide, rallyHits,
      finished: phase === 'finished', ack, events,
      players: rows.map(([x,y,stamina,swing,speed,frozen,giant,cooldown,curve,freezeShot], i) =>
        ({...initial.players[i], x,y,stamina,swing,speed,frozen,giant,cooldown,curve,freezeShot})),
      ball: {x,y,z,vx,vy,trail,serve: !!serve,lastHit,bounces,
        impact: impact && {x:impact[0], y:impact[1], z:impact[2], life:impact[3],
          maxLife:impact[4], kind:impact[5], color:impact[6]}},
      orb: orb && {x:orb[0], y:orb[1], type:orb[2]}};
  }

  class ServePreview {
    constructor(sim, started, seq) {
      this.started = started;
      this.seq = seq;
      this.side = sim.server;
      this.frames = [];
      // Only predict the launch. The server owns contacts, bounces and points.
      for (let tick = 0; tick <= 12; tick++) {
        if (tick) engine.step(sim, [{}, {}]);
        if (sim.phase !== 'rally' || sim.ball.bounces) break;
        this.frames.push({...sim.ball, impact:sim.ball.impact && {...sim.ball.impact}});
      }
    }

    sample(state, now) {
      const elapsed = Math.max(0, (now - this.started) / stepMs);
      const last = this.frames.length - 1;
      // Start at game speed, then ease toward the end of the preview while
      // waiting for the buffered flight. A late packet cannot restart the shot.
      const tick = last ? last * -Math.expm1(-elapsed / last) : 0;
      const a = this.frames[Math.floor(tick)], b = this.frames[Math.ceil(tick)];
      const t = tick - Math.floor(tick);
      const ball = {...a, x:a.x + (b.x-a.x)*t, y:a.y + (b.y-a.y)*t, z:a.z + (b.z-a.z)*t};
      if (state.phase === 'rally') {
        const forward = (state.ball.y - ball.y) * (this.side ? 1 : -1);
        // Check both the shadow and the elevated ball in the server player's view.
        if ((forward >= 0 && forward + state.ball.z - ball.z >= 0) ||
            state.ball.bounces || state.ball.lastHit !== this.side) return null;
      }
      return {ball, swing:Math.max(0, 12-elapsed)};
    }
  }

  class SnapshotBuffer {
    frames = [];
    cursor = -Infinity;

    push(state, now) {
      const last = this.frames.at(-1);
      if (last && state.tick <= last.tick) return false;
      const offset = now - state.tick * stepMs;
      const launching = last?.phase === 'serve' && state.phase === 'rally';
      if (!last || (last.phase !== state.phase && !launching)) {
        this.frames = [];
        this.origin = offset;
        this.cursor = state.tick;
      } else {
        // Follow the server tick clock. A single late packet must not rewind it.
        this.origin = Math.min(offset, this.origin + (offset - this.origin) * 0.02);
      }
      this.frames.push(state);
      if (this.frames.length > 32) this.frames.shift();
      return true;
    }

    sample(now) {
      const frames = this.frames, last = frames.at(-1);
      if (frames.length < 2 || last.finished || last.phase === 'point') return last;
      this.cursor = Math.min(last.tick, Math.max(this.cursor, (now - this.origin - delayMs) / stepMs));
      while (frames.length > 1 && frames[1].tick <= this.cursor) frames.shift();
      const [a,b] = frames;
      if (!b) return a;
      const t = Math.max(0, (this.cursor - a.tick) / (b.tick - a.tick));
      const blend = (from, to) => from + (to - from) * t;
      return {...a, players: a.players.map((p,i) => ({...p,
        x:blend(p.x,b.players[i].x), y:blend(p.y,b.players[i].y)})),
        ball: {...a.ball, x:blend(a.ball.x,b.ball.x), y:blend(a.ball.y,b.ball.y),
          z:blend(a.ball.z,b.ball.z)}};
    }
  }

  return {stepMs, packetMs, InputQueue, Prediction, ServePreview, SnapshotBuffer, packState, unpackState};
});
