/* =====================================================================
 * 06-game.js —— 主循环 / 页面流转 / 键盘与手柄输入 / 存档
 * ===================================================================== */
'use strict';

var Game = (function () {
  var app = {
    opts: { trackId: 'sakhir', weatherId: 'dry', difficulty: 'normal', camera: 'chase' },
    race: null, running: false, paused: false, last: 0, acc: 0,
    screen: 'title', attractT: 0,
  };
  var canvas, ui = {};
  var keys = {};
  var save = { best: {}, score: 0, muted: false, camera: 'chase' };
  var padPrev = {};

  var SAVE_KEY = 'max33-save-v1';

  function $(id) { return document.getElementById(id); }

  function loadSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (raw) { var o = JSON.parse(raw); if (o) save = Object.assign(save, o); }
    } catch (e) { /* 忽略 */ }
  }
  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* 忽略 */ }
  }

  // ---------------- 初始化 ----------------
  function init() {
    canvas = $('view');
    if (!GL3D.init(canvas)) throw new Error('WebGL 初始化失败：当前浏览器/显卡不支持 WebGL 1.0，或远程桌面/无头模式禁用了 GPU 加速。');
    HUD.init();
    loadSave();
    app.opts.camera = save.camera || 'chase';
    buildUI();
    bindInput();
    showScreen('title');
    app.running = true;
    app.last = performance.now();
    requestAnimationFrame(frame);
  }

  function buildUI() {
    // 赛道选项
    ui.trackOpts = $('track-opts');
    Track.list().forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'opt'; b.textContent = t.name; b.dataset.id = t.id;
      b.onclick = function () { app.opts.trackId = t.id; refreshOpts(); };
      ui.trackOpts.appendChild(b);
    });
    // 天气
    ui.weatherOpts = $('weather-opts');
    [['dry', '干燥'], ['damp', '潮湿'], ['wet', '雨战']].forEach(function (w) {
      var b = document.createElement('button');
      b.className = 'opt'; b.textContent = w[1]; b.dataset.id = w[0];
      b.onclick = function () { app.opts.weatherId = w[0]; refreshOpts(); };
      ui.weatherOpts.appendChild(b);
    });
    // 难度
    ui.diffOpts = $('diff-opts');
    [['easy', '轻松'], ['normal', '标准'], ['hard', '困难']].forEach(function (d) {
      var b = document.createElement('button');
      b.className = 'opt'; b.textContent = d[1]; b.dataset.id = d[0];
      b.onclick = function () { app.opts.difficulty = d[0]; refreshOpts(); };
      ui.diffOpts.appendChild(b);
    });
    // 视角
    ui.camOpts = $('cam-opts');
    [['chase', '第三人称'], ['cockpit', '车手视角']].forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'opt'; b.textContent = c[1]; b.dataset.id = c[0];
      b.onclick = function () { setCamera(c[0]); };
      ui.camOpts.appendChild(b);
    });

    $('btn-race').onclick = function () { beginSession('race'); };
    $('btn-quali').onclick = function () { beginSession('timetrial'); };
    $('btn-endless').onclick = function () { beginSession('endless'); };
    $('btn-go').onclick = function () { startRace(); };
    $('btn-back').onclick = function () { showScreen('title'); };
    $('btn-again').onclick = function () { beginSession(app.race ? app.race.mode : 'race'); };
    $('btn-menu').onclick = function () { showScreen('title'); };
    $('btn-resume').onclick = function () { togglePause(false); };
    $('btn-restart').onclick = function () { togglePause(false); if (app.race) beginSession(app.race.mode); };
    $('btn-quit').onclick = function () { togglePause(false); quitToTitle(); };
    refreshOpts();
  }

  function refreshOpts() {
    function mark(container, activeId) {
      if (!container) return;
      Array.prototype.forEach.call(container.children, function (c) {
        c.classList.toggle('on', c.dataset.id === activeId);
      });
    }
    mark(ui.trackOpts, app.opts.trackId);
    mark(ui.weatherOpts, app.opts.weatherId);
    mark(ui.diffOpts, app.opts.difficulty);
    mark(ui.camOpts, app.opts.camera);
  }

  function setCamera(id) {
    app.opts.camera = id;
    GL3D.state.camera = id;
    save.camera = id; persist();
    refreshOpts();
  }

  // ---------------- 页面 ----------------
  function showScreen(name) {
    ['title', 'brief', 'result', 'pause'].forEach(function (s) {
      var e = $('screen-' + s);
      if (e) e.classList.toggle('hidden', s !== name);
    });
    if (name === 'title') { HUD.hide(); Sfx.stopEngine(); }
    if (name !== 'title') updateLights(null);
    app.screen = name;
  }

  function beginSession(mode) {
    app.opts.mode = mode || 'race';
    var profile = Track.PROFILES.filter(function (p) { return p.id === app.opts.trackId; })[0] || Track.PROFILES[0];
    var weatherName = Race.WEATHERS[app.opts.weatherId] ? Race.WEATHERS[app.opts.weatherId].name : '干燥';
    $('brief-kicker').textContent = mode === 'timetrial' ? 'TIME TRIAL' : mode === 'endless' ? 'ENDLESS' : 'RACE';
    $('brief-title').textContent = profile.name;
    $('brief-sub').textContent = profile.country + ' · ' + (mode === 'endless' ? '无尽挑战' : (mode === 'timetrial' ? '单圈计时' : '大奖赛')) + ' · ' + weatherName + ' · 难度 ' + (Race.DIFFS[app.opts.difficulty] || Race.DIFFS.normal).name;
    $('brief-kv').innerHTML =
      '<div><div class="k">赛道长度</div><div class="v">' + (Track.build(profile.id).trackLength / 1000).toFixed(2) + ' km</div></div>' +
      '<div><div class="k">圈数</div><div class="v">' + (mode === 'endless' ? '∞' : (mode === 'timetrial' ? '1 圈计时' : profile.laps + ' 圈')) + '</div></div>' +
      '<div><div class="k">天气</div><div class="v">' + weatherName + '</div></div>' +
      '<div><div class="k">最佳圈速</div><div class="v">' + Util.fmtTime(save.best[profile.id]) + '</div></div>';
    showScreen('brief');
  }

  function startRace() {
    var mode = app.opts.mode || 'race';
    app.race = Race.create({
      trackId: app.opts.trackId, weatherId: app.opts.weatherId,
      difficulty: app.opts.difficulty, mode: mode, camera: app.opts.camera,
      onRadio: function (key) {
        if (key === 'contact') Sfx.fx.contact();
        else if (key === 'lap') Sfx.fx.lap();
      },
    });
    for (var i = 0; i < app.race.cars.length; i++) {
      GL3D.buildCar({ id: app.race.cars[i].id, color: app.race.cars[i].color, accent: app.race.cars[i].accent, compound: app.race.cars[i].compound });
    }
    GL3D.state.camera = app.opts.camera;
    app.paused = false;
    showScreen(null);
    HUD.show();
    Sfx.ensure(); Sfx.resume(); Sfx.startEngine();
  }

  function quitToTitle() {
    app.race = null;
    showScreen('title');
  }

  function togglePause(on) {
    if (!app.race) return;
    app.paused = on == null ? !app.paused : on;
    showScreen(app.paused ? 'pause' : null);
    if (!app.paused) app.last = performance.now();
  }

  function finishRace() {
    var r = app.race;
    if (!r) return;
    var p = r.player;
    var pos = r.playerPos || 1;
    var best = save.best[r.track.id];
    if (p.bestLap && (best == null || p.bestLap < best)) { save.best[r.track.id] = p.bestLap; }
    if (r.mode === 'endless' && r.score > (save.score || 0)) save.score = r.score;
    persist();
    Sfx.fx.finish();
    Sfx.stopEngine();
    $('res-kicker').textContent = r.mode === 'endless' ? 'ENDLESS' : (r.mode === 'timetrial' ? 'TIME TRIAL' : 'RACE RESULT');
    $('res-title').textContent = r.mode === 'timetrial' ? '完成' : ('P' + pos);
    $('res-sub').textContent = r.track.name + ' · ' + (r.mode === 'endless' ? '得分 ' + r.score : (r.mode === 'timetrial' ? '单圈计时' : '大奖赛')) + ' · 最快圈 ' + Util.fmtTime(p.bestLap);
    $('res-kv').innerHTML =
      '<div><div class="k">最快圈</div><div class="v">' + Util.fmtTime(p.bestLap) + '</div></div>' +
      '<div><div class="k">上圈</div><div class="v">' + Util.fmtTime(p.lastLap) + '</div></div>' +
      '<div><div class="k">总时间</div><div class="v">' + Util.fmtTime(r.time * 1000) + '</div></div>' +
      '<div><div class="k">碰撞</div><div class="v">' + (r.contactHits || 0) + ' 次</div></div>';
    showScreen('result');
  }

  // ---------------- 起跑灯 ----------------
  var lightEls = null, lightState = null;
  function updateLights(r) {
    if (!lightEls) lightEls = Array.prototype.slice.call(document.querySelectorAll('#lights .lg'));
    var wrap = document.getElementById('lights');
    if (!r || r.phase !== 'countdown') {
      if (lightState !== 'off') { if (wrap) wrap.classList.add('hidden'); lightState = 'off'; }
      return;
    }
    if (wrap) wrap.classList.remove('hidden');
    var remain = r.countdown;
    // 倒计时 4.2 秒 → 先亮 1 盏、再 2 盏…最后 5 盏全亮，然后熄灭起步
    var lit = Math.max(0, Math.min(5, Math.ceil((4.2 - remain) / 0.72)));
    if (lit !== lightState) {
      lightState = lit;
      lightEls.forEach(function (e, i) { e.classList.toggle('on', i < lit); e.classList.remove('go'); });
    }
  }

  // ---------------- 输入 ----------------
  function bindInput() {
    window.addEventListener('keydown', function (e) {
      keys[e.code] = true;
      if (e.code === 'KeyC') { setCamera(app.opts.camera === 'chase' ? 'cockpit' : 'chase'); }
      if (e.code === 'KeyP') { togglePause(); }
      if (e.code === 'KeyM') { save.muted = !save.muted; Sfx.setMuted(save.muted); persist(); }
      if (e.code === 'KeyR' && app.race) { beginSession(app.race.mode); }
      if (e.code === 'Escape' && app.race) { togglePause(); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].indexOf(e.code) >= 0) e.preventDefault();
      Sfx.resume();
    });
    window.addEventListener('keyup', function (e) { keys[e.code] = false; });
    window.addEventListener('blur', function () { keys = {}; });
    document.addEventListener('visibilitychange', function () { if (document.hidden && app.race && !app.paused) togglePause(true); });
  }

  function pollGamepad() {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var i = 0; i < pads.length; i++) {
      var gp = pads[i];
      if (!gp) continue;
      var steer = gp.axes[0] || 0;
      if (Math.abs(steer) < 0.12) steer = 0;
      var rt = gp.buttons[7] ? gp.buttons[7].value : 0;
      var lt = gp.buttons[6] ? gp.buttons[6].value : 0;
      var ers = gp.buttons[0] ? gp.buttons[0].pressed : false;
      var start = gp.buttons[9] ? gp.buttons[9].pressed : false;
      if (start && !padPrev.start) togglePause();
      padPrev.start = start;
      if (Math.abs(steer) > 0.12 || rt > 0.05 || lt > 0.05) {
        return { steer: Util.clamp(steer, -1, 1), throttle: rt, brake: lt, ers: ers, analog: true };
      }
    }
    return null;
  }

  function readInput() {
    var gp = pollGamepad();
    if (gp) return gp;
    var steer = 0;
    if (keys['KeyA'] || keys['ArrowLeft']) steer -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) steer += 1;
    // 键盘：左右是离散输入，转成 -1/0/1；模拟量由平滑环处理
    return {
      steer: steer,
      throttle: (keys['KeyW'] || keys['ArrowUp']) ? 1 : 0,
      brake: (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0,
      ers: !!keys['Space'],
      analog: false,
    };
  }

  // ---------------- 主循环 ----------------
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, Math.max(0.0005, (now - app.last) / 1000));
    app.last = now;
    app.attractT += dt;

    if (app.race && !app.paused) {
      var input = readInput();
      // 固定步长积分（60Hz），保证物理稳定
      app.acc = Math.min(app.acc + dt, 0.2);
      var steps = 0;
      while (app.acc >= 1 / 60 && steps < 5) {
        Race.update(app.race, 1 / 60, input);
        app.acc -= 1 / 60; steps++;
      }
      app.race.steerVisual = app.race.player.steerSmooth || 0;
      app.race.camera = app.opts.camera;
      GL3D.state.camera = app.opts.camera;
      GL3D.draw(app.race, dt);
      HUD.update(app.race);
      var p = app.race.player;
      var spdPct = Util.clamp(p.speed / Cars.MAX_SPEED, 0, 1);
      Sfx.updateEngine(spdPct, Math.max(p.throttle || 0, 0.4), true);
      if (app.race.phase === 'finished' && app.screen !== 'result') finishRace();
      updateLights(app.race);
      if (app.race.phase === 'countdown') {
        var lastCount = app.race._lastCount == null ? 5 : app.race._lastCount;
        var cur = Math.ceil(app.race.countdown);
        if (cur !== lastCount) {
          app.race._lastCount = cur;
          if (cur <= 3 && cur > 0) Sfx.fx.countdown();
          if (cur === 0) Sfx.fx.go();
        }
      }
    } else if (app.running) {
      // 首页/暂停：画一个静态展示场景
      var demo = app._demo || (app._demo = makeDemo());
      GL3D.state.camera = 'chase';
      GL3D.draw(demo, dt);
    }
  }

  // 首页背景：沿赛道自动巡航的镜头（用一个假的 race 对象驱动）
  function makeDemo() {
    var track = Track.build('sakhir');
    GL3D.buildWorld(track);
    var smp = Track.sample3d(track, 0, {});
    var demoCar = Cars.newCar(Cars.drivers[0], { z: 0, offset: 0, heading: smp.h });
    var demo = {
      track: track, player: demoCar, cars: [demoCar], time: 0,
      playerPos: 1, totalLaps: 3, messages: [], order: [demoCar],
      phase: 'racing', mode: 'demo',
    };
    return demo;
  }

  // 供探针/调试使用
  var debug = {
    beginSession: function (mode) { beginSession(mode); var self = this; setTimeout(function () { startRace(); }, 30); },
    startRace: startRace,
    state: function () { return { screen: app.screen, paused: app.paused, hasRace: !!app.race, mode: app.opts.mode }; },
    opts: app.opts,
  };

  return {
    init: init, frame: frame, app: app, debug: debug,
    showScreen: showScreen, beginSession: beginSession, startRace: startRace,
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = Game; }
