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

  function blendBall(from, to, t, appearance = from) {
    return {...appearance, x:from.x + (to.x - from.x) * t,
      y:from.y + (to.y - from.y) * t, z:from.z + (to.z - from.z) * t};
  }

  class SnapshotBuffer {
    frames = [];
    cursor = -Infinity;

    push(state, now) {
      const last = this.frames.at(-1);
      if (last && state.tick <= last.tick) return false;
      const offset = now - state.tick * stepMs;
      const launching = last?.phase === 'serve' && state.phase === 'rally';
      const scoring = last?.phase === 'rally' && (state.phase === 'point' || state.finished);
      if (!last || (last.phase !== state.phase && !launching && !scoring)) {
        this.frames = [];
        this.origin = offset;
        this.cursor = state.tick;
        this.sampledAt = undefined;
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
      if (!last) return;
      const elapsed = now - (this.sampledAt ?? now);
      const target = (now - this.origin - delayMs) / stepMs;
      // After a packet gap, recover at up to 5% above game speed. Skipping
      // directly to the target makes one frame cover the whole missed distance.
      const limit = this.sampledAt === undefined ? target : this.cursor + Math.max(0, elapsed) * 1.05 / stepMs;
      this.sampledAt = now;
      const next = Math.max(frames[0].tick, this.cursor, Math.min(target, limit));
      this.cursor = Math.min(last.tick, next);
      if (frames.length < 2) return last;
      while (frames.length > 1 && frames[1].tick <= this.cursor) frames.shift();
      const [a,b] = frames;
      if (!b) return a;
      const t = Math.max(0, (this.cursor - a.tick) / (b.tick - a.tick));
      const blend = (from, to) => from + (to - from) * t;
      let ball;
      if (a.phase === 'serve' && b.phase === 'rally') {
        const impact = b.rallyHits === 1 && b.ball.impact;
        // Impact life counts elapsed physics ticks since contact. Split this
        // interval there so a moving player and the airborne ball take distinct paths.
        const releaseTick = impact ? Math.max(a.tick, b.tick - (impact.maxLife - impact.life)) : a.tick;
        const release = impact || a.ball;
        if (this.cursor < releaseTick) {
          ball = blendBall(a.ball, release, (this.cursor - a.tick) / (releaseTick - a.tick));
        } else {
          ball = blendBall(release, b.ball, (this.cursor - releaseTick) / (b.tick - releaseTick), b.ball);
        }
      } else {
        ball = blendBall(a.ball, b.ball, t);
      }
      return {...a, ball, players: a.players.map((p,i) => ({...p,
        x:blend(p.x,b.players[i].x), y:blend(p.y,b.players[i].y)}))};
    }
  }

  return {stepMs, packetMs, InputQueue, Prediction, SnapshotBuffer, packState, unpackState};
});
