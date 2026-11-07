/* =====================================================================
 * 03-hud.js —— DOM HUD：排名 / 排行榜 / 计时 / 速度 / 轮胎 / 小地图 / 消息
 * ===================================================================== */
'use strict';

var HUD = (function () {
  var el = {};
  var boardRows = [];
  var lastMsgKey = '';

  function $(id) { return document.getElementById(id); }

  function init() {
    el.hud = $('hud');
    el.posNow = $('pos-now');
    el.lapLine = $('lap-line');
    el.board = $('board');
    el.bestLap = $('best-lap');
    el.lastLap = $('last-lap');
    el.totalTime = $('total-time');
    el.spd = $('spd');
    el.spdBar = document.querySelector('#spd-bar > i');
    el.gearLine = $('gear-line');
    el.tyreRing = $('tyre-ring');
    el.tyreName = $('tyre-name');
    el.tyreWear = $('tyre-wear');
    el.ers = document.querySelector('#ers > i');
    el.msgs = $('msgs');
    el.minimap = $('minimap');
    el.mmCtx = el.minimap.getContext('2d');
    buildBoard(20);
  }

  function buildBoard(n) {
    el.board.innerHTML = '';
    boardRows = [];
    for (var i = 0; i < n; i++) {
      var row = document.createElement('div');
      row.className = 'bd-row';
      row.innerHTML = '<span class="p"></span><span class="n"></span><span class="g"></span>';
      el.board.appendChild(row);
      boardRows.push(row);
    }
  }

  function show() { el.hud.classList.remove('hidden'); }
  function hide() { el.hud.classList.add('hidden'); }

  function update(r) {
    if (!el.hud || el.hud.classList.contains('hidden')) return;
    var p = r.player;

    // 排名
    el.posNow.innerHTML = 'P<small>' + (r.playerPos || 1) + '</small>';
    el.lapLine.textContent = 'LAP ' + Math.min(p.lap, r.totalLaps) + '/' + (r.mode === 'endless' ? '∞' : r.totalLaps);

    // 计时
    el.bestLap.textContent = Util.fmtTime(p.bestLap);
    el.lastLap.textContent = Util.fmtTime(p.lastLap);
    el.totalTime.textContent = Util.fmtTime(r.time * 1000);

    // 速度 / 挡位
    var kmh = Math.round(p.speed * 3.6);
    el.spd.innerHTML = kmh + '<small>km/h</small>';
    el.spdBar.style.width = Util.clamp(kmh / (Cars.MAX_SPEED * 3.6), 0, 1) * 100 + '%';
    el.gearLine.textContent = '档 ' + (p.gear || 1) + ' · ERS ' + Math.round((p.ers || 0) * 100) + '%';

    // 轮胎
    var comp = Cars.compounds[p.compound] || Cars.compounds.medium;
    el.tyreRing.style.borderColor = comp.ring;
    el.tyreName.textContent = comp.name + ' ' + Math.round((1 - p.wear) * 100) + '%';
    el.tyreWear.style.width = Math.round((1 - p.wear) * 100) + '%';
    el.tyreWear.style.background = p.wear > 0.7 ? '#e10600' : p.wear > 0.45 ? '#f5c400' : '#7ae582';
    el.ers.style.width = Math.round((p.ers || 0) * 100) + '%';

    // 排行榜
    var order = r.order || r.cars;
    var total = Math.min(boardRows.length, order.length);
    var leader = order[0];
    for (var i = 0; i < total; i++) {
      var c = order[i];
      var row = boardRows[i];
      var gap = (i === 0) ? 'LEADER' : '+' + (((c.lap - leader.lap) * r.track.trackLength + (c.progress - leader.progress)) / Math.max(1, leader.speed || 40)).toFixed(3);
      row.children[0].textContent = i + 1;
      row.children[1].textContent = c.name;
      row.children[2].textContent = gap;
      row.classList.toggle('me', c === p);
    }
    for (var j = total; j < boardRows.length; j++) boardRows[j].style.display = 'none';

    // 消息
    var key = r.messages.map(function (m) { return m.text + m.t; }).join('|');
    if (key !== lastMsgKey) {
      lastMsgKey = key;
      el.msgs.innerHTML = r.messages.map(function (m) {
        return '<div class="msg" style="border-left-color:' + m.color + '">' + m.text +
          (m.sub ? '<span class="sub">' + m.sub + '</span>' : '') + '</div>';
      }).join('');
    }

    drawMinimap(r);
  }

  // 小地图：赛道轮廓 + 所有车辆位置
  function drawMinimap(r) {
    var ctx = el.mmCtx, W = el.minimap.width, H = el.minimap.height;
    var t = r.track;
    var pad = 18;
    var sx = (W - pad * 2) / Math.max(1, t.maxX - t.minX);
    var sz = (H - pad * 2) / Math.max(1, t.maxZ - t.minZ);
    var sc = Math.min(sx, sz);
    var ox = pad + ((W - pad * 2) - (t.maxX - t.minX) * sc) / 2;
    var oz = pad + ((H - pad * 2) - (t.maxZ - t.minZ) * sc) / 2;
    function mapX(x) { return ox + (x - t.minX) * sc; }
    function mapZ(z) { return oz + (z - t.minZ) * sc; }

    ctx.clearRect(0, 0, W, H);
    // 赛道线
    ctx.beginPath();
    for (var i = 0; i <= t.count; i += 2) {
      var seg = t.segments[i % t.count];
      var px = mapX(seg.x), pz = mapZ(seg.z);
      if (i === 0) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(220,232,245,.55)';
    ctx.lineWidth = 3.2;
    ctx.stroke();
    // 起点
    var s0 = t.segments[0];
    ctx.fillStyle = '#e10600';
    ctx.beginPath(); ctx.arc(mapX(s0.x), mapZ(s0.z), 3.4, 0, Math.PI * 2); ctx.fill();
    // 车辆
    for (var k = 0; k < r.cars.length; k++) {
      var c = r.cars[k];
      var smp = Track.sample3d(t, c.z, {});
      var cx2 = mapX(smp.x + smp.nx * c.offset);
      var cz2 = mapZ(smp.z + smp.nz * c.offset);
      ctx.beginPath();
      ctx.arc(cx2, cz2, c === r.player ? 4.2 : 2.4, 0, Math.PI * 2);
      ctx.fillStyle = c === r.player ? '#e10600' : 'rgba(200,215,235,.75)';
      ctx.fill();
      if (c === r.player) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
  }

  return { init: init, update: update, show: show, hide: hide };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = HUD; }
