// 人性天平 · 方舟求生 —— 游戏服务器（零依赖 Node）
// 运行：node server.js（监听 $PORT，默认 3000）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ROLES, FACTIONS } = require('./roles');

const PORT = process.env.PORT || 3000;
const HOST_CODE = process.env.HOST_CODE || '0000';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORTRAIT_DIR = path.join(__dirname, 'portraits');

const VOTES_PER_PLAYER = 6;

// ---------- 状态 ----------
function freshState() {
  return {
    version: 1,
    phase: 'lobby', // lobby | intro | draw | teamup | speech | vote | top6 | dark | settle | final | ending
    round: 0, // 0=未开始, 1,2...
    sp: 0,
    spInitial: 0,
    arkFallen: false,
    pool: ROLES.map(r => r.id), // 角色池：主持人可调整，startGame 时据此洗牌
    deck: ROLES.map(r => r.id),
    players: [], // {id,name,roleId,alive,cause,group,joinedAt,darkUsed:{},subUseRound:{}}
    quotas: { kill: 3, heal: 2, protect: 2 }, // kill/protect 每轮刷新（暗面）；heal 每轮刷新（明面救治窗口）
    costs: { kill: 1, heal: 2, protect: 1 },  // 每次暗面行动消耗的 SP（主持人可调）
    killRecord: [],       // 全部暗杀记录 [{round, by, byRole, target, targetName, saved, savedBy}]
    lastKillRecord: [],   // 最近一轮暗面记录（用于下一个明面公布与救治窗口）
    revivable: [],        // 当前明面可救治的玩家 id（被暗杀但尚未被救治）
    votes: {},        // 当前轮 {voterId: [targetId...]}
    voteHistory: [],  // [{round, votes, ranking:[{id,count}], deaths:[]}]
    darkLog: [],      // 当前轮暗面记录
    darkHistory: [],
    pendingDeaths: [], // 结算时待淘汰（资源不足·得票低）
    logs: [],
    finalResult: null,
    ending: null,
    lastSettle: null
  };
}
// 多房间：每个房间 = 一局独立游戏
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
let db = loadDb();
function loadDb() {
  try {
    if (fs.existsSync(ROOMS_FILE)) return JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  } catch (e) { console.error('load db failed', e); }
  return { rooms: {} };
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(db));
  } catch (e) { console.error('save failed', e); }
}
let state = null; // 当前请求锁定的房间状态（请求进入时指向 db.rooms[room]）
function touch() { state.version++; state.lastActive = Date.now(); save(); }
function log(msg) {
  state.logs.push({ t: Date.now(), msg });
  if (state.logs.length > 300) state.logs = state.logs.slice(-300);
}
const ROOM_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 去掉易混淆的 0/1/I/L/O
function newRoomCode() {
  for (let t = 0; t < 50; t++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    if (!db.rooms[c]) return c;
  }
  return Date.now().toString(36).toUpperCase().slice(-5);
}
function pruneRooms() { // 清理：大厅空置超2小时，或任何房间超7天不动
  const now = Date.now();
  for (const code of Object.keys(db.rooms)) {
    const s = db.rooms[code];
    const idle = now - (s.lastActive || 0);
    const emptyLobby = s.phase === 'lobby' && s.players.length === 0;
    if ((emptyLobby && idle > 2 * 3600e3) || idle > 7 * 86400e3) delete db.rooms[code];
  }
}
const roleById = id => ROLES.find(r => r.id === id);
const playerById = id => state.players.find(p => p.id === id);
const alivePlayers = () => state.players.filter(p => p.alive);

// ---------- 工具 ----------
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}

// ---------- 公开视图（给所有人看的名册） ----------
function publicRoster(forPlayerId) {
  return state.players.map(p => {
    const r = p.roleId ? roleById(p.roleId) : null;
    const isSelf = p.id === forPlayerId;
    return {
      id: p.id, name: p.name, alive: p.alive, cause: p.cause || null, group: p.group || null,
      roleId: r ? r.id : null, roleName: r ? r.name : '未抽取',
      gender: r ? r.gender : '', faction: r ? r.faction : null,
      value: r ? r.value : '', issue: r ? r.issue : '',
      specialText: r && r.specialText ? r.specialText : '',
      spRoundText: r ? r.spRoundText : '',
      secret: isSelf && r ? r.secret : null, // 秘密只有本人可见
      spFinalText: isSelf && r ? r.spFinalText : null,
      hasDrawn: !!p.roleId
    };
  });
}
// 主持人视图：全部秘密可见
function hostRoster() {
  return state.players.map(p => {
    const r = p.roleId ? roleById(p.roleId) : null;
    return {
      id: p.id, name: p.name, alive: p.alive, cause: p.cause || null, group: p.group || null,
      roleId: r ? r.id : null, roleName: r ? r.name : '未抽取', gender: r ? r.gender : '',
      faction: r ? r.faction : null, value: r ? r.value : '', secret: r ? r.secret : '',
      issue: r ? r.issue : '', specialText: r && r.specialText ? r.specialText : '',
      spRoundText: r ? r.spRoundText : '', spFinalText: r ? r.spFinalText : '',
      darkUsedThisRound: p.darkUsedThisRound || {}
    };
  });
}
function voteTally() {
  const tally = {};    // 累计票数（含历史各轮）
  const cur = {};      // 本轮票数
  alivePlayers().forEach(p => { tally[p.id] = 0; cur[p.id] = 0; });
  // 历史各轮选票累计
  for (const h of state.voteHistory) {
    Object.values(h.votes || {}).forEach(list => (list || []).forEach(t => { if (tally[t] !== undefined) tally[t]++; }));
  }
  // 本轮实时选票
  Object.values(state.votes).forEach(list => (list || []).forEach(t => {
    if (tally[t] !== undefined) { tally[t]++; cur[t]++; }
  }));
  const ranking = Object.entries(tally)
    .map(([id, count]) => { const p = playerById(id) || {}; const role = p.roleId ? roleById(p.roleId) : null; return { id, count, curCount: cur[id] || 0, name: p.name, roleName: role ? role.name : '—' }; })
    .sort((a, b) => b.count - a.count);
  return { tally, ranking, cur };
}

// ---------- 结算引擎 ----------
function applySettle() {
  const round = state.round;
  const events = [];
  // 1) 暗杀 vs 自由派保护
  const kills = state.darkLog.filter(e => e.type === 'kill');
  const protects = state.darkLog.filter(e => e.type === 'protect');
  const protectedIds = protects.map(e => e.target);
  const newRevivable = [];
  state.lastKillRecord = [];
  for (const k of kills) {
    const p = playerById(k.target);
    if (!p || !p.alive) continue;
    const saved = protectedIds.includes(k.target);
    const rec = { round, by: k.by, byRole: k.byRole || '', target: p.id, targetName: p.name, saved, savedBy: saved ? (protects.find(x => x.target === k.target) || {}).by : null };
    state.killRecord.push(rec);
    state.lastKillRecord.push(rec);
    if (saved) { events.push(`【保护】${p.name} 被 ${rec.savedBy}（自由求生派）保护，暗杀未生效`); }
    else {
      p.alive = false; p.cause = `第${round}轮 · 被 ${k.by} 暗杀（待救治）`;
      p.revivable = true; newRevivable.push(p.id);
      events.push(`【暗杀】${k.by}（${rec.byRole}）杀了 ${p.name} —— 待下一个明面由道德捍卫派选择是否救治`);
    }
  }
  state.revivable = newRevivable;
  // 玛丽亚主动牺牲（主持人在暗面记录）
  for (const e of state.darkLog.filter(e => e.type === 'maria_sacrifice')) {
    const p = playerById(e.target);
    if (p && p.alive) { p.alive = false; p.cause = `第${round}轮 · 主动牺牲`; state.sp += 10; events.push(`【牺牲】玛丽亚 主动选择死亡，方舟资源 +10`); }
  }
  // 2) 资源：角色每轮效果（含 17/18 条件）
  let delta = 0;
  for (const p of alivePlayers()) {
    const r = p.roleId ? roleById(p.roleId) : null;
    if (!r) continue;
    let eff = r.spRound || 0;
    if (r.spRoundCond) {
      const mate = state.players.find(x => x.roleId === r.spRoundCond.ifAliveWith);
      if (mate && mate.alive) eff = r.spRoundCond.then;
    }
    delta += eff;
  }
  // 3) 消耗 = 结算时存活人数
  const aliveN = alivePlayers().length;
  state.sp += delta;
  state.sp -= aliveN;
  events.push(`【消耗】本轮存活 ${aliveN} 人，资源 -${aliveN}；角色效果净 ${delta >= 0 ? '+' : ''}${delta}；当前 SP=${state.sp}`);

  // 4) 资源不足 → 得票低者死
  let lowVoteDeaths = [];
  if (state.sp < aliveN) {
    const deficit = aliveN - state.sp;
    const { ranking } = voteTally();
    const candidates = ranking.filter(x => { const p = playerById(x.id); return p && p.alive; }).slice().reverse();
    const doomed = candidates.slice(0, deficit).map(x => x.id);
    state.pendingDeaths = doomed;
    events.push(`【资源告急】SP(${state.sp}) < 存活人数(${aliveN})，需淘汰 ${deficit} 人（得票最低者）`);
    lowVoteDeaths = doomed;
  } else {
    state.pendingDeaths = [];
  }
  if (state.sp <= 0) { state.arkFallen = true; events.push('【方舟毁灭】资源耗尽！'); }

  // 记录本轮投票史
  const { ranking } = voteTally();
  state.voteHistory.push({ round, votes: { ...state.votes }, ranking });
  state.darkHistory.push({ round, log: state.darkLog });
  state.lastSettle = { round, events, lowVoteDeaths, ranking };

  // 清空本轮
  state.votes = {}; state.darkLog = [];
  state.quotas.kill = 3; state.quotas.protect = 2; state.quotas.heal = 2;
  state.players.forEach(p => { p.darkUsedThisRound = {}; });
  events.forEach(e => log(e));
  touch();
  return state.lastSettle;
}

function confirmLowVoteDeaths() {
  const round = state.round;
  const deaths = [];
  for (const id of state.pendingDeaths) {
    const p = playerById(id);
    if (!p || !p.alive) continue;
    p.alive = false; p.cause = `第${round}轮 · 资源不足得票低`;
    deaths.push(p.name);
    log(`【淘汰】${p.name} 因得票最低且资源不足而死亡`);
  }
  state.pendingDeaths = [];
  // 资源维持原值（死亡不返还）
  touch();
  return { deaths };
}

// ---------- 终局 ----------
function computeFinal(negateTargetId) {
  const survivors = alivePlayers();
  // 黄小年抵消：把一名存活者的负 spFinal 视为 0
  const finEff = p => {
    const r = p.roleId ? roleById(p.roleId) : null;
    if (!r) return 0;
    let eff = r.spFinal || 0;
    if (r.spFinalCond) {
      const mate = state.players.find(x => x.roleId === r.spFinalCond.ifAliveWith);
      if (mate && mate.alive) eff = r.spFinalCond.then;
    }
    if (negateTargetId && p.id === negateTargetId && eff < 0) { eff = 0; }
    return eff;
  };
  let delta = 0; const detail = [];
  for (const p of survivors) {
    const r = roleById(p.roleId);
    const eff = finEff(p);
    if (eff !== 0) { delta += eff; detail.push(`${r.name} ${eff > 0 ? '+' : ''}${eff}`); }
  }
  state.sp += delta;
  // 波特最终存活 → 外界救援
  const porter = survivors.find(p => p.roleId === 29);
  if (porter && state.sp > 0) { /* spFinal 已含 +3 */ }
  // 阵营判定
  const factionCount = { order: 0, free: 0, moral: 0 };
  survivors.forEach(p => { const r = roleById(p.roleId); if (r) factionCount[r.faction]++; });
  const winners = Object.entries(factionCount).filter(([k, v]) => v >= 4).map(([k]) => k);
  // 繁衍/再生能力判定
  const fertile = survivors.some(p => [3, 1].includes(p.roleId)); // 玛丽亚怀孕=可再生；埃琳娜特殊
  const renewable = survivors.some(p => [4, 5, 11, 16, 21].includes(p.roleId));
  state.finalResult = {
    sp: state.sp, survivors: survivors.map(p => ({ id: p.id, name: p.name, roleId: p.roleId, roleName: roleById(p.roleId).name, faction: roleById(p.roleId).faction })),
    factionCount, factionWinners: winners, fertile, renewable,
    detail, arkFallen: state.arkFallen
  };
  log(`【终局】幸存者：${survivors.map(p => roleById(p.roleId).name).join('、')}；资源 ${state.sp}；获胜阵营：${winners.map(k => FACTIONS[k].name).join('、') || '无（全员未能达成阵营目标）'}`);
  touch();
  return state.finalResult;
}

// ---------- 结局生成（本地叙事引擎） ----------
function generateEnding() {
  const fr = state.finalResult || computeFinal(null);
  const survivors = fr.survivors.map(s => ({ ...s, role: roleById(s.roleId) }));
  const winNames = fr.factionWinners.map(k => FACTIONS[k].name);
  const openings = [
    '当新世界的曙光穿透云层，舷窗外的海面第一次泛起了金色。',
    '方舟的引擎在黎明前熄灭了最后一次，剩下的人安静地站在甲板上。',
    '第24号方舟的航迹终止在一座无名海岸，晨雾还没有散。'
  ];
  let txt = '';
  txt += `【尾声 · 第24号方舟】\n\n${openings[Math.floor(Math.random() * openings.length)]}\n\n`;
  txt += `最终逃离的六席之内，站着 ${survivors.length} 位幸存者：${survivors.map(s => s.role.name + '（' + s.name + '）').join('、')}。\n`;
  txt += `方舟剩余资源 ${fr.sp} 点。${fr.sp <= 0 ? '资源早已枯竭，这更像一场漂流而非抵达。' : fr.sp < 10 ? '资源见底，每一步都必须精打细算。' : '资源尚有盈余，火种暂时安全。'}\n\n`;
  // 阵营结局
  if (fr.factionWinners.length === 0) {
    txt += `三个阵营都未能让四名成员进入最终的幸存者名单——没有阵营宣告胜利。历史在这一页没有写下胜负，只写下了人。\n\n`;
  } else {
    for (const k of fr.factionWinners) {
      if (k === 'order') txt += `【秩序重建派的胜利】幸存者中的秩序重建派成员接管了残存的规则手册。他们依照"效率至上"的原则重组了营地——非本阵营者被逐步边缘化，营地陷入一种冰冷而高效的功利主义秩序。规则保住了文明的外壳，也磨掉了某些柔软的东西。\n\n`;
      if (k === 'free') txt += `【自由求生派的胜利】幸存者中的自由求生派成员把契约与互助写进了新的营地章程。没有人再被强迫，但也没有人再被担保——每个人靠自己的本事换取位置。营地充满活力，也充满不确定性。\n\n`;
      if (k === 'moral') txt += `【道德捍卫派的胜利 · 乌托邦】幸存者中的道德捍卫派成员启动了【乌托邦】——人们靠着精神信念互相支撑，哪怕账面资源为负，也没有人被抛弃。${fr.sp <= 0 ? '但信念终归不能当饭吃，营地仍在缓慢走向衰落，只是这一次，没有人是独自死去的。' : '奇迹般地，这份善意被资源盈余托住了。'}\n\n`;
    }
  }
  // 人类存续判定
  txt += fr.fertile
    ? `幸存者中拥有繁衍与基因延续的可能（玛丽亚腹中的孩子 / 埃琳娜手中的基因库），人类文明得到了第二次机会。`
    : (fr.renewable ? `六人组不具备传统意义上的繁衍条件，但他们拥有可再生的生产技能——文明以另一种方式续写。` : `六人组既不具备繁衍能力，也没有可持续的资源再生能力。历史书在这里留下了一个安静的省略号——人类的故事，或许到此为止。`);
  txt += `\n\n`;
  // 每位幸存者的个人命运
  const fates = {
    1: ['她把基因库的密码锁进了自己仅剩的药瓶旁边——知识与生命，她全都留下了。'],
    2: ['他扛起锤子走向废墟，第一块新营地的地基，是他一砖一瓦垒起来的。'],
    3: ['新世界的第一个孩子降生时，是她在场接的生。她的名字被写进了摇篮曲里。'],
    4: ['他在新营地的边缘开出了第一垄田。假肢陷进泥里，麦子照样发芽。'],
    5: ['所有人都以为她是负担，直到她修好了方舟最后一台还活着的主机。她十二岁，眼里没有光，只有代码。'],
    6: ['他再次站上了演讲的位置。这一次，没有人在混乱中被他抛下。'],
    7: ['他为每一位死者诵了经——包括那些死于他人之手的人。合十的手，从未颤抖。'],
    8: ['没有人再提他的案底。发电机重新转动的那天，是他接的线。'],
    9: ['她记录下了每个人的心理崩溃与重建，成为新世界第一部口述史。中立，到底。'],
    10: ['他在夜里仍会惊醒。但营地的哨位，一直是他的。'],
    11: ['中央控制系统在她的指尖复活。她盯着屏幕笑了一下——这是她离开电脑后第一次笑。'],
    12: ['他把这段历史讲给了所有愿意听的人。这一次，历史没有重蹈覆辙。'],
    13: ['她反对的每一个污染方案最终都没有实施。溪水是清的。'],
    14: ['他写下了方舟的全部真相，包括那些见不得光的部分。刊头只有两个字：记录。'],
    15: ['旧世界的文献被她一本本译出。新世界的第一所学校，教材是她编的。'],
    16: ['他还是不合群。但营地每一台机器的轰鸣，都是他留下的署名。'],
    17: ['她的账本上没有亏欠。有人说她冷血，有人说没有她所有人都死了。'],
    18: ['他偶尔清醒。清醒时他说：这一局，你们打得不错。'],
    19: ['他直播了新世界的第一个日出。屏幕那头已没有信号，但他还是对着镜头比了个心。'],
    20: ['新营地的第一顿饱饭，让所有人沉默了很久。有人哭了，他说：先吃饭。'],
    21: ['他记得每一个死去者的名字、日期与死因。这座活体纪念碑，从不遗忘。'],
    22: ['他做了最"高效"的决策，也背起了最重的骂名。财报上写着：盈利。'],
    23: ['新世界的第一个夜晚，她抱着吉他唱歌。没有人说话，也没有人离开。'],
    24: ['急诊室主任的手第一次不再冷静地颤抖——那是为活着的人流的泪。'],
    25: ['那个眼神清澈的大学生，最后成了所有人的备用方案。什么都会一点的人，救了所有人一点。'],
    26: ['他签署了这份新世界的第一份公约。签名下方写着：效率之上，另有正义。'],
    27: ['每一次火情，他都第一个冲进去。这一次，队友全都跟他退了出来。'],
    28: ['药品库在她的手里重新"生长"。她给自己留的最后一支抑制剂，让给了病人。'],
    29: ['某个深夜，电台里传来了另一个方舟的回答。他说对了一半：外面既有威胁，也有同类。']
  };
  txt += `—— 他们的结局 ——\n`;
  for (const s of survivors) {
    const f = fates[s.roleId] || ['她/他在新世界活了下来。'];
    txt += `\n· ${s.role.name}（${s.name}）：${f[0]}`;
    if (s.faction && fr.factionWinners.includes(s.faction)) txt += `（${FACTIONS[s.faction].name}阵营目标达成）`;
  }
  const closers = [
    '历史书写的，永远是幸存者的故事。而他们如何书写自己，只有浪知道。',
    '崇高的死亡与卑微的生存之间，他们选择了活着——并为此付出了全部。',
    '方舟沉没了，人上岸了。人性天平的两端，这一次都没有归零。',
    '所谓文明，不过是六个人决定不变成野兽的那一刻。'
  ];
  txt += `\n\n${closers[Math.floor(Math.random() * closers.length)]}\n\n—— 完 ——`;
  state.ending = { text: txt, at: Date.now() };
  log('【结局】已生成');
  touch();
  return txt;
}

// ---------- 暗面行动（杀人/保人/救人由仲裁官在控制台执行） ----------
function performDarkAction(p, act, targetId) {
  const r = p.roleId ? roleById(p.roleId) : null;
  if (!r) return { error: '执行人未抽取角色' };
  const du = p.darkUsedThisRound = p.darkUsedThisRound || {};
  // 秩序派【暗杀】——暗面进行，全阵营每轮共享 3 次
  if (act === 'kill') {
    if (state.phase !== 'dark') return { error: '暗杀只能在暗面执行' };
    if (r.faction !== 'order') return { error: `执行人 ${p.name} 不是秩序重建派，无法暗杀` };
    if (state.quotas.kill <= 0) return { error: '本轮本阵营 3 次暗杀机会已用完' };
    if (state.sp < state.costs.kill) return { error: `方舟资源不足（暗杀需 ${state.costs.kill} 点 SP）` };
    const t = playerById(targetId);
    if (!t || !t.alive) return { error: '目标无效' };
    if (t.id === p.id) return { error: '不能暗杀自己' };
    state.quotas.kill--; state.sp -= state.costs.kill; du.kill = (du.kill || 0) + 1;
    state.darkLog.push({ type: 'kill', by: p.name, byRole: r.name, target: t.id, at: Date.now() });
    log(`【暗面·仲裁官执行】${p.name}（${r.name}）发动暗杀（SP-${state.costs.kill}）→ 记录目标，结算时生效`);
    return { result: { ok: true, killLeft: state.quotas.kill } };
  }
  // 自由派【保护】——暗面进行，全阵营每轮共享 2 次
  if (act === 'protect') {
    if (state.phase !== 'dark') return { error: '保护只能在暗面执行' };
    if (r.faction !== 'free') return { error: `执行人 ${p.name} 不是自由求生派，无法保护` };
    if (state.quotas.protect <= 0) return { error: '本轮本阵营 2 次保护机会已用完' };
    if (state.sp < state.costs.protect) return { error: `方舟资源不足（保护需 ${state.costs.protect} 点 SP）` };
    const t = playerById(targetId);
    if (!t || !t.alive) return { error: '目标无效' };
    state.quotas.protect--; state.sp -= state.costs.protect; du.protect = (du.protect || 0) + 1;
    state.darkLog.push({ type: 'protect', by: p.name, byRole: r.name, target: t.id, at: Date.now() });
    log(`【暗面·仲裁官执行】${p.name}（${r.name}）保护了 ${t.name}（SP-${state.costs.protect}）`);
    return { result: { ok: true, protectLeft: state.quotas.protect } };
  }
  // 道德派【救治】——在杀人结果公布后的明面阶段进行
  if (act === 'heal') {
    if (state.phase !== 'speech') return { error: '救治在杀人结果公布后的明面阶段执行' };
    if (r.faction !== 'moral') return { error: `执行人 ${p.name} 不是道德捍卫派，无法救治` };
    if (state.quotas.heal <= 0) return { error: '本轮本阵营 2 次救治机会已用完' };
    const t = playerById(targetId);
    if (!t) return { error: '目标无效' };
    if (!state.revivable.includes(t.id)) return { error: '该乘客不在可救治名单中' };
    if (state.sp < state.costs.heal) return { error: `方舟资源不足（救治需 ${state.costs.heal} 点 SP）` };
    state.quotas.heal--; state.sp -= state.costs.heal; du.heal = (du.heal || 0) + 1;
    t.alive = true; t.cause = null; t.revivable = false;
    state.revivable = state.revivable.filter(x => x !== t.id);
    const rec = state.lastKillRecord.find(k => k.target === t.id && !k.saved);
    if (rec) { rec.saved = true; rec.savedBy = p.name; }
    state.darkLog.push({ type: 'heal', by: p.name, byRole: r.name, target: t.id, at: Date.now() });
    log(`【明面·仲裁官执行救治】${p.name}（${r.name}）救治了 ${t.name}（SP-${state.costs.heal}）——他/她重新回到方舟`);
    return { result: { ok: true, healLeft: state.quotas.heal } };
  }
  return { error: '未知技能' };
}

// ---------- API ----------
async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/roles') {
    const portraits = {};
    for (const r of ROLES) portraits[r.id] = fs.existsSync(path.join(PORTRAIT_DIR, r.id + '.png'));
    return json(res, 200, { roles: ROLES, factions: FACTIONS, portraits });
  }
  const body = await readBody(req);
  const q = new URL('http://x' + req.url).searchParams;
  const P = pathname.replace(/^\/api\//, '');
  // 玩家端接口都需要房间（/api/roles 除外）：定位到对应房间状态
  const room = String(body.room || '').trim().toUpperCase();
  if (P !== 'roles' && P !== 'host') {
    const s0 = db.rooms[room];
    if (!s0) return json(res, 400, { error: '房间不存在或已解散，请回首页核对房间号', needRoom: true });
    state = s0;
  }

  // ---- 玩家端 ----
  if (P === 'join') {
    const name = (body.name || '').trim().slice(0, 12);
    if (!name) return json(res, 400, { error: '请输入名字' });
    // 同名重新进入：退出/换设备后输入相同名字，直接回到原角色（任何阶段均可）
    const exist = state.players.find(p => p.name === name);
    if (exist) return json(res, 200, { id: exist.id, name: exist.name, room, rejoined: true });
    if (state.players.length >= 29) return json(res, 400, { error: '人数已满（29）' });
    if (state.phase !== 'lobby') return json(res, 400, { error: '本房间的游戏已开始，无法加入（同名可中途回归）' });
    const id = 'p' + Math.random().toString(36).slice(2, 8);
    state.players.push({ id, name, roleId: null, alive: true, cause: null, group: null,
      joinedAt: Date.now(), darkUsedThisRound: {} });
    log(`【上船】${name} 登船`);
    touch();
    return json(res, 200, { id, name, room });
  }

  if (P === 'view') { // 个人视图
    const p = playerById(body.id);
    if (!p) return json(res, 404, { error: '找不到玩家，请重新加入' });
    const me = publicRoster(p.id).find(x => x.id === p.id);
    return json(res, 200, {
      version: state.version, phase: state.phase, round: state.round, sp: state.sp, room,
      aliveCount: alivePlayers().length, totalCount: state.players.length,
      me, roster: publicRoster(p.id), quotas: state.quotas,
      lastKillRecord: state.lastKillRecord, revivable: state.revivable,
      darkUsedThisRound: p.darkUsedThisRound || {},
      myVotes: state.votes[p.id] || null, canVote: state.phase === 'vote' && p.alive,
      votedCount: Object.keys(state.votes).length,
      ranking: (['settle', 'final', 'ending'].includes(state.phase) && state.lastSettle) ? state.lastSettle.ranking : voteTally().ranking,
      lastSettle: state.lastSettle, pendingDeaths: state.pendingDeaths,
      finalResult: state.finalResult, ending: state.phase === 'ending' ? state.ending : null,
      logs: state.logs.slice(-12)
    });
  }

  if (P === 'draw') {
    const p = playerById(body.id);
    if (!p) return json(res, 404, { error: '玩家不存在' });
    if (state.phase !== 'draw') return json(res, 400, { error: '现在不是抽卡阶段' });
    if (p.roleId) return json(res, 400, { error: '你已抽取角色' });
    if (!state.deck.length) return json(res, 400, { error: '角色卡已抽完' });
    const pick = state.deck.splice(Math.floor(Math.random() * state.deck.length), 1)[0];
    p.roleId = pick;
    log(`【抽卡】${p.name} 抽取了角色卡`);
    touch();
    return json(res, 200, { roleId: pick });
  }

  if (P === 'setgroup') {
    const p = playerById(body.id);
    if (!p) return json(res, 404, { error: '玩家不存在' });
    p.group = Math.max(1, Math.min(9, parseInt(body.group) || 1));
    touch();
    return json(res, 200, { ok: true, group: p.group });
  }

  if (P === 'vote') {
    const p = playerById(body.id);
    if (!p) return json(res, 404, { error: '玩家不存在' });
    if (state.phase !== 'vote') return json(res, 400, { error: '现在不是投票阶段' });
    if (!p.alive) return json(res, 400, { error: '死者没有投票权' });
    const targets = body.targets || [];
    const aliveIds = new Set(alivePlayers().map(x => x.id));
    const need = Math.min(VOTES_PER_PLAYER, aliveIds.size);
    if (targets.length !== need) return json(res, 400, { error: `本轮需投 ${need} 票` });
    if (new Set(targets).size !== targets.length) return json(res, 400, { error: '选票不能重复' });
    if (!targets.every(t => aliveIds.has(t))) return json(res, 400, { error: '选票包含无效目标' });
    state.votes[p.id] = targets;
    log(`【投票】${p.name} 完成投票`);
    touch();
    return json(res, 200, { ok: true, votedCount: Object.keys(state.votes).length });
  }

  if (P === 'dark') { // 暗面技能
    const p = playerById(body.id);
    if (!p) return json(res, 404, { error: '玩家不存在' });
    if (!p.alive) return json(res, 400, { error: '死者没有技能' });
    const r = p.roleId ? roleById(p.roleId) : null;
    if (!r) return json(res, 400, { error: '未抽取角色' });
    const act = body.action;
    const du = p.darkUsedThisRound = p.darkUsedThisRound || {};

    // 秩序派【暗杀】/ 自由派【保护】/ 道德派【救治】——已收归仲裁官在控制台统一执行，玩家端不再直接操作
    if (act === 'kill' || act === 'protect' || act === 'heal') {
      return json(res, 400, { error: '该技能已由仲裁官在控制台统一执行——请把你的行动（执行人+目标）私下告诉仲裁官' });
    }
    if (act === 'eavesdrop') {
      if (state.phase !== 'dark') return json(res, 400, { error: '窃听只能在暗面进行' });
      if (r.special !== 'eavesdrop') return json(res, 400, { error: '只有波特可以窃听' });
      if (du.eavesdrop) return json(res, 400, { error: '本轮已窃听过' });
      du.eavesdrop = true;
      state.darkLog.push({ type: 'eavesdrop', by: p.name, at: Date.now() });
      log(`【暗面】波特发起了窃听——请主持人在技能使用者中随机指认一名告知`);
      touch(); return json(res, 200, { ok: true });
    }
    if (act === 'maria_sacrifice') {
      if (state.phase !== 'dark') return json(res, 400, { error: '只能在暗面选择牺牲' });
      if (r.special !== 'maria_sacrifice') return json(res, 400, { error: '只有玛丽亚可以牺牲' });
      if (du.sacrifice) return json(res, 400, { error: '已选择牺牲' });
      du.sacrifice = true;
      state.darkLog.push({ type: 'maria_sacrifice', target: p.id, by: p.name, at: Date.now() });
      log(`【暗面】玛丽亚 主动选择牺牲（结算时生效，方舟+10）`);
      touch(); return json(res, 200, { ok: true });
    }
    // 兼容旧字段
    if (act === 'exempt') return json(res, 400, { error: '豁免权已改为自由派的【保护】，请在暗面使用' });
    return json(res, 400, { error: '未知技能' });
  }

  // ---- 主持人端 ----
  if (P === 'host') {
    if (body.code !== HOST_CODE) return json(res, 403, { error: '主持人口令错误' });
    const cmd = body.cmd;

    if (cmd === 'createRoom') { // 建新房間：分配房间号
      pruneRooms();
      const code = newRoomCode();
      db.rooms[code] = freshState();
      db.rooms[code].lastActive = Date.now();
      state = db.rooms[code];
      log(`【建房】仲裁官开辟了新的方舟房间`);
      save();
      return json(res, 200, { ok: true, room: code });
    }
    if (cmd !== 'createRoom') {
      const s0 = db.rooms[room];
      if (!s0) return json(res, 400, { error: '房间不存在或已解散，请回首页重新建房' });
      state = s0;
    }
    if (cmd === 'enterRoom') { // 进入已有房间（校验口令后放行）
      return json(res, 200, { ok: true, room, phase: state.phase });
    }

    if (cmd === 'view') {
      return json(res, 200, {
        version: state.version, phase: state.phase, round: state.round, sp: state.sp, room,
        spInitial: state.spInitial, arkFallen: state.arkFallen,
        roster: hostRoster(), quotas: state.quotas, votes: state.votes,
        lastKillRecord: state.lastKillRecord, revivable: state.revivable,
        votedCount: Object.keys(state.votes).length,
        ranking: (['settle', 'final', 'ending'].includes(state.phase) && state.lastSettle) ? state.lastSettle.ranking : voteTally().ranking, deckLeft: state.deck.length, pool: state.pool,
        darkLog: state.darkLog, lastSettle: state.lastSettle,
        pendingDeaths: state.pendingDeaths,
        finalResult: state.finalResult, ending: state.ending, logs: state.logs.slice(-30)
      });
    }
    if (cmd === 'phase') {
      const to = body.to;
      const order = ['lobby', 'intro', 'draw', 'teamup', 'speech', 'vote', 'top6', 'dark', 'settle', 'final', 'ending'];
      if (!order.includes(to)) return json(res, 400, { error: '未知阶段' });
      state.phase = to;
      if (to === 'draw') { state.round = 0; }
      if (to === 'speech') { state.round++; state.votes = {}; state.darkLog = []; state.quotas.kill = 3; state.quotas.protect = 2; state.quotas.heal = 2; state.players.forEach(p => p.darkUsedThisRound = {}); log(`—— 第 ${state.round} 轮 · 明面开始 ——`); }
      if (to === 'vote') log(`—— 第 ${state.round} 轮 · 明面投票开始 ——`);
      if (to === 'dark') log(`—— 第 ${state.round} 轮 · 暗面开始 ——`);
      if (to === 'settle') { applySettle(); }
      if (to === 'teamup') log('—— 组队结识阶段：请玩家自由组队，并互相认识 ——');
      if (to === 'lobby') { /* reset */ }
      touch();
      return json(res, 200, { ok: true, phase: state.phase, round: state.round });
    }
    if (cmd === 'startGame') { // 从 lobby 开船：初始化 SP
      state.spInitial = 2 * state.players.length;
      state.sp = state.spInitial;
      state.deck = shuffle((state.pool && state.pool.length ? state.pool : ROLES.map(r => r.id)).slice());
      log(`【开船】恭喜各位登船！初始资源 SP=${state.sp}（2×${state.players.length}人），角色池 ${state.deck.length} 张`);
      state.phase = 'intro'; touch();
      return json(res, 200, { ok: true });
    }
    if (cmd === 'setPool') { // 主持人挑选进入角色池的角色
      if (!['lobby', 'intro', 'draw'].includes(state.phase)) return json(res, 400, { error: '只能在抽卡阶段结束前调整角色池（明面开始后已锁定）' });
      const ids = [...new Set((body.roleIds || []).map(Number).filter(id => ROLES.some(r => r.id === id)))];
      if (!ids.length) return json(res, 400, { error: '至少要选 1 个角色' });
      if (ids.length < state.players.length) return json(res, 400, { error: `角色数（${ids.length}）不能少于当前玩家数（${state.players.length}），否则有人抽不到卡` });
      state.pool = ids;
      // 牌堆 = 池中未被玩家持有的角色（抽卡阶段内调整也能正确衔接）
      const held = new Set(state.players.filter(p => p.roleId).map(p => p.roleId));
      state.deck = shuffle(ids.filter(id => !held.has(id)));
      log(`【主持人】调整角色池：${ids.length} 个角色进入本轮牌池`);
      touch();
      return json(res, 200, { ok: true, pool: ids, deckLeft: state.deck.length });
    }
    if (cmd === 'reset') { db.rooms[room] = freshState(); db.rooms[room].lastActive = Date.now(); state = db.rooms[room]; state.version = 1; save(); return json(res, 200, { ok: true }); }
    if (cmd === 'hostDark') { // 仲裁官代为执行暗面行动（玩家口头申报）
      const actor = playerById(body.actor);
      if (!actor) return json(res, 404, { error: '执行人不存在' });
      if (!actor.alive) return json(res, 400, { error: '执行人已死亡，没有技能' });
      const r2 = performDarkAction(actor, body.action, body.target);
      if (r2.error) return json(res, 400, { error: r2.error });
      touch();
      return json(res, 200, r2.result);
    }
    if (cmd === 'assignRole') { // 主持人自由指派角色（应对缺席/补位）
      const t = playerById(body.target);
      if (!t) return json(res, 404, { error: '玩家不存在' });
      let rid = parseInt(body.roleId);
      if (body.random) {
        if (!state.deck.length) return json(res, 400, { error: '牌堆已空，无法随机分配' });
        rid = state.deck.splice(Math.floor(Math.random() * state.deck.length), 1)[0];
      } else {
        const role = roleById(rid);
        if (!role) return json(res, 400, { error: '角色不存在' });
        const holder = state.players.find(p => p.roleId === rid && p.id !== t.id);
        if (holder) return json(res, 400, { error: `该角色已被 ${holder.name} 持有` });
        state.deck = state.deck.filter(x => x !== rid);
      }
      // 旧角色退回牌堆（若无人持有，且不是重新指定同一角色）
      if (t.roleId && t.roleId !== rid && !state.players.some(p => p.roleId === t.roleId && p.id !== t.id) && !state.deck.includes(t.roleId)) {
        state.deck.push(t.roleId);
      }
      t.roleId = rid;
      log(`【主持人】将角色【${roleById(rid).name}】指定给 ${t.name}`);
      touch();
      return json(res, 200, { ok: true, roleId: rid });
    }
    if (cmd === 'sp') { state.sp += parseInt(body.delta) || 0; log(`【主持人】手动调整资源 ${body.delta > 0 ? '+' : ''}${body.delta} → SP=${state.sp}`); touch(); return json(res, 200, { ok: true, sp: state.sp }); }
    if (cmd === 'kill') { const t = playerById(body.target); if (t && t.alive) { t.alive = false; t.cause = `第${state.round}轮 · 主持人裁定`; log(`【主持人】${t.name} 被裁定死亡`); touch(); } return json(res, 200, { ok: true }); }
    if (cmd === 'revive') { const t = playerById(body.target); if (t) { t.alive = true; t.cause = null; log(`【主持人】${t.name} 复活`); touch(); } return json(res, 200, { ok: true }); }
    if (cmd === 'tribunal') { // 恩佐集体裁决
      const t = playerById(body.target);
      if (t && t.alive) { t.alive = false; t.cause = `第${state.round}轮 · 集体裁决`; log(`【集体裁决】${t.name} 被过半数同意淘汰（恩佐发起）`); touch(); }
      return json(res, 200, { ok: true });
    }
    if (cmd === 'confirmDeaths') {
      const r = confirmLowVoteDeaths();
      return json(res, 200, { ok: true, ...r });
    }
    if (cmd === 'final') {
      const fr = computeFinal(body.negateTarget || null);
      state.phase = 'final'; touch();
      return json(res, 200, { ok: true, finalResult: fr });
    }
    if (cmd === 'ending') {
      const txt = generateEnding();
      state.phase = 'ending'; touch();
      return json(res, 200, { ok: true, ending: txt });
    }
    if (cmd === 'setgroup') { const t = playerById(body.target); if (t) { t.group = body.group; touch(); } return json(res, 200, { ok: true }); }
    return json(res, 400, { error: '未知指令' });
  }

  return json(res, 404, { error: 'not found' });
}

// ---------- 静态文件 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/LICENSE.txt') { // 版权与授权声明（公开可读）
    const lic = path.join(__dirname, 'LICENSE.txt');
    if (fs.existsSync(lic)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return fs.createReadStream(lic).pipe(res);
    }
  }
  const safe = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}
// 立绘：portraits/{roleId}.png，不存在则返回 404（前端用占位头像）
function servePortrait(res, roleId) {
  const file = path.join(PORTRAIT_DIR, `${roleId}.png`);
  if (fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end();
}

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    const m = pathname.match(/^\/portraits\/(\d+)\.png$/);
    if (m) return servePortrait(res, parseInt(m[1]));
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: '服务器内部错误' });
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`方舟求生 server on :${PORT}  主持人口令=${HOST_CODE}`));
