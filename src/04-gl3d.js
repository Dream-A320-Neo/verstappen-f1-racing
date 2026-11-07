/* =====================================================================
 * 04-render2d.js —— Canvas2D 伪 3D 渲染器（不依赖 WebGL）
 *
 * 原理：把前方若干段赛道的左右边缘透视投影到屏幕上，由远到近画梯形，
 * 就是经典的「伪 3D 赛车」画法。任何支持 Canvas 2D 的浏览器都能跑，
 * 包括关掉 GPU 加速 / 远程桌面 / 老显卡的环境。
 *
 * 对外 API 与原来的 WebGL 版本保持一致（init/available/buildWorld/
 * buildCar/draw/state），因此 06-game.js 不需要改动。
 * ===================================================================== */
'use strict';

var GL3D = (function () {
  var canvas = null, ctx = null;
  var W = 0, H = 0, dpr = 1;
  var state = { camera: 'chase', track: null };
  var FOCAL = 460;            // 焦距（像素）
  var CAM_H_CHASE = 3.2;      // 追尾视角相机高度（米）
  var CAM_H_COCKPIT = 0.72;   // 车手视角相机高度（米）
  var CAM_BACK = 7.5;         // 追尾视角相机在车后的距离（米）
  var RENDER_SEGS = 110;      // 最多绘制多少段

  function init(cv) {
    canvas = cv;
    ctx = canvas.getContext('2d');
    if (!ctx) return false;
    resize();
    return true;
  }
  function available() { return !!ctx; }

  function resize() {
    if (!ctx) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    W = canvas.width; H = canvas.height;
  }

  // 2D 渲染不需要预烘焙几何
  function buildWorld(track) { state.track = track; return true; }
  function buildCar() { return true; }

  // 世界点 → 屏幕点。返回 null 表示在相机后面
  function project(camX, camZ, camY, yaw, wx, wz, wy) {
    var dx = wx - camX, dz = wz - camZ;
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var fwd = dx * sy + dz * cy;           // 前方距离
    if (fwd < 0.9) return null;
    var right = -dx * cy + dz * sy;        // 右侧距离
    var scale = FOCAL / fwd;
    return {
      x: W / 2 + right * scale,
      y: H * 0.46 + (camY - (wy || 0)) * scale,
      s: scale,
      fwd: fwd,
    };
  }

  function poly(pts, color) {
    if (!pts || !pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  var GRASS = '#3f7a3a', GRASS2 = '#3a7235';
  var RUNOFF = '#8f8570', RUNOFF2 = '#877e6b';
  var ROAD = '#4a4d52', ROAD2 = '#46494e';
  var LINE = '#dfe6ee';
  var KERB_A = '#e8e8e8', KERB_B = '#d81f26';

  function draw(race) {
    if (!ctx) return;
    resize();
    var p = race.player, track = race.track;
    var smp = Track.sample3d(track, p.z, {});
    var px = smp.x + smp.nx * p.offset, pz = smp.z + smp.nz * p.offset, py = smp.y;
    var yaw = p.heading;
    var cockpit = state.camera === 'cockpit';

    // 相机：追尾视角在车后上方；车手视角在座舱高度
    var camDist = cockpit ? 0.2 : CAM_BACK;
    var camH = cockpit ? CAM_H_COCKPIT : CAM_H_CHASE;
    var camX = px - Math.sin(yaw) * camDist;
    var camZ = pz - Math.cos(yaw) * camDist;
    var camY = py + camH;

    // 天空 + 地平线
    var horizon = H * 0.46;
    var skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
    skyGrad.addColorStop(0, '#2b4a72');
    skyGrad.addColorStop(0.65, '#7fa6c9');
    skyGrad.addColorStop(1, '#d8b38a');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, horizon + 2);

    // 由远到近绘制路面（画家算法）
    var baseIdx = smp.i;
    var layers = [];
    for (var k = RENDER_SEGS; k >= 0; k--) {
      var seg = track.segments[(baseIdx + k) % track.count];
      var s0 = Track.sample3d(track, p.z + k * Track.SEG_LEN, {});
      var s1 = Track.sample3d(track, p.z + (k + 1) * Track.SEG_LEN, {});
      var n0x = s0.nx, n0z = s0.nz;
      var n1x = s1.nx, n1z = s1.nz;
      var RH = Track.ROAD_HALF, CW = Track.CURB_W, RU = Track.RUNOFF_MAX;
      function P(smp2, nx, nz, off, yAdd) {
        return project(camX, camZ, camY, yaw, smp2.x + nx * off, smp2.z + nz * off, smp2.y + (yAdd || 0));
      }
      var near = {
        ruL: P(s0, n0x, n0z, -(RU)), ruR: P(s0, n0x, n0z, RU),
        rdL: P(s0, n0x, n0z, -RH), rdR: P(s0, n0x, n0z, RH),
        cbL0: P(s0, n0x, n0z, -RH), cbL1: P(s0, n0x, n0z, -(RH + CW)),
        cbR0: P(s0, n0x, n0z, RH), cbR1: P(s0, n0x, n0z, RH + CW),
        lnL0: P(s0, n0x, n0z, -RH), lnL1: P(s0, n0x, n0z, -RH + 0.4),
        lnR0: P(s0, n0x, n0z, RH - 0.4), lnR1: P(s0, n0x, n0z, RH),
      };
      var far = {
        ruL: P(s1, n1x, n1z, -(RU)), ruR: P(s1, n1x, n1z, RU),
        rdL: P(s1, n1x, n1z, -RH), rdR: P(s1, n1x, n1z, RH),
        cbL0: P(s1, n1x, n1z, -RH), cbL1: P(s1, n1x, n1z, -(RH + CW)),
        cbR0: P(s1, n1x, n1z, RH), cbR1: P(s1, n1x, n1z, RH + CW),
        lnL0: P(s1, n1x, n1z, -RH), lnL1: P(s1, n1x, n1z, -RH + 0.4),
        lnR0: P(s1, n1x, n1z, RH - 0.4), lnR1: P(s1, n1x, n1z, RH),
      };
      layers.push({ k: k, seg: seg, near: near, far: far });
    }

    for (var li = 0; li < layers.length; li++) {
      var L = layers[li], n = L.near, f = L.far, seg = L.seg;
      if (!n.ruL || !n.ruR || !f.ruL || !f.ruR) continue;
      var dark = (Math.floor(L.k / 4) % 2 === 0);
      // 草地（整屏宽度到地平线）
      ctx.fillStyle = dark ? GRASS : GRASS2;
      ctx.fillRect(0, f.ruL.y, W, Math.max(1, n.ruL.y - f.ruL.y) + 1);
      // 缓冲区
      poly([n.ruL, n.ruR, f.ruR, f.ruL], dark ? RUNOFF : RUNOFF2);
      // 路肩（红白块，按段交替）
      if (seg.curb && n.cbL0 && n.cbL1 && f.cbL0 && f.cbL1) {
        var kc = (Math.floor(L.k / 2) % 2 === 0) ? KERB_A : KERB_B;
        poly([n.cbL0, n.cbL1, f.cbL1, f.cbL0], kc);
        poly([n.cbR0, n.cbR1, f.cbR1, f.cbR0], kc);
      }
      // 路面
      poly([n.rdL, n.rdR, f.rdR, f.rdL], dark ? ROAD : ROAD2);
      // 边线
      if (n.lnL0 && n.lnL1 && f.lnL0 && f.lnL1) {
        poly([n.lnL0, n.lnL1, f.lnL1, f.lnL0], LINE);
        poly([n.lnR0, n.lnR1, f.lnR1, f.lnR0], LINE);
      }
    }

    // 起跑线（接近时画一条白线）
    var sStart = Track.sample3d(track, 0, {});
    var dStart = Util.wrapDelta(p.z, 0, track.trackLength);
    if (Math.abs(dStart) < 40) {
      var a0 = project(camX, camZ, camY, yaw, sStart.x + sStart.nx * -Track.ROAD_HALF, sStart.z + sStart.nz * -Track.ROAD_HALF, sStart.y);
      var a1 = project(camX, camZ, camY, yaw, sStart.x + sStart.nx * Track.ROAD_HALF, sStart.z + sStart.nz * Track.ROAD_HALF, sStart.y);
      if (a0 && a1) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, a0.s * 0.5);
        ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.stroke();
      }
    }

    // 其他车辆：按相对位置投影成车身矩形（远小近大）
    for (var ci = 0; ci < race.cars.length; ci++) {
      var c = race.cars[ci];
      if (c === p && cockpit) continue;
      var cs = Track.sample3d(track, c.z, {});
      var cwx = cs.x + cs.nx * c.offset, cwz = cs.z + cs.nz * c.offset;
      // 车体朝向：取前/后两个点投影，画一个有纵深的梯形
      var carYaw = c.heading;
      var hw = 1.0, hl = 2.8;
      var corners = [
        [cwx + Math.sin(carYaw) * hl + Math.cos(carYaw) * -hw, cwz + Math.cos(carYaw) * hl - Math.sin(carYaw) * -hw],
        [cwx + Math.sin(carYaw) * hl + Math.cos(carYaw) * hw, cwz + Math.cos(carYaw) * hl - Math.sin(carYaw) * hw],
        [cwx - Math.sin(carYaw) * hl + Math.cos(carYaw) * hw, cwz - Math.cos(carYaw) * hl - Math.sin(carYaw) * hw],
        [cwx - Math.sin(carYaw) * hl + Math.cos(carYaw) * -hw, cwz - Math.cos(carYaw) * hl - Math.sin(carYaw) * hw],
      ];
      var proj = [];
      var ok = true;
      for (var cc = 0; cc < 4; cc++) {
        var q = project(camX, camZ, camY, yaw, corners[cc][0], corners[cc][1], cs.y);
        if (!q) { ok = false; break; }
        proj.push(q);
      }
      if (!ok) continue;
      // 车身
      poly(proj, c.color);
      // 尾翼/前翼用 accent 色描一圈
      ctx.strokeStyle = c.accent || '#e10600';
      ctx.lineWidth = Math.max(1, proj[0].s * 0.12);
      ctx.stroke();
    }

    // 车手视角：画一条 Halo 上沿 + 方向盘暗示
    if (cockpit) {
      ctx.strokeStyle = 'rgba(20,22,26,.85)';
      ctx.lineWidth = Math.max(2, H * 0.012);
      ctx.beginPath();
      ctx.arc(W / 2, H * 0.42, W * 0.30, Math.PI * 0.08, Math.PI * 0.92);
      ctx.stroke();
      ctx.fillStyle = 'rgba(12,14,18,.55)';
      ctx.fillRect(W * 0.42, H * 0.86, W * 0.16, H * 0.10);
    }

    // 速度感：高速时画面下缘压暗 + 轻微抖动
    var spdPct = Util.clamp(p.speed / Cars.MAX_SPEED, 0, 1);
    if (spdPct > 0.5) {
      var vg = ctx.createRadialGradient(W / 2, H * 0.5, H * 0.3, W / 2, H * 0.5, H * 0.9);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,' + (0.20 * (spdPct - 0.5) * 2).toFixed(2) + ')');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }
  }

  return { init: init, available: available, buildWorld: buildWorld, buildCar: buildCar, draw: draw, state: state, version: 'V1.0' };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = GL3D; }
