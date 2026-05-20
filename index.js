import 'dotenv/config';
import { Storage } from 'megajs';
import express from 'express';
import { randomUUID } from 'crypto';

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (r) => console.error('Rejection:', r));

const MEGA_EMAIL    = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const PORT          = process.env.PORT || 3000;
const API_KEY       = process.env.MCP_API_KEY;

if (!MEGA_EMAIL || !MEGA_PASSWORD) { console.error('ERRO: sem credenciais MEGA'); process.exit(1); }

let _storage = null;
let _storageErr = null;

async function getStorage() {
  if (_storage) return _storage;
  if (_storageErr) throw _storageErr;
  _storage = await new Promise((res, rej) => {
    const s = new Storage({ email: MEGA_EMAIL, password: MEGA_PASSWORD });
    s.on('ready', () => res(s));
    s.on('error', (e) => { _storageErr = e; rej(e); });
  });
  return _storage;
}

function nodeInfo(n) {
  return { id: n.nodeId, name: n.name, type: n.directory ? 'folder' : 'file', size: n.size || 0 };
}

async function byPath(storage, parts) {
  let cur = storage.root;
  for (const p of parts) {
    if (!cur.children) return null;
    cur = cur.children.find(n => n.name === p);
    if (!cur) return null;
  }
  return cur;
}

// Tool definitions
const TOOLS = [
  {
    name: 'listar_pasta',
    description: 'Lista arquivos e pastas dentro de um caminho do MEGA. Use / para raiz.',
    inputSchema: {
      type: 'object',
      properties: {
        caminho: { type: 'string', description: 'Caminho da pasta, ex: / ou /Fotos' }
      },
      required: ['caminho']
    }
  },
  {
    name: 'buscar_arquivo',
    description: 'Busca arquivos no MEGA pelo nome.',
    inputSchema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome ou parte do nome do arquivo' }
      },
      required: ['nome']
    }
  },
  {
    name: 'criar_pasta',
    description: 'Cria uma nova pasta no MEGA.',
    inputSchema: {
      type: 'object',
      properties: {
        caminho_pai: { type: 'string', description: 'Caminho da pasta pai' },
        nome: { type: 'string', description: 'Nome da nova pasta' }
      },
      required: ['caminho_pai', 'nome']
    }
  },
  {
    name: 'gerar_link',
    description: 'Gera link publico de compartilhamento para um arquivo.',
    inputSchema: {
      type: 'object',
      properties: {
        caminho: { type: 'string', description: 'Caminho do arquivo, ex: /Fotos/imagem.jpg' }
      },
      required: ['caminho']
    }
  },
  {
    name: 'info_conta',
    description: 'Retorna informacoes da conta MEGA (espaco usado e disponivel).',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function callTool(name, args) {
  try {
    const st = await getStorage();
    if (name === 'listar_pasta') {
      const { caminho } = args;
      const node = caminho === '/' ? st.root : await byPath(st, caminho.replace(/^\//, '').split('/'));
      if (!node) return { content: [{ type: 'text', text: 'Pasta nao encontrada: ' + caminho }] };
      return { content: [{ type: 'text', text: JSON.stringify((node.children || []).map(nodeInfo), null, 2) }] };
    }
    if (name === 'buscar_arquivo') {
      const { nome } = args;
      const r = Object.values(st.files).filter(n => n.name && n.name.toLowerCase().includes(nome.toLowerCase())).map(nodeInfo);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    if (name === 'criar_pasta') {
      const { caminho_pai, nome } = args;
      const pai = caminho_pai === '/' ? st.root : await byPath(st, caminho_pai.replace(/^\//, '').split('/'));
      if (!pai) return { content: [{ type: 'text', text: 'Pasta pai nao encontrada' }] };
      const nova = await new Promise((res, rej) => pai.mkdir(nome, (err, f) => err ? rej(err) : res(f)));
      return { content: [{ type: 'text', text: 'Pasta criada: ' + nova.name }] };
    }
    if (name === 'gerar_link') {
      const { caminho } = args;
      const node = await byPath(st, caminho.replace(/^\//, '').split('/'));
      if (!node) return { content: [{ type: 'text', text: 'Arquivo nao encontrado' }] };
      const link = await new Promise((res, rej) => node.link((err, l) => err ? rej(err) : res(l)));
      return { content: [{ type: 'text', text: link }] };
    }
    if (name === 'info_conta') {
      return { content: [{ type: 'text', text: JSON.stringify({ usado_GB: (st.bytesUsed/1e9).toFixed(2), total_GB: (st.bytesTotal/1e9).toFixed(2) }) }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'Ferramenta desconhecida: ' + name }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: 'Erro: ' + e.message }] };
  }
}

const app = express();
app.use(express.json());

// Auth
app.use('/mcp', (req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] ||
               (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim() ||
               req.query.apiKey;
  if (key !== API_KEY) {
    console.log('Auth failed. Key:', key ? key.slice(0,8)+'...' : 'none');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const sessions = {};

app.post('/mcp', async (req, res) => {
  const body = req.body;
  const method = body && body.method;
  const id = body && body.id;
  const sessionId = req.headers['mcp-session-id'];
  console.log('POST /mcp method:', method, 'session:', sessionId);

  try {
    // Handle initialize
    if (method === 'initialize') {
      const sid = randomUUID();
      sessions[sid] = { created: Date.now() };
      const resp = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mega-mcp-server', version: '1.0.0' }
        }
      };
      res.set('mcp-session-id', sid);
      return res.json(resp);
    }

    // Handle tools/list
    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS }
      });
    }

    // Handle tools/call
    if (method === 'tools/call') {
      const { name, arguments: args } = body.params || {};
      const result = await callTool(name, args || {});
      return res.json({ jsonrpc: '2.0', id, result });
    }

    // Handle notifications (no response needed)
    if (!method || method.startsWith('notifications/')) {
      return res.status(202).end();
    }

    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    console.error('POST /mcp error:', e.message);
    return res.status(500).json({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

app.get('/mcp', (req, res) => {
  const sid = req.headers['mcp-session-id'];
  console.log('GET /mcp session:', sid);
  if (!sid || !sessions[sid]) {
    return res.status(405).set('Allow', 'POST').json({ error: 'Use POST to start MCP session' });
  }
  // SSE for server-sent events (not needed for basic tool use)
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('event: ping\ndata: {}\n\n');
  // Keep alive briefly
  setTimeout(() => res.end(), 30000);
});

app.delete('/mcp', (req, res) => {
  const sid = req.headers['mcp-session-id'];
  if (sid && sessions[sid]) delete sessions[sid];
  res.status(200).end();
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'mega-mcp-server' }));

app.listen(PORT, () => {
  console.log('mega-mcp-server porta ' + PORT);
  console.log('MCP endpoint: http://localhost:' + PORT + '/mcp');
});
