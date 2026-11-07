const fs = require('fs');
let t = fs.readFileSync('src/02-race.js', 'utf8').replace(/\r\n/g, '\n');
let n = 0;
function rep(a, b, label) { if (t.includes(a)) { t = t.split(a).join(b); n++; console.log('  ✓ ' + label); } else console.log('  ✗ ' + label); }

// 玩家：转向能力随车速（静止时不能转，6 m/s 以上才给满）
rep("    p.heading -= steerForYaw * steerTrim * YAW_RATE * yawAuth * speedFactor * dt;",
`    /* 转向必须随车速：真实车静止时打方向车头不会转。
     * 之前没有这个约束，按 D 就能以 0 速度原地转 79°，表现为「车快速往右转」。 */
    var yawSpeed = Util.clamp(Math.abs(v) / 6, 0, 1);
    p.heading -= steerForYaw * steerTrim * YAW_RATE * yawAuth * speedFactor * yawSpeed * dt;`,
    '玩家转向随车速');

// AI：同样加约束（原来也能原地转向）
rep("    c.heading -= steer * YAW_RATE * yawAuth * speedFactor * dt;",
`    var aiYawSpeed = Util.clamp(Math.abs(c.speed) / 6, 0, 1);
    c.heading -= steer * YAW_RATE * yawAuth * speedFactor * aiYawSpeed * dt;`,
    'AI 转向随车速');

// 顺带：低速时也不能靠打方向"蹭"出横向位移（sin(slip) 已经随 v 缩放了，这里只补注释）
fs.writeFileSync('src/02-race.js', t, 'utf8');
console.log('替换 ' + n + ' 处');
