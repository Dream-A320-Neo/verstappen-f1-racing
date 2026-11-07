/* =====================================================================
 * 01-core.js —— 基础设施：数学工具 / 赛车与轮胎数据 / 赛道生成
 * 世界单位：1 单位 = 1 米（简化坐标，赛道最长约 5.5 km，float32 精度足够）
 * ===================================================================== */
'use strict';

var Util = (function () {
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function saturate(v) { return clamp(v, 0, 1); }
  function smoothstep(a, b, v) { var t = saturate((v - a) / (b - a)); return t * t * (3 - 2 * t); }
  function sign(v) { return v < 0 ? -1 : 1; }
  // 角度差归一化到 [-PI, PI]
  function wrapAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
  function wrapDelta(a, b, len) { var d = a - b; if (len) { while (d > len / 2) d -= len; while (d < -len / 2) d += len; } return d; }

  // 确定性随机数（mulberry32），保证同一 seed 生成同样的赛道
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hex2rgb(hex) {
    var h = String(hex || '#ffffff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  function shade(c, k) { return [saturate(c[0] * k), saturate(c[1] * k), saturate(c[2] * k)]; }
  function mix3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

  // 毫秒 → m:ss.mmm
  function fmtTime(ms) {
    if (ms == null || !isFinite(ms) || ms <= 0) return '--:--.---';
    var total = Math.round(ms);
    var m = Math.floor(total / 60000);
    var s = Math.floor((total % 60000) / 1000);
    var mil = total % 1000;
    return m + ':' + String(s).padStart(2, '0') + '.' + String(mil).padStart(3, '0');
  }
  function fmtGap(ms) {
    if (ms == null || !isFinite(ms)) return '--';
    if (ms <= 0) return 'LEADER';
    return '+' + (ms / 1000).toFixed(3);
  }

  return {
    clamp: clamp, lerp: lerp, saturate: saturate, smoothstep: smoothstep, sign: sign,
    wrapAngle: wrapAngle, wrapDelta: wrapDelta, rng: rng,
    hex2rgb: hex2rgb, shade: shade, mix3: mix3,
    fmtTime: fmtTime, fmtGap: fmtGap,
  };
})();

/* =====================================================================
 * Cars —— 车队 / 车手 / 轮胎配方 / 物理常量
 * ===================================================================== */
var Cars = (function () {
  var MAX_SPEED = 83.3;          // m/s ≈ 300 km/h
  var ACCEL = 11.5;              // m/s²（0-100 约 2.4s）
  var BRAKE = 38;                // m/s²
  var DRAG = 0.00042;            // 二次阻力系数
  var WHEELBASE = 3.6;           // m
  var CAR_LEN = 5.6, CAR_W = 2.0;

  var drivers = [
    { id: 'VER', name: 'VERSTAPPEN', team: 'Red Bull Racing', color: '#123a8f', accent: '#e10600', isPlayer: true },
    { id: 'PER', name: 'PEREZ', team: 'Red Bull Racing', color: '#123a8f', accent: '#e10600' },
    { id: 'HAM', name: 'HAMILTON', team: 'Mercedes', color: '#00d2be', accent: '#000000' },
    { id: 'RUS', name: 'RUSSELL', team: 'Mercedes', color: '#00d2be', accent: '#000000' },
    { id: 'LEC', name: 'LECLERC', team: 'Ferrari', color: '#dc0000', accent: '#ffffff' },
    { id: 'SAI', name: 'SAINZ', team: 'Ferrari', color: '#dc0000', accent: '#ffffff' },
    { id: 'NOR', name: 'NORRIS', team: 'McLaren', color: '#ff8700', accent: '#111111' },
    { id: 'PIA', name: 'PIASTRI', team: 'McLaren', color: '#ff8700', accent: '#111111' },
    { id: 'ALO', name: 'ALONSO', team: 'Aston Martin', color: '#00594f', accent: '#cedc00' },
    { id: 'STR', name: 'STROLL', team: 'Aston Martin', color: '#00594f', accent: '#cedc00' },
    { id: 'GAS', name: 'GASLY', team: 'Alpine', color: '#0090ff', accent: '#ff87bc' },
    { id: 'OCO', name: 'OCON', team: 'Alpine', color: '#0090ff', accent: '#ff87bc' },
    { id: 'ALB', name: 'ALBON', team: 'Williams', color: '#005aff', accent: '#ffffff' },
    { id: 'SAR', name: 'SARGEANT', team: 'Williams', color: '#005aff', accent: '#ffffff' },
    { id: 'TSU', name: 'TSUNODA', team: 'RB', color: '#ffffff', accent: '#e10600' },
    { id: 'RIC', name: 'RICCIARDO', team: 'RB', color: '#ffffff', accent: '#e10600' },
    { id: 'BOT', name: 'BOTTAS', team: 'Kick Sauber', color: '#52e252', accent: '#111111' },
    { id: 'ZHO', name: 'ZHOU', team: 'Kick Sauber', color: '#52e252', accent: '#111111' },
    { id: 'MAG', name: 'MAGNUSSEN', team: 'Haas', color: '#c8c8c8', accent: '#e10600' },
    { id: 'HUL', name: 'HULKENBERG', team: 'Haas', color: '#c8c8c8', accent: '#e10600' },
  ];

  // 五种轮胎配方：抓地系数 / 磨损速率 / 侧壁颜色
  var compounds = {
    soft: { name: '软胎', grip: 1.26, wear: 1.00, color: '#e10600', ring: '#e10600' },
    medium: { name: '中性胎', grip: 1.21, wear: 0.74, color: '#f5c400', ring: '#f5c400' },
    hard: { name: '硬胎', grip: 1.155, wear: 0.52, color: '#dfe6ee', ring: '#dfe6ee' },
    inter: { name: '半雨胎', grip: 1.165, wear: 0.85, color: '#2ecc71', ring: '#2ecc71' },
    wet: { name: '全雨胎', grip: 1.135, wear: 0.70, color: '#3498db', ring: '#3498db' },
  };

  // 干地抓地 = 1.0，湿滑递减
  function trackGrip(weather, wetness) {
    if (weather === 'rain') return Util.lerp(1.0, 0.62, Util.saturate(wetness));
    if (weather === 'wet') return 0.78;
    return 1.0;
  }

  // 综合抓地 = 轮胎 × 路面 × 磨损
  function tyreGrip(car, trackG, wetness) {
    var c = compounds[car.compound] || compounds.medium;
    var wearPenalty = 1 - 0.36 * Util.saturate((car.wear - 0.25) / 0.75);
    var g = c.grip * trackG * wearPenalty;
    if (wetness > 0.25 && (car.compound === 'inter' || car.compound === 'wet')) {
      g *= Util.lerp(1.0, 1.22, Util.saturate(wetness));   // 雨胎在湿地有加成
    }
    return Util.clamp(g, 0.55, 1.45);
  }

  function newCar(driver, opts) {
    opts = opts || {};
    return {
      id: driver.id, name: driver.name, team: driver.team,
      color: driver.color, accent: driver.accent, isPlayer: !!driver.isPlayer,
      z: opts.z || 0, offset: opts.offset || 0, heading: opts.heading || 0,
      speed: 0, compound: opts.compound || 'medium', wear: 0,
      gear: 1, ers: 1.0, ersActive: false, damage: 0,
      lap: 1, lapStart: 0, bestLap: null, lastLap: null, finished: false, finishTime: null,
      progress: 0, _accel: 0,
    };
  }

  return {
    MAX_SPEED: MAX_SPEED, ACCEL: ACCEL, BRAKE: BRAKE, DRAG: DRAG,
    WHEELBASE: WHEELBASE, CAR_LEN: CAR_LEN, CAR_W: CAR_W,
    drivers: drivers, compounds: compounds,
    trackGrip: trackGrip, tyreGrip: tyreGrip, newCar: newCar,
  };
})();

/* =====================================================================
 * Track —— 六条赛道的中心线生成
 * 控制点用「米」给出（x, z），Catmull-Rom 样条插值后按 3 米重采样。
 * 每条赛道由这些派生数据组成：
 *   segments[i] = { x, y, z, h(航向), curve(1/米), curb, barrier, index }
 * ===================================================================== */
var Track = (function () {
  var SEG_LEN = 3.0;            // 每段长度（米）
  var ROAD_HALF = 9.0;          // 路面半宽（米）→ 全宽 18 米
  var CURB_W = 1.6;             // 路肩宽
  var RUNOFF_MAX = 22;          // 缓冲区最大宽度
  var WALL_H = 0.95;            // 护栏高度

  // 赛道定义：控制点 + 海拔函数 + 维修区位置
  var PROFILES = [
    {
      id: 'zandvoort', name: '赞德沃特', country: '荷兰', laps: 3,
      // 沙丘赛道：连续的左右交替 + 两个倾斜高速弯
      pts: [[0, 0], [180, -40], [150, -190], [30, -230], [-60, -160], [-40, -40], [-150, 60],
            [-330, 30], [-380, -110], [-290, -230], [-160, -300], [-180, -420], [-60, -480],
            [60, -430], [90, -300], [220, -280], [330, -190], [300, -40], [180, 20]],
      elev: function (t) { return 4.5 * Math.sin(t * Math.PI * 2) + 2.0 * Math.sin(t * Math.PI * 6 + 1.1); },
      pit: { start: 0.62, len: 0.10, side: 1 },
    },
    {
      id: 'sakhir', name: '萨基尔', country: '巴林', laps: 3,
      pts: [[0, 0], [260, 0], [420, -30], [470, -140], [420, -250], [280, -270], [230, -180],
            [120, -200], [20, -260], [-90, -230], [-140, -120], [-80, -20], [-160, 90],
            [-330, 90], [-400, 0], [-340, -140], [-380, -280], [-260, -360], [-120, -330], [-20, -230]],
      elev: function (t) { return 3.0 * Math.sin(t * Math.PI * 4) + 1.2 * Math.sin(t * Math.PI * 9); },
      pit: { start: 0.04, len: 0.08, side: 1 },
    },
    {
      id: 'monaco', name: '蒙特卡洛', country: '摩纳哥', laps: 3,
      pts: [[0, 0], [90, -10], [120, -80], [60, -120], [10, -90], [-10, -140], [40, -190],
            [130, -200], [180, -140], [230, -160], [250, -250], [180, -300], [90, -280],
            [30, -330], [-60, -300], [-100, -220], [-60, -140], [-90, -60], [-40, -10]],
      elev: function (t) { return 6.0 * Math.sin(t * Math.PI * 2 + 0.4) + 1.5 * Math.sin(t * Math.PI * 7); },
      pit: { start: 0.70, len: 0.09, side: 1 },
    },
    {
      id: 'silverstone', name: '银石', country: '英国', laps: 3,
      pts: [[0, 0], [300, -60], [380, -200], [300, -330], [150, -340], [120, -440],
            [250, -520], [420, -480], [480, -330], [560, -180], [480, -40], [300, 40], [140, 20]],
      elev: function (t) { return 2.5 * Math.sin(t * Math.PI * 2) + 1.0 * Math.sin(t * Math.PI * 5 + 2); },
      pit: { start: 0.55, len: 0.10, side: 1 },
    },
    {
      id: 'spa', name: '斯帕-弗朗科尔尚', country: '比利时', laps: 3,
      pts: [[0, 0], [320, 40], [520, -20], [600, -160], [520, -300], [380, -330],
            [300, -430], [340, -560], [480, -620], [620, -560], [640, -400],
            [560, -260], [400, -220], [280, -140], [120, -180], [40, -100]],
      elev: function (t) { return 9.0 * Math.sin(t * Math.PI * 2 + 0.2) + 2.0 * Math.sin(t * Math.PI * 5); },
      pit: { start: 0.10, len: 0.09, side: -1 },
    },
    {
      id: 'yasmarina', name: '亚斯码头', country: '阿联酋', laps: 3,
      pts: [[0, 0], [240, 20], [380, -30], [430, -150], [360, -260], [220, -270], [120, -200],
            [30, -240], [-60, -180], [-40, -60], [-160, 20], [-320, -20], [-380, -150],
            [-300, -270], [-140, -300], [-40, -180]],
      elev: function (t) { return 1.5 * Math.sin(t * Math.PI * 3) + 0.8 * Math.sin(t * Math.PI * 8 + 1); },
      pit: { start: 0.86, len: 0.08, side: -1 },
    },
  ];

  // Catmull-Rom：返回 P1→P2 之间 t 处的点
  function catmull(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
    };
  }

  function build(profile) {
    if (typeof profile === 'string' || typeof profile === 'number') {
      profile = PROFILES.filter(function (p) { return p.id === profile; })[0] || PROFILES[0];
    }
    var pts = profile.pts.map(function (p) { return { x: p[0], z: p[1] }; });
    var n = pts.length;
    // 1) 密集采样样条
    var dense = [];
    var STEPS = 24;
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (var s = 0; s < STEPS; s++) dense.push(catmull(p0, p1, p2, p3, s / STEPS));
    }
    // 2) 按固定弧长重采样
    var cum = [0];
    for (var j = 1; j <= dense.length; j++) {
      var a = dense[j - 1], b = dense[j % dense.length];
      cum.push(cum[j - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    var total = cum[cum.length - 1];
    var count = Math.max(120, Math.round(total / SEG_LEN));
    var step = total / count;
    var cx = [], cz = [];
    var k = 0;
    for (var q = 0; q < count; q++) {
      var target = q * step;
      while (k < cum.length - 2 && cum[k + 1] < target) k++;
      var segLen = cum[k + 1] - cum[k] || 1;
      var f = (target - cum[k]) / segLen;
      cx.push(Util.lerp(dense[k].x, dense[(k + 1) % dense.length].x, f));
      cz.push(Util.lerp(dense[k].z, dense[(k + 1) % dense.length].z, f));
    }
    // 3) 航向 / 曲率 / 海拔
    var segments = [];
    for (var m = 0; m < count; m++) {
      var nx = cx[(m + 1) % count], nz = cz[(m + 1) % count];
      var pvx = cx[m], pvz = cz[m];
      var h = Math.atan2(nx - pvx, nz - pvz);
      segments.push({ index: m, x: pvx, z: pvz, h: h, curve: 0, curb: false, barrier: 'armco', y: 0 });
    }
    for (var r = 0; r < count; r++) {
      var h0 = segments[r].h, h1 = segments[(r + 1) % count].h;
      var dh = Util.wrapAngle(h1 - h0);
      segments[r].curve = dh / step;                    // 1/米，正值=左转
      segments[r].curb = Math.abs(segments[r].curve) > 0.011;
    }
    // 4) 海拔（按周长参数化，保证首尾闭合）
    var y = [];
    for (var e = 0; e < count; e++) y.push(profile.elev(e / count));
    var y0 = y[0], y1 = y[count - 1];
    for (var e2 = 0; e2 < count; e2++) {
      // 线性去趋势，让最后一段平滑接回第一段
      var t = e2 / (count - 1);
      segments[e2].y = y[e2] - (y1 - y0) * t;
    }
    // 5) 维修区
    var pit = profile.pit;
    var pitStart = Math.floor(pit.start * count);
    var pitEnd = Math.min(count - 1, pitStart + Math.floor(pit.len * count));
    var pitZone = { start: pitStart, end: pitEnd, side: pit.side, inner: 1.30, outer: 2.55 };

    // 6) 世界包围盒（小地图用）
    var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (var b = 0; b < count; b++) {
      minX = Math.min(minX, cx[b]); maxX = Math.max(maxX, cx[b]);
      minZ = Math.min(minZ, cz[b]); maxZ = Math.max(maxZ, cz[b]);
    }

    return {
      id: profile.id, name: profile.name, country: profile.country,
      laps: profile.laps || 3,
      segments: segments, count: count, trackLength: count * step, step: step,
      pitZone: pitZone, minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ,
    };
  }

  // 在任意距离 s（米）处采样：位置 / 航向 / 左右法向
  function sample3d(track, s, out) {
    out = out || {};
    var len = track.trackLength;
    var u = ((s % len) + len) % len;
    var fi = u / track.step;
    var i = Math.floor(fi) % track.count;
    var j = (i + 1) % track.count;
    var f = fi - Math.floor(fi);
    var a = track.segments[i], b = track.segments[j];
    var h = a.h + Util.wrapAngle(b.h - a.h) * f;
    out.x = Util.lerp(a.x, b.x, f);
    out.y = Util.lerp(a.y, b.y, f);
    out.z = Util.lerp(a.z, b.z, f);
    out.h = h;
    out.i = i;
    out.curve = Util.lerp(a.curve, b.curve, f);
    out.curb = a.curb;
    out.segment = a;
    // 左右法向：左 = 垂直航向逆时针 90°
    out.nx = -Math.cos(h); out.nz = Math.sin(h);
    return out;
  }

  // 把赛道局部坐标（s, 横向偏移）转成世界坐标
  function toWorld(track, s, offset) {
    var smp = sample3d(track, s, {});
    return { x: smp.x + smp.nx * offset, y: smp.y, z: smp.z + smp.nz * offset, h: smp.h, sample: smp };
  }

  // 某一段的护栏横向位置（考虑缓冲区宽度，按弯道半径收敛）
  function wallOffsetFor(track, seg, side) {
    var radiusOff = Math.abs(seg.curve) > 0.0001 ? (1 / Math.abs(seg.curve)) : 1e9;
    var want = ROAD_HALF + CURB_W + RUNOFF_MAX;
    var capped = Math.min(want, Math.max(ROAD_HALF + CURB_W + 6, radiusOff * 0.9));
    return capped * side;
  }

  return {
    SEG_LEN: SEG_LEN, ROAD_HALF: ROAD_HALF, CURB_W: CURB_W, RUNOFF_MAX: RUNOFF_MAX, WALL_H: WALL_H,
    PROFILES: PROFILES, build: build, sample3d: sample3d, toWorld: toWorld, wallOffsetFor: wallOffsetFor,
    list: function () { return PROFILES.map(function (p) { return { id: p.id, name: p.name, country: p.country }; }); },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Util: Util, Cars: Cars, Track: Track };
}
