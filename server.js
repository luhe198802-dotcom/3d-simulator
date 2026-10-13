import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const rootDir = resolve(process.cwd());
const port = Number(process.env.PORT || 8000);
const configPath = join(rootDir, 'api-config.json');
const TOOL_RADIUS = 2.5;
const MAX_SPINDLE_SPEED = 800;
const SAFE_Z = 15;
const STEP_MM = 0.6;
const TOOL_TYPES = {
  endmill: '立铣刀',
  drill: '钻头',
  facemill: '平面铣刀'
};
const DEFAULT_TOOL_MAGAZINE = {
  1: { type: 'facemill', diameter: 25 },
  2: { type: 'endmill', diameter: 5 },
  3: { type: 'drill', diameter: 4 }
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

function getFilePath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split('?')[0]);
  const cleanPath = normalize(decodedPath).replace(/^[/\\]+/, '').replace(/^(\.\.[/\\])+/, '');
  const segments = cleanPath.split(/[\\/]+/).filter(Boolean);
  if (segments.some(segment => segment.startsWith('.')) || segments.includes('api-config.json')) return null;

  const candidate = resolve(join(rootDir, cleanPath || 'index.html'));
  if (candidate !== rootDir && !candidate.startsWith(rootDir + sep)) return null;
  if (!existsSync(candidate)) return null;
  const stats = statSync(candidate);
  if (stats.isDirectory()) return join(candidate, 'index.html');
  return candidate;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) {
        request.destroy();
        rejectBody(new Error('请求内容过长。'));
      }
    });
    request.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        rejectBody(new Error('请求 JSON 格式不正确。'));
      }
    });
    request.on('error', rejectBody);
  });
}

function loadApiConfig() {
  let fileConfig = {};
  if (existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  }

  return {
    provider: process.env.AI_PROVIDER || fileConfig.provider || 'deepseek',
    baseUrl: process.env.DEEPSEEK_BASE_URL || fileConfig.baseUrl || 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || fileConfig.apiKey || '',
    model: process.env.DEEPSEEK_MODEL || fileConfig.model || 'deepseek-v4-flash',
    temperature: Number(process.env.DEEPSEEK_TEMPERATURE ?? fileConfig.temperature ?? 0.2)
  };
}

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function formatMm(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function normalizeStock(input = {}) {
  const type = input.type === 'box' || input.type === 'square' ? 'box' : 'round';
  const width = toPositiveNumber(input.width, type === 'round' ? 32 : 200);
  const depth = toPositiveNumber(input.depth, type === 'round' ? width : 200);
  const height = toPositiveNumber(input.height, 8);
  const radius = type === 'round' ? toPositiveNumber(input.radius, width / 2) : Math.min(width, depth) / 2;

  return { type, width, depth, height, radius };
}

function normalizeTool(input = {}) {
  const diameter = toPositiveNumber(input.diameter, TOOL_RADIUS * 2);
  const cuttingLength = toPositiveNumber(input.cuttingLength, 12);
  const overhang = Math.max(cuttingLength, toPositiveNumber(input.overhang, 20));
  const type = TOOL_TYPES[input.type] ? input.type : 'endmill';
  return {
    type,
    label: TOOL_TYPES[type],
    diameter,
    radius: diameter / 2,
    cuttingLength,
    overhang,
    safeZ: toPositiveNumber(input.safeZ, SAFE_Z),
    maxSpindleSpeed: MAX_SPINDLE_SPEED
  };
}

function normalizeMode(value) {
  return value === 'advanced' ? 'advanced' : 'beginner';
}

function normalizeToolMagazine(input = {}) {
  return Object.fromEntries([1, 2, 3].map(id => {
    const source = input[id] || input[String(id)] || DEFAULT_TOOL_MAGAZINE[id];
    return [id, normalizeTool(source)];
  }));
}

function normalizeProgrammingContext(payload = {}) {
  const stockInput = payload.stock || {};
  return {
    mode: normalizeMode(payload.mode || stockInput.mode),
    stock: normalizeStock(stockInput),
    tool: normalizeTool(stockInput.tool || payload.tool || {}),
    toolMagazine: normalizeToolMagazine(stockInput.toolMagazine || payload.toolMagazine || {})
  };
}

function getAgentSafeAreaText(stock, tool) {
  if (stock.type === 'round') {
    const usableRadius = Math.max(0, stock.radius - tool.radius);
    return `棒材刀具中心安全边界：sqrt(X^2 + Y^2) <= ${formatMm(usableRadius)}mm（已扣除刀具半径）。`;
  }

  const xLimit = Math.max(0, stock.width / 2 - tool.radius);
  const yLimit = Math.max(0, stock.depth / 2 - tool.radius);
  return `长方形刀具中心安全边界：X 在 -${formatMm(xLimit)} 到 ${formatMm(xLimit)}mm，Y 在 -${formatMm(yLimit)} 到 ${formatMm(yLimit)}mm（已扣除刀具半径）。`;
}

function buildAgentMessages(payload) {
  const context = normalizeProgrammingContext(payload);
  const { mode, stock, tool, toolMagazine } = context;
  const currentGcode = String(payload.currentGcode || '').slice(0, 12000);
  const history = Array.isArray(payload.messages) ? payload.messages.slice(-8) : [];
  const safeHistory = history
    .filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content.slice(0, 3000) }));

  const latestUserIndex = safeHistory.map(message => message.role).lastIndexOf('user');
  const latestUser = latestUserIndex >= 0 ? safeHistory[latestUserIndex].content : '请生成一段安全的 G 代码。';
  const earlierHistory = latestUserIndex >= 0
    ? safeHistory.filter((_, index) => index !== latestUserIndex)
    : safeHistory;

  const toolDescription = item => `${item.label} Ø${formatMm(item.diameter)}mm，刃长 ${formatMm(item.cuttingLength)}mm，伸出量 ${formatMm(item.overhang)}mm，安全高度 Z${formatMm(item.safeZ)}`;
  const modeRules = mode === 'advanced'
    ? [
        '当前模式：高级模式（允许换刀）。',
        '只允许使用下面刀库中真实存在的 T01、T02、T03；不得创造 T04 或其他刀号。',
        '根据工序选择最少且合适的刀具：平面铣刀用于端面，立铣刀用于槽/轮廓，钻头只做固定 XY 位置的 Z 向钻孔。',
        '每次换刀必须先抬到该刀安全高度并 M05，再执行 Txx M06；换刀后必须重新 M03/M04 才能切削。',
        ...[1, 2, 3].map(id => `T0${id}：${toolDescription(toolMagazine[id])}。${getAgentSafeAreaText(stock, toolMagazine[id])}`)
      ]
    : [
        '当前模式：初级模式（严格单刀，禁止换刀）。',
        `唯一可用刀具：${toolDescription(tool)}。`,
        '程序中严禁出现任何 T 指令、M06/M6 或换刀说明；只能从头到尾使用当前刀具。',
        `如果当前${tool.label}不适合用户要求，必须明确提示用户更换刀具或切到高级模式，不得假装已经换刀，也不得编造另一把刀。`,
        getAgentSafeAreaText(stock, tool)
      ];

  const stockText = [
    `当前材料类型：${stock.type === 'round' ? '棒材' : '长方形'}`,
    stock.type === 'round'
      ? `尺寸：直径 D=${formatMm(stock.width)}mm，高度 Z=${formatMm(stock.height)}mm，半径 R=${formatMm(stock.radius)}mm`
      : `尺寸：X=${formatMm(stock.width)}mm，Y=${formatMm(stock.depth)}mm，高度 Z=${formatMm(stock.height)}mm`,
    `坐标原点：X0 Y0 是工件上表面中心；Z0 是工件上表面；Z 负值进入材料；工件底面 Z=-${formatMm(stock.height)}mm。`,
    ...modeRules,
    '报警规则：',
    `1. 主轴转速 S > ${MAX_SPINDLE_SPEED} 报警，必须使用 S${MAX_SPINDLE_SPEED} 或更低。`,
    '2. G00 进入材料或在材料内横移是红色报警；G00 只能在 Z0 以上或安全高度移动。',
    `3. Z < -${formatMm(stock.height)}mm 是红色报警，表示穿透工件/可能撞台。`,
    '4. 每一段切深都不得超过当时所用刀具的刃长或伸出量。',
    '5. 主轴未启动就切削是报警；切削前必须 M03/M04。',
    '6. 超出工件范围切削是黄色报警；路径必须在当前材料尺寸内。',
    `7. 程序结束未抬刀是黄色报警；结束前必须抬到当前刀具安全高度、M05、M30。`
  ].join('\n');

  return [
    {
      role: 'system',
      content: [
        '你是一个 CNC 三轴加工中心 G 代码编程智能体。',
        '使用本教学仿真器支持的 Fanuc 风格子集：G00/G01/G02/G03、G17/G21/G90，以及 M03/M04/M05/M06/M30。',
        '禁止使用仿真器不支持的固定循环 G81/G83、增量坐标 G91、刀补 G41/G42/G43、宏变量、子程序或任何未列出的 G/M 指令。钻孔必须展开为逐孔 G00 到安全高度、G01 竖直下钻、G00 抬刀。',
        '必须把 X0 Y0 当成工件上表面中心，Z0 当成工件上表面；不要把原点放在角上、侧边或工件底部。',
        `输出必须优先安全：M03/M04 的 S 值必须 <=${MAX_SPINDLE_SPEED}，切削前主轴必须启动，结束前必须抬到当前刀具安全高度并 M05 M30。`,
        '下刀必须使用 G01/G02/G03 的切削运动；严禁用 G00 下到 Z0 以下或在材料内横移。',
        '生成前必须逐工序按当前材料、当前模式和实际刀具半径自检，路径不能超出材料范围，默认单层切深控制在 2mm 以内。',
        '不得猜测界面中没有提供的刀具、刀号、材料属性或机床能力；参数不足时采用明确标注的保守教学值，无法安全完成时先说明需要用户调整什么。',
        '请根据用户意图生成可直接放入编辑器的 G 代码，并用 ```gcode 代码块包裹。',
        '如果用户需求尺寸或工艺不清楚，可以先给一个保守示例，但不要编造危险参数。'
      ].join('\n')
    },
    ...earlierHistory,
    {
      role: 'user',
      content: `${stockText}\n\n当前编辑器 G 代码：\n${currentGcode || '（空）'}\n\n用户需求：\n${latestUser}`
    }
  ];
}

function extractGCode(content) {
  const fenced = content.match(/```(?:gcode|nc|tap)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const lines = content.split(/\r?\n/);
  const gcodeLines = lines.filter(line => /^\s*(?:O\d+|[GMTXYZFIJRS]\s*-?\d|;|\(|%)|^\s*$/.test(line));
  return gcodeLines.length >= 3 ? gcodeLines.join('\n').trim() : '';
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function lerpPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  };
}

function parseValidationGCode(code, safeZ = SAFE_Z, mode = 'beginner', toolMagazine = {}) {
  const rows = code.split(/\r?\n/);
  const result = [];
  const events = [];
  let modal = { g: 0, x: 0, y: 0, z: safeZ, f: null, spindleOn: false, spindleSpeed: null, toolId: null };
  let pendingToolId = null;

  rows.forEach((raw, index) => {
    const cleaned = raw.replace(/\(.*?\)/g, '').replace(/;.*/, '').trim();
    if (!cleaned) return;

    const tokens = cleaned.match(/[A-Za-z]-?\d+(?:\.\d+)?/g) || [];
    const spindleBeforeLine = modal.spindleOn;
    const cmd = {
      line: index + 1,
      raw: raw.trim(),
      g: null,
      start: { x: modal.x, y: modal.y, z: modal.z },
      end: { x: modal.x, y: modal.y, z: modal.z },
      feed: modal.f,
      spindleOn: modal.spindleOn,
      spindleSpeed: modal.spindleSpeed,
      hasMove: false,
      rapid: false,
      arc: false,
      cw: false,
      i: 0,
      j: 0
    };
    let speedCommand = null;
    let spindleCommand = null;
    let toolChangeRequest = false;
    let tWord = null;
    let hasSpindleStop = false;

    tokens.forEach(token => {
      const key = token[0].toUpperCase();
      const value = Number(token.slice(1));
      if (key === 'G') {
        if ([0, 1, 2, 3].includes(value)) {
          modal.g = value;
          cmd.g = value;
        }
      } else if (key === 'X') {
        cmd.end.x = value;
        modal.x = value;
        cmd.hasMove = true;
      } else if (key === 'Y') {
        cmd.end.y = value;
        modal.y = value;
        cmd.hasMove = true;
      } else if (key === 'Z') {
        cmd.end.z = value;
        modal.z = value;
        cmd.hasMove = true;
      } else if (key === 'F') {
        modal.f = value;
        cmd.feed = value;
      } else if (key === 'S') {
        modal.spindleSpeed = value;
        speedCommand = value;
      } else if (key === 'M') {
        spindleCommand = value;
        if (value === 3 || value === 4) modal.spindleOn = true;
        if (value === 5) {
          modal.spindleOn = false;
          hasSpindleStop = true;
        }
        if (value === 6) toolChangeRequest = true;
      } else if (key === 'T') {
        tWord = Math.round(value);
      } else if (key === 'I') {
        cmd.i = value;
      } else if (key === 'J') {
        cmd.j = value;
      }
    });

    if (mode === 'advanced' && toolChangeRequest) {
      const targetId = tWord ?? pendingToolId;
      if (targetId && toolMagazine[targetId]) {
        cmd.toolChange = { line: index + 1, to: targetId, from: modal.toolId };
        modal.toolId = targetId;
        cmd.hasMove = true;
      }
      if (spindleCommand !== 3 && spindleCommand !== 4) modal.spindleOn = false;
      pendingToolId = null;
    } else if (mode === 'advanced' && tWord && toolMagazine[tWord]) {
      pendingToolId = tWord;
    }
    cmd.toolId = modal.toolId;

    cmd.g = cmd.g ?? modal.g;
    cmd.rapid = cmd.g === 0;
    cmd.arc = cmd.g === 2 || cmd.g === 3;
    cmd.cw = cmd.g === 2;
    cmd.spindleOn = modal.spindleOn;
    cmd.spindleSpeed = modal.spindleSpeed;
    events.push({
      line: index + 1,
      raw: raw.trim(),
      speedCommand,
      spindleCommand,
      spindleBeforeLine,
      hasSpindleStop,
      spindleOn: modal.spindleOn,
      spindleSpeed: modal.spindleSpeed,
      tWord,
      toolChangeRequest,
      toolChange: cmd.toolChange,
      toolId: modal.toolId,
      hasMove: cmd.hasMove
    });
    if (cmd.hasMove) result.push(cmd);
  });

  result.events = events;
  return result;
}

function sampleValidationCommand(cmd) {
  if (!cmd.arc) {
    const dist = distance(cmd.start, cmd.end);
    const steps = Math.max(1, Math.ceil(dist / STEP_MM));
    return Array.from({ length: steps }, (_, index) => {
      const t = (index + 1) / steps;
      return lerpPoint(cmd.start, cmd.end, t);
    });
  }

  const center = { x: cmd.start.x + cmd.i, y: cmd.start.y + cmd.j, z: cmd.start.z };
  const radius = Math.hypot(cmd.start.x - center.x, cmd.start.y - center.y);
  if (radius < 0.001) return [cmd.end];
  let a0 = Math.atan2(cmd.start.y - center.y, cmd.start.x - center.x);
  let a1 = Math.atan2(cmd.end.y - center.y, cmd.end.x - center.x);
  const fullCircle = Math.hypot(cmd.end.x - cmd.start.x, cmd.end.y - cmd.start.y) < 0.001;
  if (fullCircle) {
    a1 = a0 + (cmd.cw ? -Math.PI * 2 : Math.PI * 2);
  } else {
    if (cmd.cw && a1 > a0) a1 -= Math.PI * 2;
    if (!cmd.cw && a1 < a0) a1 += Math.PI * 2;
  }
  const arcLen = Math.abs(a1 - a0) * radius;
  const steps = Math.max(8, Math.ceil(arcLen / STEP_MM));
  return Array.from({ length: steps }, (_, index) => {
    const t = (index + 1) / steps;
    const a = a0 + (a1 - a0) * t;
    return {
      x: center.x + Math.cos(a) * radius,
      y: center.y + Math.sin(a) * radius,
      z: cmd.start.z + (cmd.end.z - cmd.start.z) * t
    };
  });
}

function buildValidationPath(cmds, safeZ = SAFE_Z) {
  const points = [{ x: 0, y: 0, z: safeZ, rapid: true, line: 0, raw: 'START', spindleOn: false }];

  cmds.forEach(cmd => {
    const samples = sampleValidationCommand(cmd);
    samples.forEach(point => {
      points.push({
        ...point,
        rapid: cmd.rapid,
        line: cmd.line,
        raw: cmd.raw,
        g: cmd.g,
        spindleOn: cmd.spindleOn,
        spindleSpeed: cmd.spindleSpeed,
        toolId: cmd.toolId,
        toolChange: cmd.toolChange
      });
    });
  });

  return points;
}

function isInsideValidationStock(point, stock, margin = 0) {
  if (stock.type === 'round') {
    return Math.hypot(point.x, point.y) <= Math.max(0, stock.radius + margin);
  }
  return Math.abs(point.x) <= Math.max(0, stock.width / 2 + margin)
    && Math.abs(point.y) <= Math.max(0, stock.depth / 2 + margin);
}

function addValidationIssue(issues, seen, type, line, key, message) {
  const seenKey = `${line}-${key}`;
  if (seen.has(seenKey)) return;
  seen.add(seenKey);
  issues.push({ type, level: type, line, message });
}

function validateProgramCommands(gcode, mode, toolMagazine) {
  const issues = [];
  const seen = new Set();
  const supportedG = new Set([0, 1, 2, 3, 17, 21, 90]);
  const supportedM = new Set([3, 4, 5, 6, 30]);
  let pendingToolId = null;
  let pendingToolLine = 0;

  gcode.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const cleaned = raw.replace(/\(.*?\)/g, '').replace(/;.*/, '').trim();
    if (!cleaned) return;
    const tokens = cleaned.match(/[A-Za-z]-?\d+(?:\.\d+)?/g) || [];
    const gWords = tokens.filter(token => token[0].toUpperCase() === 'G').map(token => Number(token.slice(1)));
    const mWords = tokens.filter(token => token[0].toUpperCase() === 'M').map(token => Number(token.slice(1)));
    const tToken = tokens.find(token => token[0].toUpperCase() === 'T');
    const tWord = tToken ? Math.round(Number(tToken.slice(1))) : null;

    gWords.forEach(value => {
      if (!supportedG.has(value)) {
        addValidationIssue(issues, seen, 'crash', line, `unsupported-g${value}`, `当前仿真器不支持 G${String(value).padStart(2, '0')}，请只使用 G00/G01/G02/G03/G17/G21/G90。`);
      }
    });
    mWords.forEach(value => {
      if (!supportedM.has(value)) {
        addValidationIssue(issues, seen, 'crash', line, `unsupported-m${value}`, `当前仿真器不支持 M${String(value).padStart(2, '0')}。`);
      }
    });

    if (mode === 'beginner') {
      if (tWord !== null) {
        addValidationIssue(issues, seen, 'crash', line, 'beginner-tool', '初级模式禁止 T 刀号，只能使用界面当前选择的一把刀。');
      }
      if (mWords.includes(6)) {
        addValidationIssue(issues, seen, 'crash', line, 'beginner-m06', '初级模式禁止 M06 换刀。');
      }
      return;
    }

    if (tWord !== null) {
      if (!toolMagazine[tWord]) {
        addValidationIssue(issues, seen, 'crash', line, 'unknown-tool', `刀库中不存在 T${String(tWord).padStart(2, '0')}，只能使用 T01/T02/T03。`);
      } else {
        pendingToolId = tWord;
        pendingToolLine = line;
      }
    }

    if (mWords.includes(6)) {
      const targetId = tWord ?? pendingToolId;
      if (!targetId || !toolMagazine[targetId]) {
        addValidationIssue(issues, seen, 'crash', line, 'm06-no-tool', 'M06 前没有有效的 T01/T02/T03 选刀指令。');
      }
      pendingToolId = null;
      pendingToolLine = 0;
    }
  });

  if (mode === 'advanced' && pendingToolId) {
    addValidationIssue(issues, seen, 'crash', pendingToolLine, 'tool-without-m06', `T${String(pendingToolId).padStart(2, '0')} 只预选了刀具，但没有执行 M06 换刀。`);
  }
  return issues;
}

function validateGeneratedGCode(gcode, contextInput = {}) {
  const context = normalizeProgrammingContext(contextInput.stock ? contextInput : { stock: contextInput });
  const { mode, stock, tool, toolMagazine } = context;
  const commandIssues = validateProgramCommands(gcode, mode, toolMagazine);
  if (!gcode.trim()) {
    return [{ type: 'crash', level: 'crash', line: 0, message: '没有识别到可校验的 G 代码。' }];
  }

  const cmds = parseValidationGCode(gcode, tool.safeZ, mode, toolMagazine);
  if (!cmds.length) {
    return [...commandIssues, { type: 'crash', level: 'crash', line: 0, message: 'G 代码里没有可执行的刀具移动。' }];
  }

  const issues = [...commandIssues];
  const seen = new Set(commandIssues.map(issue => `${issue.line}-${issue.message}`));
  const points = buildValidationPath(cmds, tool.safeZ);
  const events = cmds.events || [];
  const pointTool = point => mode === 'advanced' && point.toolId && toolMagazine[point.toolId]
    ? toolMagazine[point.toolId]
    : tool;

  events.forEach(event => {
    if (event.speedCommand !== null && event.speedCommand > MAX_SPINDLE_SPEED) {
      addValidationIssue(
        issues,
        seen,
        'warn',
        event.line,
        'speed',
        `主轴转速 S${event.speedCommand} 超过上限 S${MAX_SPINDLE_SPEED}。`
      );
    }
    if (mode === 'advanced' && event.toolChangeRequest && event.spindleBeforeLine && !event.hasSpindleStop) {
      addValidationIssue(
        issues,
        seen,
        'warn',
        event.line,
        'toolchange-spindle',
        '换刀前主轴仍在转动；请先执行 M05，再执行 Txx M06。'
      );
    }
  });

  points.forEach((point, index) => {
    if (index === 0) return;
    const prev = points[index - 1];
    const activePointTool = pointTool(point);
    const intersectsStock = isInsideValidationStock(point, stock, activePointTool.radius);
    const toolWithinStock = isInsideValidationStock(point, stock, -activePointTool.radius);
    const xyMove = Math.hypot(point.x - prev.x, point.y - prev.y) > 0.01;
    const rapidDown = point.z < prev.z - 0.01;
    const insideMaterial = point.z < -0.05;

    if (point.toolChange && point.z < activePointTool.safeZ - .05) {
      addValidationIssue(
        issues,
        seen,
        'warn',
        point.line,
        'toolchange-z',
        `换刀时 Z${point.z.toFixed(2)} 低于 T${String(point.toolId).padStart(2, '0')} 的安全高度 Z${formatMm(activePointTool.safeZ)}。`
      );
    }
    if (point.rapid && insideMaterial && intersectsStock && rapidDown) {
      addValidationIssue(
        issues,
        seen,
        'crash',
        point.line,
        'rapid-down',
        `G00 快速下刀进入材料，当前 Z${point.z.toFixed(2)}。`
      );
    }
    if (point.rapid && insideMaterial && intersectsStock && xyMove) {
      addValidationIssue(
        issues,
        seen,
        'crash',
        point.line,
        'rapid-xy',
        `G00 在材料内快速横移，当前 Z${point.z.toFixed(2)}。`
      );
    }
    if (point.z < -stock.height) {
      addValidationIssue(
        issues,
        seen,
        'crash',
        point.line,
        'bottom',
        `Z${point.z.toFixed(2)} 低于工件底面 -${formatMm(stock.height)}mm，可能穿透工件或撞台。`
      );
    } else if (!point.rapid && Math.abs(Math.min(0, point.z)) > activePointTool.overhang) {
      addValidationIssue(
        issues,
        seen,
        'crash',
        point.line,
        'holder-crash',
        `${activePointTool.label}切削深度 ${Math.abs(point.z).toFixed(2)}mm 超过伸出量 ${formatMm(activePointTool.overhang)}mm，刀柄会接触工件。`
      );
    } else if (!point.rapid && Math.abs(Math.min(0, point.z)) > activePointTool.cuttingLength) {
      addValidationIssue(
        issues,
        seen,
        'crash',
        point.line,
        'flute-crash',
        `${activePointTool.label}切削深度 ${Math.abs(point.z).toFixed(2)}mm 超过刃长 ${formatMm(activePointTool.cuttingLength)}mm。`
      );
    }
    if (!point.rapid && point.z < 0 && !point.spindleOn) {
      addValidationIssue(
        issues,
        seen,
        'crash',
        point.line,
        'spindle-off',
        '主轴未启动就开始切削。'
      );
    }
    if (!point.rapid && point.z <= 0 && !toolWithinStock) {
      addValidationIssue(
        issues,
        seen,
        'warn',
        point.line,
        'outside',
        '切削点超出当前工件范围。'
      );
    }
    if (point.rapid && xyMove && point.z < activePointTool.safeZ - 0.05) {
      addValidationIssue(
        issues,
        seen,
        'warn',
        point.line,
        'safe-z',
        `G00 横向快速移动时 Z${point.z.toFixed(2)} 低于当前${activePointTool.label}安全高度 Z${formatMm(activePointTool.safeZ)}。`
      );
    }
    if (activePointTool.type === 'drill' && !point.rapid && insideMaterial && xyMove) {
      addValidationIssue(
        issues,
        seen,
        'crash',
        point.line,
        'drill-xy',
        '钻头在材料内横向切削；钻头只能在固定 XY 位置沿 Z 轴下钻，槽和轮廓必须使用立铣刀。'
      );
    }
  });

  const lastPoint = points[points.length - 1];
  if (lastPoint && lastPoint.z < -0.05) {
    const lastTool = pointTool(lastPoint);
    issues.push({
      type: 'warn',
      level: 'warn',
      line: lastPoint.line,
      message: `程序结束时刀具仍在材料内，当前 Z${lastPoint.z.toFixed(2)}，建议结束前抬刀到 Z${formatMm(lastTool.safeZ)}。`
    });
  }

  return issues;
}

function formatValidationIssue(issue) {
  const line = issue.line ? `第 ${issue.line} 行` : '整段程序';
  const label = issue.type === 'crash' ? '红色' : '黄色';
  return `${line} ${label}：${issue.message}`;
}

function buildRepairMessages(messages, reply, issues, payload = {}) {
  const { mode, tool, toolMagazine } = normalizeProgrammingContext(payload);
  const modeRequirement = mode === 'advanced'
    ? `保持高级模式规则：只能使用 ${[1, 2, 3].map(id => `T0${id}=${toolMagazine[id].label} Ø${formatMm(toolMagazine[id].diameter)}`).join('、')}，换刀前抬刀并 M05，使用 Txx M06，换刀后重新 M03。`
    : `保持初级模式规则：只能使用当前${tool.label} Ø${formatMm(tool.diameter)}，严禁任何 T 指令或 M06。`;
  return [
    ...messages,
    { role: 'assistant', content: reply || '（没有输出可用 G 代码）' },
    {
      role: 'user',
      content: [
        '上面的 G 代码没有通过当前仿真报警校验，请按原需求修正。',
        modeRequirement,
        `通用修正要求：X0/Y0 必须是工件上表面中心，Z0 必须是工件上表面；S 不超过 ${MAX_SPINDLE_SPEED}；G00 不得进入材料；切削前必须启动主轴；只能使用仿真器支持的 G00/G01/G02/G03/G17/G21/G90；结束前必须抬到当前刀具安全高度、M05、M30。`,
        '校验问题：',
        issues.map(formatValidationIssue).join('\n'),
        '请输出一段新的 ```gcode``` 代码块。'
      ].join('\n')
    }
  ];
}

async function requestChatCompletion(config, messages) {
  const apiResponse = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: false
    })
  });

  const data = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const error = new Error(data?.error?.message || `DeepSeek 请求失败：HTTP ${apiResponse.status}`);
    error.statusCode = apiResponse.status;
    throw error;
  }

  return data?.choices?.[0]?.message?.content || '';
}

async function handleProgrammingAgent(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: '只支持 POST 请求。' });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const config = loadApiConfig();

    if (!config.apiKey || config.apiKey.includes('在这里填写')) {
      sendJson(response, 500, {
        error: 'DeepSeek API Key 未配置。请在 api-config.json 填写 apiKey，或在 Railway 设置 DEEPSEEK_API_KEY。'
      });
      return;
    }

    const messages = buildAgentMessages(payload);
    let reply = await requestChatCompletion(config, messages);
    let gcode = extractGCode(reply);
    let validationIssues = validateGeneratedGCode(gcode, payload);
    let repaired = false;
    let repairError = '';

    if (validationIssues.length) {
      try {
        const repairMessages = buildRepairMessages(messages, reply, validationIssues, payload);
        const repairedReply = await requestChatCompletion(config, repairMessages);
        const repairedGcode = extractGCode(repairedReply);
        const repairedIssues = validateGeneratedGCode(repairedGcode, payload);
        reply = repairedReply;
        gcode = repairedGcode;
        validationIssues = repairedIssues;
        repaired = true;
      } catch (error) {
        repairError = error.message || '自动修正失败。';
      }
    }

    sendJson(response, 200, {
      reply,
      gcode,
      validationIssues,
      validationOk: validationIssues.length === 0,
      repaired,
      repairError,
      model: config.model,
      provider: config.provider
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || '编程智能体请求失败。' });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (process.env.NODE_ENV === 'test' && url.pathname === '/api/test-validation') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '只支持 POST 请求。' });
      return;
    }
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, { issues: validateGeneratedGCode(String(payload.gcode || ''), payload) });
    } catch (error) {
      sendJson(response, 400, { error: error.message || '测试请求失败。' });
    }
    return;
  }
  if (url.pathname === '/api/programming-agent') {
    await handleProgrammingAgent(request, response);
    return;
  }

  const filePath = getFilePath(url.pathname);
  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const contentType = mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`3D simulator running on port ${port}`);
});
