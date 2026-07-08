import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const rootDir = resolve(process.cwd());
const port = Number(process.env.PORT || 8000);
const configPath = join(rootDir, 'api-config.json');

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

function buildAgentMessages(payload) {
  const stock = payload.stock || {};
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

  const stockText = [
    `当前材料类型：${stock.type === 'round' ? '棒材' : '长方形'}`,
    `尺寸：X=${stock.width ?? '--'}mm, Y=${stock.depth ?? '--'}mm, Z高度=${stock.height ?? '--'}mm`,
    `刀具：Ø5mm，半径 2.5mm`,
    '安全规则：主轴转速 S 不得超过 800；默认安全高度 Z15；尽量不要单次切深超过 2mm；不要使用 G00 进入材料。'
  ].join('\n');

  return [
    {
      role: 'system',
      content: [
        '你是一个 CNC 三轴加工中心 G 代码编程智能体。',
        '使用 Fanuc 风格 G 代码，单位 mm，默认 G21 G17 G90。',
        '输出必须优先安全：M03/M04 的 S 值必须 <=800，切削前主轴必须启动，结束前必须 G00 Z15 抬刀并 M05 M30。',
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

    const apiResponse = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildAgentMessages(payload),
        temperature: config.temperature,
        stream: false
      })
    });

    const data = await apiResponse.json().catch(() => ({}));
    if (!apiResponse.ok) {
      sendJson(response, apiResponse.status, {
        error: data?.error?.message || `DeepSeek 请求失败：HTTP ${apiResponse.status}`
      });
      return;
    }

    const reply = data?.choices?.[0]?.message?.content || '';
    sendJson(response, 200, {
      reply,
      gcode: extractGCode(reply),
      model: config.model,
      provider: config.provider
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || '编程智能体请求失败。' });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
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
