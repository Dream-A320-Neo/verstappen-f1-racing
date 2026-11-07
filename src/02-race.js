/* =====================================================================
 * 02-race.js —— 比赛状态机 / 车辆物理 / AI / 碰撞 / 圈数
 *
 * 坐标与符号约定（全局统一）：
 *   车头方向 forward = (sin(heading), cos(heading))     heading 从 +z 轴起算
 *   右侧 right      = (-cos(heading), sin(heading))     offset 正 = 偏右
 *   打右方向 → heading 减小
 * ===================================================================== */
'use strict';

var Race = (function () {
  // ---- 物理常量 ----
  var YAW_RATE = 2.55;          // 车头角速度上限 rad/s
  var STEER_RAMP_KEY = 9;       // 键盘打方向爬升速率（约 0.33s 到满舵 → 角速度先慢后快）
  var STEER_RAMP_PAD = 26;
  var STEER_RET_KEY = 3.2;      // 松手回正（较快）
  var STEER_RET_PAD = 8;
  var STEER_TRIM_A = 1.15;      // 高速收敛强度
  var STEER_TRIM_FROM = 0.45;   // 45% 车速开始收敛
  var STEER_CURVE_POW = 1.5;    // 转向响应曲线指数（起手更柔和）
  var SLIP_MAX = 0.42;
  var CONTACT_Z = 3.45;         // 纵向碰撞距离（米）
  var CONTACT_LAT = 1.41;       // 横向碰撞距离（米）—— 车宽 2 米
  var HIT_COOLDOWN = 2.5;
  var CONTACT_PENALTY = 1.0;    // 碰撞罚时（秒）

  var DIFFS = {
    easy: { pace: 0.90, name: '轻松' },
    normal: { pace: 0.955, name: '标准' },
    hard: { pace: 0.995, name: '困难' },
  };
  var WEATHERS = {
    dry: { name: '干燥', grip: 1.0, wetness: 0, fog: 0 },
    damp: { name: '潮湿', grip: 0.88, wetness: 0.35, fog: 0.25 },
    wet: { name: '雨战', gauge: 1, grip: 0.72, wetness: 0.85, fog: 0.55 },
  };

  function say(r, text, sub, color, life) {
    r.messages.push({ text: text, sub: sub || '', color: color || '#38b6ff', t: r.time, life: life || 2.6 });
    if (r.messages.length > 5) r.messages.shift();
  }
  function radio(r, key) {
    if (r.onRadio) r.onRadio(key);
  }

  // 创建一场比赛
  function create(opts) {
    opts = opts || {};
    var track = Track.build(opts.trackId || 'sakhir');
    var mode = opts.mode || 'race';
    var diff = DIFFS[opts.difficulty] || DIFFS.normal;
    var weather = WEATHERS[opts.weatherId] || WEATHERS.dry;

    var totalCars = mode === 'timetrial' ? 1 : 20;
    var drivers = Cars.drivers.slice(0, totalCars);
    var cars = [];
    var startS = 0;
    for (var i = 0; i < drivers.length; i++) {
      // 发车格：两列交错，前后间隔 8 米
      var row = Math.floor(i / 2);
      var col = (i % 2 === 0) ? -1 : 1;
      var smp = Track.sample3d(track, startS - row * 8, {});
      cars.push(Cars.newCar(drivers[i], {
        z: ((startS - row * 8) % track.trackLength + track.trackLength) % track.trackLength,
        offset: col * 3.2,
        heading: smp.h,
        compound: optionsCompoundFor(opts.weatherId),
      }));
    }

    var race = {
      mode: mode, track: track, weather: weather, weatherId: opts.weatherId || 'dry',
      difficulty: opts.difficulty || 'normal', pace: diff.pace, diffName: diff.name,
      cars: cars, player: cars[0],
      time: 0, phase: 'countdown', countdown: 4.2,
      messages: [], camera: opts.camera || 'chase',
      totalLaps: mode === 'endless' ? 999 : (track.laps || 3),
      score: 0, endlessRamp: 0, contactHits: 0,
      shake: 0, onRadio: opts.onRadio || null,
      finishOrder: [],
      steerVisual: 0,
    };
    cars.forEach(function (c) { c.lapStart = 0; c.progress = 0; });
    return race;
  }

  function optionsCompoundFor(weatherId) {
    if (weatherId === 'wet') return 'wet';
    if (weatherId === 'damp') return 'inter';
    return 'medium';
  }

  // 每帧更新
  function update(r, dt, input) {
    if (r.phase === 'countdown') {
      r.countdown -= dt;
      // 倒计时期间车辆不能动，但玩家可以预打方向
      r.player.steerSmooth = 0;
      if (r.countdown <= 0) {
        r.phase = 'racing';
        r.time = 0;
        say(r, '灯灭，全力冲刺！', '', '#7ae582', 2.2);
      }
      return;
    }
    if (r.phase !== 'racing' && r.phase !== 'finished') return;
    if (r.phase === 'finished') return;

    r.time += dt;
    r.endlessRamp = r.mode === 'endless' ? r.time / 60 : 0;

    // 消息生命周期
    r.messages = r.messages.filter(function (m) { return r.time - m.t < m.life; });

    applyPlayer(r, r.player, dt, input || {});
    for (var i = 1; i < r.cars.length; i++) applyAI(r, r.cars[i], dt);
    collisions(r, dt);
    updateLaps(r, dt);
    r.shake = Math.max(0, r.shake - dt * 3);

    if (r.mode !== 'endless' && r.player.finished) {
      // 等一会儿出结果
      r.finishTimer = (r.finishTimer || 0) + dt;
      if (r.finishTimer > 1.2) r.phase = 'finished';
    }
  }

  // ---------------- 玩家物理 ----------------
  function applyPlayer(r, p, dt, input) {
    var track = r.track;
    var analog = !!input.analog;
    var steerIn = Math.abs(input.steer || 0) > 0.01;

    // 1) 转向输入：渐进爬升（先慢）+ 松手快速回正
    var rate = steerIn ? (analog ? STEER_RAMP_PAD : STEER_RAMP_KEY) : (analog ? STEER_RET_PAD : STEER_RET_KEY);
    if (p.steerSmooth == null) p.steerSmooth = 0;
    var target = Util.clamp(input.steer || 0, -1, 1);
    var d = target - p.steerSmooth;
    var step = rate * dt;
    p.steerSmooth = Math.abs(d) <= step ? target : p.steerSmooth + Util.sign(d) * step;

    // 2) 油门 / 刹车
    var thr = Util.saturate(input.throttle || 0);
    var brk = Util.saturate(input.brake || 0);
    var smp = Track.sample3d(track, p.z, {});
    var wetness = r.weather.wetness * (1 - Util.saturate(r.endlessRamp * 0.1));
    var trackG = Util.lerp(1, r.weather.grip, 1);      // 路面抓地
    var grip = Cars.tyreGrip(p, trackG, wetness);

    // 3) ERS：按住加速，消耗电量
    var ersOn = !!input.ers && p.ers > 0.02 && thr > 0.1;
    p.ersActive = ersOn;
    if (ersOn) { p.ers = Math.max(0, p.ers - dt * 0.28); } else { p.ers = Math.min(1, p.ers + dt * 0.045); }

    // 4) 纵向速度
    var v = p.speed;
    var maxV = Cars.MAX_SPEED * (0.92 + 0.08 * grip / 1.2);
    if (ersOn) maxV *= 1.045;
    // 尾流：紧跟前车时直道更快
    var draft = 0;
    for (var k = 0; k < r.cars.length; k++) {
      var o = r.cars[k];
      if (o === p || o.finished) continue;
      var dz = Util.wrapDelta(o.z, p.z, track.trackLength);
      if (dz > 0 && dz < 26 && Math.abs(o.offset - p.offset) < 2.2) { draft = Math.max(draft, (1 - dz / 26) * 0.05); }
    }
    maxV *= 1 + draft;
    var accel = Cars.ACCEL * grip * (ersOn ? 1.35 : 1) * (thr > 0 ? thr : 0);
    if (v < maxV) v += accel * dt;
    else v = Math.max(maxV, v - 6 * dt);
    v -= Cars.BRAKE * grip * brk * dt;
    v -= Cars.DRAG * v * v * dt;
    if (brk < 0.05 && thr < 0.05) v -= 3 * dt;         // 滑行阻力
    v = Util.clamp(v, 0, Cars.MAX_SPEED * 1.12);

    // 5) 车头角：渐进转向 + 幂曲线（起手柔和）+ 高速收敛 + 抓地
    var spdPct = Util.clamp(Math.abs(v) / Cars.MAX_SPEED, 0, 1);
    var trimBase = Util.clamp((spdPct - STEER_TRIM_FROM) / (1 - STEER_TRIM_FROM), 0, 1);
    var steerTrim = 1 / (1 + STEER_TRIM_A * trimBase);
    var steerForYaw = Util.sign(p.steerSmooth) * Math.pow(Math.abs(p.steerSmooth), STEER_CURVE_POW);
    var speedFactor = Util.clamp(0.34 + spdPct * 0.95, 0.34, 1.05);
    var yawAuth = Util.clamp(0.62 + 0.38 * spdPct, 0.62, 1.05) * Util.clamp(grip, 0.7, 1.1);
    /* 转向必须随车速：真实车静止时打方向车头不会转。
     * 之前没有这个约束，按 D 就能以 0 速度原地转 79°，表现为「车快速往右转」。 */
    var yawSpeed = Util.clamp(Math.abs(v) / 6, 0, 1);
    p.heading += steerForYaw * steerTrim * YAW_RATE * yawAuth * speedFactor * yawSpeed * dt;

    // 6) 位移：按车头与赛道方向的夹角前进（打滑时衰减）
    var err = Util.wrapAngle(p.heading - smp.h);
    var maxSlip = Util.clamp(0.30 * grip, 0.10, SLIP_MAX);
    var slip = Util.clamp(err, -maxSlip, maxSlip);
    var dist = v * Math.cos(slip) * dt;
    p.z = (p.z + dist + track.trackLength) % track.trackLength;
    p.offset += v * dt * Math.sin(slip);   // 符号修正：车头偏左就向左漂，偏右就向右漂
    p.offset = Util.clamp(p.offset, -60, 60);

    // 7) 冲出赛道：减速 + 扬尘（缓冲区/草地）
    var offAbs = Math.abs(p.offset);
    if (offAbs > Track.ROAD_HALF + 0.6) {
      var over = Util.clamp((offAbs - Track.ROAD_HALF) / 6, 0, 1);
      v *= 1 - over * dt * 2.6;
      p.damage = Math.min(1, p.damage + over * dt * 0.03);
      if (offAbs > Track.ROAD_HALF + Track.RUNOFF_MAX - 2) {
        // 撞墙：反弹并扣速
        p.offset = Util.clamp(p.offset, -(Track.ROAD_HALF + Track.RUNOFF_MAX - 2), Track.ROAD_HALF + Track.RUNOFF_MAX - 2);
        if (v > 30) { p.damage = Math.min(1, p.damage + 0.02); r.shake = 0.5; }
        v *= 0.55;
      }
    } else {
      // 压路肩有轻微颠簸
      if (offAbs > Track.ROAD_HALF - 0.4) r.shake = Math.max(r.shake, 0.08);
    }

    p.speed = v;
    p.kmh = Math.round(v * 3.6);
    p.wear = Util.clamp(p.wear + dt * (Cars.compounds[p.compound].wear) * (0.004 + 0.010 * Math.abs(p.steerSmooth)) * (1 + spdPct), 0, 1);
    p.trackG = trackG; p.grip = grip; p.wetness = wetness;

    // 8) 挡位：按速度分 8 档 + 迟滞
    var want = 1 + Math.floor(spdPct * 8);
    if (p.gear == null) p.gear = 1;
    p.gearHold = (p.gearHold || 0) + dt;
    if (want !== p.gear) {
      var bandOk = Math.abs(spdPct - (p.gear - 1) / 8) > 0.045;
      if (bandOk && p.gearHold > 0.35) { p.gear = want; p.gearHold = 0; }
    } else { p.gearHold = 0; }
    p.gear = Util.clamp(p.gear, 1, 8);

    // 9) 车身姿态：侧倾来自横向加速度，俯仰来自踏板
    var latG = -p.steerSmooth * spdPct * 1.6;
    p.roll = Util.lerp(p.roll || 0, Util.clamp(-latG * 0.026, -0.042, 0.042), 1 - Math.exp(-dt * 9));
    var pedal = Util.clamp(brk * 1.0 - thr * 0.55, -0.6, 1);
    p.pitch = Util.lerp(p.pitch || 0, Util.clamp(pedal * 0.022, -0.026, 0.026), 1 - Math.exp(-dt * 5.5));
    p.heave = (p.heave || 0) + 0; p.heave = 0.01 * Math.sin(r.time * 9) * spdPct;

    // 10) 车轮转速（视觉用，限幅避免闪烁假象）
    p.wheelSpin = Util.clamp((p.wheelSpin || 0) + (v / 0.35) * dt, -14, 14);
  }

  // ---------------- AI ----------------
  function applyAI(r, c, dt) {
    var track = r.track;
    var smp = Track.sample3d(track, c.z, {});
    // 前视：速度越快看得越远
    var look = 6 + Math.round(18 * (c.speed / Cars.MAX_SPEED));
    var ahead = Track.sample3d(track, c.z + Track.SEG_LEN * look, {});
    // 目标线：弯心内切
    var line = Util.clamp(smp.curve * 26, -3.2, 3.2);
    var err = Util.wrapAngle(c.heading - ahead.h);
    var offErr = line - c.offset;
    var steer = Util.clamp(err * 3.2 + offErr * 0.055, -1, 1);

    // 过弯限速：半径越小越慢
    var radius = Math.abs(smp.curve) > 0.0001 ? 1 / Math.abs(smp.curve) : 1e9;
    var limit = Cars.MAX_SPEED * Math.sqrt(Util.saturate(radius / 260)) * 1.18 * r.pace;
    limit = Math.max(limit, Cars.MAX_SPEED * 0.26);
    var throttle = c.speed < limit * 0.98 ? 1 : 0;
    var brake = c.speed > limit * 1.04 ? 1 : 0;

    // 用和玩家同一套物理，但不需要手柄平滑
    var grip = Cars.tyreGrip(c, r.weather.grip, r.weather.wetness);
    var spdPct = Util.clamp(c.speed / Cars.MAX_SPEED, 0, 1);
    var speedFactor = Util.clamp(0.34 + spdPct * 0.95, 0.34, 1.05);
    var yawAuth = Util.clamp(0.62 + 0.38 * spdPct, 0.62, 1.05) * Util.clamp(grip, 0.7, 1.1);
    var aiYawSpeed = Util.clamp(Math.abs(c.speed) / 6, 0, 1);
    c.heading += steer * YAW_RATE * yawAuth * speedFactor * aiYawSpeed * dt;

    // 速度
    if (c.speed < limit) c.speed = Math.min(limit, c.speed + Cars.ACCEL * grip * throttle * dt);
    else c.speed = Math.max(limit, c.speed - Cars.BRAKE * grip * brake * dt);
    c.speed = Math.max(0, c.speed);

    // 位移
    var err2 = Util.wrapAngle(c.heading - smp.h);
    var maxSlip = Util.clamp(0.30 * grip, 0.10, SLIP_MAX);
    var slip2 = Util.clamp(err2, -maxSlip, maxSlip);
    c.z = (c.z + c.speed * Math.cos(slip2) * dt + track.trackLength) % track.trackLength;
    c.offset += c.speed * dt * Math.sin(slip2);   // 同上，符号修正
    var lim = Track.ROAD_HALF + Track.RUNOFF_MAX - 2;
    c.offset = Util.clamp(c.offset, -lim, lim);
    c.wear = Util.clamp(c.wear + dt * 0.0035, 0, 1);
    c.gear = Util.clamp(1 + Math.floor(spdPct * 8), 1, 8);
    c.kmh = Math.round(c.speed * 3.6);
  }

  // ---------------- 碰撞 ----------------
  function collisions(r, dt) {
    var p = r.player;
    if (p.finished) return;
    for (var i = 1; i < r.cars.length; i++) {
      var o = r.cars[i];
      if (o.finished) continue;
      var dz = Util.wrapDelta(o.z, p.z, r.track.trackLength);   // 正值=对方在前
      if (Math.abs(dz) > CONTACT_Z) continue;
      var dOff = p.offset - o.offset;
      if (Math.abs(dOff) > CONTACT_LAT) continue;               // 横向 1.41 米才接触

      var closing = p.speed - o.speed;
      // 分离，避免穿模
      var push = (CONTACT_LAT - Math.abs(dOff)) * Util.sign(dOff || 1) * 0.5;
      p.offset += push; o.offset -= push;
      if (Math.abs(dz) < CONTACT_Z * 0.8) {
        if (dz > 0) { p.speed *= 0.94; } else { p.speed *= 0.99; }
      }
      var canDamage = o._hitAt == null || (r.time - o._hitAt) > HIT_COOLDOWN;
      if (canDamage && Math.abs(closing) > Cars.MAX_SPEED * 0.06) {
        o._hitAt = r.time;
        r.contactHits++;
        r.shake = Math.max(r.shake, 0.35);
        p.damage = Math.min(1, p.damage + 0.006);
        r.penalty = (r.penalty || 0) + CONTACT_PENALTY;
        say(r, '发生接触！', '+' + CONTACT_PENALTY.toFixed(1) + ' 秒罚时', '#ffb04a', 2.4);
        radio(r, 'contact');
        if (r.mode === 'endless') r.score = Math.max(0, r.score - 80);
      }
    }
  }

  // ---------------- 圈数 ----------------
  function updateLaps(r, dt) {
    var track = r.track, len = track.trackLength;
    for (var i = 0; i < r.cars.length; i++) {
      var c = r.cars[i];
      if (c.finished) continue;
      var prev = c._prevZ == null ? c.z : c._prevZ;
      var lastS = c._lastS == null ? c.z : c._lastS;
      var delta = Util.wrapDelta(c.z, lastS, len);
      c.progress += delta;
      c._lastS = c.z;
      c._prevZ = c.z;
      if (c.progress >= len) {
        c.progress -= len;
        c.lap++;
        var lapTime = (r.time - c.lapStart) * 1000;
        c.lastLap = lapTime;
        if (c.bestLap == null || lapTime < c.bestLap) c.bestLap = lapTime;
        c.lapStart = r.time;
        if (c === r.player) {
          say(r, '第 ' + (c.lap - 1) + ' 圈 ' + Util.fmtTime(lapTime), '最快 ' + Util.fmtTime(c.bestLap), '#7ae582', 2.6);
          if (r.mode === 'endless') r.score += 500;
        }
        if (c.lap > r.totalLaps) {
          c.finished = true;
          c.finishTime = r.time;
          r.finishOrder.push(c);
          if (c === r.player) {
            r.phase = 'finished';
            r.finishTimer = 99;
          }
        }
      }
    }
    // 实时排名（按进度 + 圈数）
    var order = r.cars.slice().sort(function (a, b) {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return (b.lap * len + b.progress) - (a.lap * len + a.progress);
    });
    r.order = order;
    r.playerPos = order.indexOf(r.player) + 1;
  }

  return {
    create: create, update: update, say: say,
    DIFFS: DIFFS, WEATHERS: WEATHERS,
    YAW_RATE: YAW_RATE, CONTACT_LAT: CONTACT_LAT, CONTACT_Z: CONTACT_Z,
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = Race; }
