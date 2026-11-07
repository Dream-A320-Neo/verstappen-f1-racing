/* =====================================================================
 * 04-gl3d.js —— 原生 WebGL 1.0 渲染器
 * 世界几何：路面 / 3D 路肩 / 缓冲区 / 草地 / 护栏 / 起跑线 / 维修区挡墙
 * 车辆几何：程序化拼装的 RB19 风格车模（鼻锥/车身/进气口/Halo/双翼/四轮）
 * 相机：第三人称刚性跟随（位置与视线都用车身真实航向，零滞后）/ 车手视角
 * ===================================================================== */
'use strict';

var GL3D = (function () {
  var gl = null, canvas = null;
  var prog = null, loc = {};
  var worldMeshes = [];   // 世界按块切分，避免单网格顶点数超过 Uint16 索引上限
  var carCache = {};
  var state = { camera: 'chase', camPos: [0, 0, 0], camInit: false };

  // ---------- 矩阵工具（列主序，m[15]=1）----------
  var m4 = {
    identity: function () { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; },
    multiply: function (out, a, b) {
      for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
        out[i * 4 + j] = a[0 * 4 + j] * b[i * 4 + 0] + a[1 * 4 + j] * b[i * 4 + 1] + a[2 * 4 + j] * b[i * 4 + 2] + a[3 * 4 + j] * b[i * 4 + 3];
      }
      return out;
    },
    compose: function (o, x, y, z, yaw, roll, pitch, sx, sy, sz) {
      var cy = Math.cos(yaw), sy_ = Math.sin(yaw), cr = Math.cos(roll || 0), sr = Math.sin(roll || 0);
      var cp = Math.cos(pitch || 0), sp = Math.sin(pitch || 0);
      sx = sx || 1; sy = sy || 1; sz = sz || 1;
      o[0] = (cy * cr + sy_ * sp * sr) * sx; o[1] = (sr * cp) * sx; o[2] = (-sy_ * cr + cy * sp * sr) * sx; o[3] = 0;
      o[4] = (-cy * sr + sy_ * sp * cr) * sy; o[5] = (cr * cp) * sy; o[6] = (sy_ * sr + cy * sp * cr) * sy; o[7] = 0;
      o[8] = (sy_ * cp) * sz; o[9] = (-sp) * sz; o[10] = (cy * cp) * sz; o[11] = 0;
      o[12] = x; o[13] = y; o[14] = z; o[15] = 1;
      return o;
    },
    perspective: function (o, fovy, aspect, near, far) {
      var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0;
      o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0;
      o[8] = 0; o[9] = 0; o[10] = (far + near) * nf; o[11] = -1;
      o[12] = 0; o[13] = 0; o[14] = 2 * far * near * nf; o[15] = 0;
      return o;
    },
    lookAt: function (o, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
      var zx = ex - cx, zy = ey - cy, zz = ez - cz;
      var zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
      var xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
      var xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
      var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
      o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
      o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
      o[12] = -(xx * ex + xy * ey + xz * ez);
      o[13] = -(yx * ex + yy * ey + yz * ez);
      o[14] = -(zx * ex + zy * ey + zz * ez);
      o[15] = 1;
      return o;
    },
  };

  // ---------- 网格构建器 ----------
  function Builder() {
    var pos = [], nrm = [], col = [], idx = [], base = 0;
    function pushQuadN(a, b, c, d, color, nx, ny, nz) {
      [a, b, c, d].forEach(function (p) { pos.push(p[0], p[1], p[2]); nrm.push(nx, ny, nz); col.push(color[0], color[1], color[2]); });
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3); base += 4;
    }
    function pushTri(a, b, c, color) {
      [a, b, c].forEach(function (p) { pos.push(p[0], p[1], p[2]); nrm.push(0, 1, 0); col.push(color[0], color[1], color[2]); });
      idx.push(base, base + 1, base + 2); base += 3;
    }
    var api = {
      box: function (cx, cy, cz, sx, sy, sz, color) {
        var hx = sx / 2, hy = sy / 2, hz = sz / 2;
        var p = function (dx, dy, dz) { return [cx + dx * hx, cy + dy * hy, cz + dz * hz]; };
        var C = color;
        // 6 个面（外法线朝外，逆时针）
        pushQuadN(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), C, 0, 0, 1);
        pushQuadN(p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1), C, 0, 0, -1);
        pushQuadN(p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), C, 1, 0, 0);
        pushQuadN(p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1), C, -1, 0, 0);
        pushQuadN(p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1), C, 0, 1, 0);
        pushQuadN(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), C, 0, -1, 0);
        return api;
      },
      quadUp: function (a, b, c, d, color) {
        var ux = b[0] - a[0], uz = b[2] - a[2], vx = d[0] - a[0], vz = d[2] - a[2];
        var ny = uz * vx - ux * vz;
        if (ny >= 0) pushQuadN(a, b, c, d, color, 0, 1, 0); else pushQuadN(d, c, b, a, color, 0, 1, 0);
        return api;
      },
      quad: function (a, b, c, d, color) {
        var nx = (b[0] - a[0]) || 0.001, ny = b[1] - a[1], nz = b[2] - a[2];
        var l = Math.hypot(nx, ny, nz) || 1;
        pushQuadN(a, b, c, d, color, nx / l, ny / l, nz / l);
        return api;
      },
      tri: function (a, b, c, color) { pushTri(a, b, c, color); return api; },
      upload: function () {
        if (!pos.length) return null;
        var vb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        var data = new Float32Array(pos.length + nrm.length + col.length);
        var N = pos.length / 3;
        for (var i = 0; i < N; i++) {
          data[i * 9 + 0] = pos[i * 3]; data[i * 9 + 1] = pos[i * 3 + 1]; data[i * 9 + 2] = pos[i * 3 + 2];
          data[i * 9 + 3] = nrm[i * 3]; data[i * 9 + 4] = nrm[i * 3 + 1]; data[i * 9 + 5] = nrm[i * 3 + 2];
          data[i * 9 + 6] = col[i * 3]; data[i * 9 + 7] = col[i * 3 + 1]; data[i * 9 + 8] = col[i * 3 + 2];
        }
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        var ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
        return { vb: vb, ib: ib, count: idx.length };
      },
    };
    return api;
  }

  // ---------- 初始化 ----------
  function init(cv) {
    canvas = cv;
    gl = canvas.getContext('webgl', { antialias: true, alpha: false })
      || canvas.getContext('experimental-webgl', { antialias: true });
    if (!gl) return false;
    var vs = [
      'attribute vec3 aPos; attribute vec3 aNrm; attribute vec3 aCol;',
      'uniform mat4 uVP; uniform mat4 uModel;',
      'varying vec3 vN; varying vec3 vC; varying float vFog;',
      'void main(){',
      '  vec4 wp = uModel * vec4(aPos,1.0);',
      '  vN = mat3(uModel) * aNrm;',
      '  vC = aCol;',
      '  vec4 cp = uVP * wp;',
      '  vFog = clamp((cp.w - 120.0) / 620.0, 0.0, 1.0);',
      '  gl_Position = cp;',
      '}',
    ].join('\n');
    var fs = [
      'precision mediump float;',
      'uniform vec3 uLight; uniform vec3 uFogCol;',
      'varying vec3 vN; varying vec3 vC; varying float vFog;',
      'void main(){',
      '  vec3 n = normalize(vN);',
      '  float d = max(dot(n, uLight), 0.0);',
      '  float amb = 0.55;',
      '  vec3 c = vC * (amb + 0.55 * d);',
      '  c = mix(c, uFogCol, vFog * 0.85);',
      '  gl_FragColor = vec4(c, 1.0);',
      '}',
    ].join('\n');
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    }
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    loc.aPos = gl.getAttribLocation(prog, 'aPos');
    loc.aNrm = gl.getAttribLocation(prog, 'aNrm');
    loc.aCol = gl.getAttribLocation(prog, 'aCol');
    loc.uVP = gl.getUniformLocation(prog, 'uVP');
    loc.uModel = gl.getUniformLocation(prog, 'uModel');
    loc.uLight = gl.getUniformLocation(prog, 'uLight');
    loc.uFogCol = gl.getUniformLocation(prog, 'uFogCol');
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.62, 0.74, 0.86, 1);
    return true;
  }

  function available() { return !!gl; }

  // ---------- 世界几何 ----------
  function buildWorld(track) {
    if (!gl) return null;          // 无 WebGL 上下文时安全退出（页面会有明确提示）
    var b = Builder();
    var n = track.count;
    var RH = Track.ROAD_HALF, CW = Track.CURB_W, RU = Track.RUNOFF_MAX, WH = Track.WALL_H;
    var grass = Util.hex2rgb('#3f7a3a'), road = Util.hex2rgb('#4a4d52'), runoff = Util.hex2rgb('#9a8f76');
    var kerbA = Util.hex2rgb('#e8e8e8'), kerbB = Util.hex2rgb('#d81f26'), wallC = Util.hex2rgb('#cfd6de');
    var lineC = Util.hex2rgb('#e8edf5');

    for (var i = 0; i < n; i++) {
      var a = track.segments[i], c = track.segments[(i + 1) % n];
      var gy = a.y - 0.05;
      // 用局部法向
      var n0x = -Math.cos(a.h), n0z = Math.sin(a.h);
      var n1x = -Math.cos(c.h), n1z = Math.sin(c.h);
      function P(seg, nx, nz, off, y) { return [seg.x + nx * off, y, seg.z + nz * off]; }
      // 草地
      b.quadUp(P(a, n0x, n0z, -(RU + 80), gy), P(c, n1x, n1z, -(RU + 80), gy), P(c, n1x, n1z, 0, gy), P(a, n0x, n0z, 0, gy), grass);
      b.quadUp(P(a, n0x, n0z, 0, gy), P(c, n1x, n1z, 0, gy), P(c, n1x, n1z, RU + 80, gy), P(a, n0x, n0z, RU + 80, gy), grass);
      // 缓冲区
      b.quadUp(P(a, n0x, n0z, -(RU), a.y + 0.02), P(c, n1x, n1z, -(RU), c.y + 0.02), P(c, n1x, n1z, -(RH + CW), c.y + 0.02), P(a, n0x, n0z, -(RH + CW), a.y + 0.02), runoff);
      b.quadUp(P(a, n0x, n0z, RH + CW, a.y + 0.02), P(c, n1x, n1z, RH + CW, c.y + 0.02), P(c, n1x, n1z, RU, c.y + 0.02), P(a, n0x, n0z, RU, a.y + 0.02), runoff);
      // 路面
      b.quadUp(P(a, n0x, n0z, -RH, a.y + 0.05), P(c, n1x, n1z, -RH, c.y + 0.05), P(c, n1x, n1z, RH, c.y + 0.05), P(a, n0x, n0z, RH, a.y + 0.05), road);
      // 边线
      b.quadUp(P(a, n0x, n0z, -RH, a.y + 0.06), P(c, n1x, n1z, -RH, c.y + 0.06), P(c, n1x, n1z, -RH + 0.5, c.y + 0.06), P(a, n0x, n0z, -RH + 0.5, a.y + 0.06), lineC);
      b.quadUp(P(a, n0x, n0z, RH - 0.5, a.y + 0.06), P(c, n1x, n1z, RH - 0.5, c.y + 0.06), P(c, n1x, n1z, RH, c.y + 0.06), P(a, n0x, n0z, RH, a.y + 0.06), lineC);
      // 3D 路肩：块状（每段两端缩进 1.5%，留约 9cm 接缝）
      if (a.curb) {
        var kc = (Math.floor(i / 2) % 2 === 0) ? kerbA : kerbB;
        [-1, 1].forEach(function (sd) {
          var in0 = 0.015, in1 = 0.985;
          var mixp = function (seg0, seg1, nx, nz, off, y, k) {
            return [Util.lerp(seg0.x, seg1.x, k) + nx * off * sd, Util.lerp(seg0.y, seg1.y, k) + y, Util.lerp(seg0.z, seg1.z, k) + nz * off * sd];
          };
          var ka = mixp(a, c, n0x, n0z, RH + CW, 0.14, in0), kb = mixp(a, c, n0x, n0z, RH + CW, 0.14, in1);
          var kc2 = mixp(a, c, n1x, n1z, RH + CW, 0.14, in0), kd = mixp(a, c, n1x, n1z, RH + CW, 0.14, in1);
          var ia = mixp(a, c, n0x, n0z, RH, 0.14, in0), ib2 = mixp(a, c, n1x, n1z, RH, 0.14, in0);
          var ia2 = mixp(a, c, n0x, n0z, RH, 0.14, in1), ib3 = mixp(a, c, n1x, n1z, RH, 0.14, in1);
          b.quadUp(ia2, ib3, kd, kc2, kc);
          b.quad([ia[0], a.y + 0.02, ia[2]], [kb[0], c.y + 0.02, kb[2]], [kc2[0], a.y + 0.14, kc2[2]], ia2, Util.shade(kc, 0.8));
        });
      }
      // 护栏（两侧，高 0.95m）
      [-1, 1].forEach(function (sd) {
        var off = (RH + CW + RU) * sd;
        var p0 = P(a, n0x, n0z, off, a.y), p1 = P(c, n1x, n1z, off, c.y);
        var C = (Math.floor(i / 8) % 2 === 0) ? wallC : Util.shade(wallC, 0.86);
        b.quad([p0[0], p0[1], p0[2]], [p1[0], p1[1], p1[2]], [p1[0], p1[1] + WH, p1[2]], [p0[0], p0[1] + WH, p0[2]], C);
        b.quad([p1[0], p1[1], p1[2]], [p0[0], p0[1], p0[2]], [p0[0], p0[1] + WH, p0[2]], [p1[0], p1[1] + WH, p1[2]], Util.shade(C, 0.75));
      });
    }
    // 起跑线（方格）
    var s0 = track.segments[0];
    for (var r = 0; r < 2; r++) for (var q = -9; q < 9; q += 2) {
      var C = (r + q) % 2 === 0 ? lineC : Util.hex2rgb('#1a1d22');
      var x0 = s0.x + (-Math.cos(s0.h)) * q, z0 = s0.z + Math.sin(s0.h) * q;
      b.quadUp([x0, s0.y + 0.07, z0], [x0 + Math.sin(s0.h) * 2, s0.y + 0.07, z0 + Math.cos(s0.h) * 2],
        [x0 + Math.sin(s0.h) * 2 - Math.cos(s0.h) * 1, s0.y + 0.07, z0 + Math.cos(s0.h) * 2 + Math.sin(s0.h) * 1],
        [x0 - Math.cos(s0.h) * 1, s0.y + 0.07, z0 + Math.sin(s0.h) * 1], C);
    }
    // 维修区挡墙（覆盖整个让位范围，防止"护栏断开"）
    var pit = track.pitZone;
    if (pit) {
      var pz = Util.hex2rgb('#d8dee6');
      for (var pi = pit.start - 8; pi <= pit.end + 8; pi++) {
        var idx = (pi + track.count) % track.count;
        var pa = track.segments[idx], pb = track.segments[(idx + 1) % track.count];
        var side = pit.side;
        var nax = -Math.cos(pa.h) * side, naz = Math.sin(pa.h) * side;
        var o0 = [pa.x + nax * (RH + CW + 8), pa.y, pa.z + naz * (RH + CW + 8)];
        var o1 = [pb.x + nax * (RH + CW + 8), pb.y, pb.z + naz * (RH + CW + 8)];
        b.quad(o0, o1, [o1[0], o1[1] + 1.1, o1[2]], [o0[0], o0[1] + 1.1, o0[2]], pz);
      }
    }
    /* ---------- 观众看台 ----------
     * 每隔若干段在赛道外侧放一座：阶梯看台 + 顶棚 + 观众色块。
     * 位置取该段的外侧法向，高度贴该段地面。 */
    var STAND_SPACING = 46;          // 每 46 段（约 138 米）一座
    var STAND_COLORS = [
      Util.hex2rgb('#1d2a44'), Util.hex2rgb('#8a1620'), Util.hex2rgb('#243b2e'),
      Util.hex2rgb('#3a2a4a'), Util.hex2rgb('#4a3418'),
    ];
    var crowdPalette = [Util.hex2rgb('#e8c547'), Util.hex2rgb('#d94f4f'), Util.hex2rgb('#5aa0e0'),
                        Util.hex2rgb('#e8e8e8'), Util.hex2rgb('#7ac47a'), Util.hex2rgb('#d97ac4')];
    var roof = Util.hex2rgb('#c8d0da');
    for (var si = 0; si < n; si += STAND_SPACING) {
      var seg0 = track.segments[si];
      var side = Math.abs(seg0.curve) > 0.004 ? 1 : -1;      // 弯道外侧
      var snx = -Math.cos(seg0.h) * side, snz = Math.sin(seg0.h) * side;
      var baseOff = RH + CW + RU + 14;
      var bx = seg0.x + snx * baseOff, bz = seg0.z + snz * baseOff;
      var by = seg0.y;
      var standCol = STAND_COLORS[Math.floor(si / STAND_SPACING) % STAND_COLORS.length];
      // 5 级阶梯看台（每级后退 2.2 米、抬高 1.1 米）
      for (var tier = 0; tier < 5; tier++) {
        var tOff = baseOff + tier * 2.2;
        var tx = seg0.x + snx * tOff, tz = seg0.z + snz * tOff;
        var ty = by + tier * 1.1;
        // 台阶本体
        b.box(tx, ty + 0.55, tz, 26, 1.1, 2.2, standCol);
        // 观众（每级 6 个色块）
        for (var ci2 = 0; ci2 < 6; ci2++) {
          var ccx = tx - Math.cos(seg0.h) * 10 + Math.cos(seg0.h) * ci2 * 4;
          var ccz = tz + Math.sin(seg0.h) * 10 - Math.sin(seg0.h) * ci2 * 4;
          b.box(ccx, ty + 1.35, ccz, 2.4, 1.0, 1.2, crowdPalette[(ci2 + tier) % crowdPalette.length]);
        }
      }
      // 顶棚（最后一级上方）
      var rOff = baseOff + 4 * 2.2;
      var rx = seg0.x + snx * rOff, rz = seg0.z + snz * rOff;
      b.box(rx, by + 8.2, rz, 30, 0.5, 15, roof);
      // 支撑柱
      [-1, 1].forEach(function (sd) {
        var px2 = seg0.x + snx * (rOff - 6) + Math.cos(seg0.h) * sd * 12;
        var pz2 = seg0.z + snz * (rOff - 6) - Math.sin(seg0.h) * sd * 12;
        b.box(px2, by + 4.2, pz2, 0.8, 8.4, 0.8, roof);
      });
    }

    worldMesh = b.upload();
    return worldMesh;
  }

  // ---------- 车模（RB19 风格，程序化拼装）----------
  function buildCar(driver) {
    var key = driver.id;
    if (carCache[key]) return carCache[key];
    var b = Builder();
    var body = Util.hex2rgb(driver.color), acc = Util.hex2rgb(driver.accent), carbon = Util.hex2rgb('#15181d');
    var helm = Util.hex2rgb('#ffd700'), black = Util.hex2rgb('#0a0c10');
    // 车身主段（后宽前窄）
    b.box(0, 0.36, -0.95, 0.62, 0.30, 1.9, body);      // 侧箱区
    b.box(0, 0.40, 0.35, 0.42, 0.26, 1.5, body);       // 座舱后段
    b.box(0, 0.30, 1.55, 0.26, 0.20, 1.1, body);       // 鼻锥
    b.box(0, 0.20, 2.15, 0.18, 0.14, 0.5, body);       // 鼻尖
    // 进气口：朝前开的深色开口 + 车身色封口（后方只看得到管道外形）
    b.box(0, 0.62, -0.95, 0.24, 0.22, 1.4, body);      // 引擎盖
    b.box(0, 0.60, 0.12, 0.20, 0.16, 0.16, black);     // 前进气口（朝前）
    b.box(0, 0.55, -1.66, 0.20, 0.18, 0.12, body);     // 后端封口（车身色）
    // Halo：前段水平（与地面平行）+ 后段下降，单根中央支柱
    b.box(0, 0.80, 0.42, 0.42, 0.035, 0.035, carbon);
    b.box(0.20, 0.76, 0.05, 0.035, 0.035, 0.78, carbon);
    b.box(-0.20, 0.76, 0.05, 0.035, 0.035, 0.78, carbon);
    b.box(0, 0.72, 0.78, 0.030, 0.22, 0.030, carbon);
    // 头盔 + 座舱
    b.box(0, 0.76, 0.30, 0.22, 0.20, 0.24, helm);
    b.box(0, 0.62, 0.16, 0.34, 0.10, 0.62, carbon);
    // 前翼：三层翼片 + 端板（红色）
    [0.10, 0.20, 0.30].forEach(function (h, i) {
      b.box(0, h, 2.35 - i * 0.10, 1.95 - i * 0.1, 0.035, 0.34, acc);
    });
    [-1, 1].forEach(function (sd) {
      b.box(sd * 1.0, 0.22, 2.30, 0.035, 0.28, 0.52, acc);
    });
    // 尾翼：主翼 + DRS + 端板 + 梁翼
    b.box(0, 0.90, -1.92, 1.05, 0.045, 0.34, acc);
    b.box(0, 0.79, -2.18, 1.00, 0.038, 0.22, acc);
    [-1, 1].forEach(function (sd) {
      b.box(sd * 0.95, 0.72, -2.02, 0.035, 0.62, 0.72, acc);
    });
    b.box(0, 0.42, -2.30, 0.92, 0.035, 0.22, carbon);
    b.box(0, 0.30, -2.42, 0.82, 0.030, 0.18, carbon);
    // 底板 + 扩散器
    b.box(0, 0.10, -0.15, 1.30, 0.06, 4.0, carbon);
    b.box(0, 0.24, -2.10, 0.68, 0.26, 0.44, black);
    // 侧箱进气口（贴着车身，不飘在外面）
    [-1, 1].forEach(function (sd) {
      b.box(sd * 0.27, 0.40, 0.55, 0.10, 0.16, 0.20, black);
    });
    // 轮胎：四个轮组（胎面 + 配方色侧壁）
    var comp = Cars.compounds[driver.compound || 'medium'] || Cars.compounds.medium;
    var ring = Util.hex2rgb(comp.ring);
    var wheel = Builder();
    // 轮胎主体：细长环（用 8 段近似圆柱）
    var SEG = 10, R = 0.36, W = 0.24;
    for (var k = 0; k < SEG; k++) {
      var a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
      var p0 = [Math.cos(a0) * R, Math.sin(a0) * R, -W / 2], p1 = [Math.cos(a1) * R, Math.sin(a1) * R, -W / 2];
      var p2 = [Math.cos(a1) * R, Math.sin(a1) * R, W / 2], p3 = [Math.cos(a0) * R, Math.sin(a0) * R, W / 2];
      wheel.quad(p0, p1, p2, p3, black);
      // 侧壁色环
      wheel.quad(p0, p1, [p1[0] * 0.96, p1[1] * 0.96, W / 2 + 0.01], [p0[0] * 0.96, p0[1] * 0.96, W / 2 + 0.01], ring);
    }
    var wheelMesh = wheel.upload();
    var chassis = b.upload();
    var car = { chassis: chassis, wheel: wheelMesh };
    carCache[key] = car;
    return car;
  }

  // ---------- 绘制 ----------
  var vp = new Float32Array(16), model = new Float32Array(16), proj = new Float32Array(16), view = new Float32Array(16);

  function bindMesh(mesh, mtx) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vb);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 36, 0);
    gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 36, 12);
    gl.vertexAttribPointer(loc.aCol, 3, gl.FLOAT, false, 36, 24);
    gl.enableVertexAttribArray(loc.aPos);
    gl.enableVertexAttribArray(loc.aNrm);
    gl.enableVertexAttribArray(loc.aCol);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib);
    gl.uniformMatrix4fv(loc.uModel, false, mtx);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  function resize() {
    if (!gl) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw(race, dt) {
    if (!gl || !worldMeshes.length) return;   // 没有 WebGL 就不画 3D，HUD 仍可用
    resize();
    var p = race.player, track = race.track;
    var smp = Track.sample3d(track, p.z, {});
    var px = smp.x + smp.nx * p.offset, pz = smp.z + smp.nz * p.offset, py = smp.y;
    var yaw = p.heading;
    var cockpit = state.camera === 'cockpit';

    var eye, target;
    if (cockpit) {
      var fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
      eye = [px + fx * 0.2 + rx * 0.18, py + 1.02, pz + fz * 0.2 + rz * 0.18];
      target = [px + fx * 30, py + 0.95, pz + fz * 30];
    } else {
      var back = 6.2, up = 2.05;
      // 刚性跟随：位置与视线都用车身真实航向（不插值 → 零滞后）
      eye = [px - Math.sin(yaw) * back, py + up, pz - Math.cos(yaw) * back];
      target = [px + Math.sin(yaw) * 14, py + 1.1, pz + Math.cos(yaw) * 14];
    }

    var fov = cockpit ? 76 : 68;
    m4.perspective(proj, fov * Math.PI / 180, canvas.width / Math.max(1, canvas.height), 0.5, 900);
    m4.lookAt(view, eye[0], eye[1], eye[2], target[0], target[1], target[2], 0, 1, 0);
    m4.multiply(vp, proj, view);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(loc.uVP, false, vp);
    var sun = [0.45, 0.82, 0.35], l = Math.hypot(sun[0], sun[1], sun[2]);
    gl.uniform3f(loc.uLight, sun[0] / l, sun[1] / l, sun[2] / l);
    gl.uniform3f(loc.uFogCol, 0.70, 0.79, 0.88);

    // 世界
    m4.identity(model);
    bindMesh(worldMesh, model);

    // 车辆
    var me = p;
    for (var i = 0; i < race.cars.length; i++) {
      var c = race.cars[i];
      if (c === me && cockpit) continue;         // 车手视角隐藏自己的车
      var s = Track.sample3d(track, c.z, {});
      var wx = s.x + s.nx * c.offset, wz = s.z + s.nz * c.offset, wy = s.y + 0.02;
      var car = buildCar(c);
      m4.compose(model, wx, wy, wz, c.heading, c.roll || 0, c.pitch || 0, 1, 1, 1);
      bindMesh(car.chassis, model);
      // 四轮
      var wb = 1.78, tw = 0.78;
      [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(function (q) {
        var lx = q[0] * tw, lz = q[1] * wb;
        var cw = Math.cos(c.heading), sw = Math.sin(c.heading);
        var ox = lx * cw - lz * sw, oz = -lx * sw - lz * cw;
        m4.compose(model, wx + ox, wy + 0.36, wz + oz, c.heading, 0, 0, 1, 1, 1);
        bindMesh(car.wheel, model);
      });
    }
  }

  return {
    init: init, available: available, buildWorld: buildWorld, buildCar: buildCar, draw: draw, m4: m4,
    state: state,
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = GL3D; }
