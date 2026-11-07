/* =====================================================================
 * 05-audio.js —— WebAudio：引擎声（转速驱动）+ 音效（换挡/碰撞/提示）
 * 首次用户交互后才创建 AudioContext（浏览器自动播放策略）
 * ===================================================================== */
'use strict';

var Sfx = (function () {
  var ctx = null, master = null, muted = false;
  var engine = { osc: null, osc2: null, gain: null, filter: null };
  var started = false;

  function ensure() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.55;
      master.connect(ctx.destination);
      return true;
    } catch (e) { return false; }
  }

  // 引擎：锯齿波 + 低通，频率随转速变化
  function startEngine() {
    if (!ensure() || started) return;
    started = true;
    engine.osc = ctx.createOscillator();
    engine.osc2 = ctx.createOscillator();
    engine.osc.type = 'sawtooth';
    engine.osc2.type = 'square';
    engine.osc.frequency.value = 90;
    engine.osc2.frequency.value = 45;
    engine.filter = ctx.createBiquadFilter();
    engine.filter.type = 'lowpass';
    engine.filter.frequency.value = 900;
    engine.gain = ctx.createGain();
    engine.gain.gain.value = 0;
    engine.osc.connect(engine.filter);
    engine.osc2.connect(engine.filter);
    engine.filter.connect(engine.gain);
    engine.gain.connect(master);
    engine.osc.start();
    engine.osc2.start();
  }

  // 每帧：rpm01 = 0..1 转速，load = 0..1 油门
  function updateEngine(rpm01, load, active) {
    if (!ctx || !engine.osc) return;
    var t = ctx.currentTime;
    var f = 70 + rpm01 * 260;
    engine.osc.frequency.setTargetAtTime(f, t, 0.06);
    engine.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    engine.filter.frequency.setTargetAtTime(500 + rpm01 * 2600, t, 0.08);
    var v = active ? (0.05 + load * 0.10) : 0;
    engine.gain.gain.setTargetAtTime(v, t, 0.1);
  }

  function stopEngine() {
    if (!ctx || !engine.gain) return;
    engine.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  }

  // 短促音效
  function blip(freq, dur, type, vol) {
    if (!ensure() || muted) return;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'triangle';
    o.frequency.value = freq;
    g.gain.value = vol == null ? 0.15 : vol;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(master);
    o.start(); o.stop(ctx.currentTime + dur);
  }

  var fx = {
    shift: function () { blip(320, 0.07, 'square', 0.08); },
    contact: function () { blip(90, 0.18, 'sawtooth', 0.22); },
    lap: function () { blip(880, 0.10, 'triangle', 0.12); setTimeout(function () { blip(1320, 0.14, 'triangle', 0.10); }, 90); },
    countdown: function () { blip(440, 0.12, 'square', 0.12); },
    go: function () { blip(880, 0.30, 'square', 0.16); },
    finish: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { blip(f, 0.20, 'triangle', 0.14); }, i * 130); }); },
    offTrack: function () { blip(160, 0.10, 'sawtooth', 0.06); },
  };

  function setMuted(v) { muted = !!v; if (master) master.gain.value = muted ? 0 : 0.55; }
  function isMuted() { return muted; }
  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

  return {
    startEngine: startEngine, updateEngine: updateEngine, stopEngine: stopEngine,
    fx: fx, setMuted: setMuted, isMuted: isMuted, resume: resume, ensure: ensure,
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = Sfx; }
