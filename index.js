import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Storage } from 'megajs';
import express from 'express';
import { z } from 'zod';
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

function buildServer() {
  const s = new McpServer({ name: 'mega-mcp-server', version: '1.0.0' });

  s.tool('listar_pasta', 'Lista arquivos e pastas no MEGA. Use / para raiz.',
    { caminho: z.string().describe('ex: / ou /Fotos') },
    async ({ caminho }) => {
      try {
        const st = await getStorage();
        const node = caminho === '/' ? st.root : await byPath(st, caminho.replace(/^\//, '').split('/'));
        if (!node) return { content: [{ type: 'text', text: 'Pasta nao encontrada: ' + caminho }] };
        return { content: [{ type: 'text', text: JSON.stringify((node.children || []).map(nodeInfo), null, 2) }] };
      } catch (e) { return { content: [{ type: 'text', text: 'Erro: ' + e.message }] }; }
    }
  );

  s.tool('buscar_arquivo', 'Busca arquivo no MEGA por nome.',
    { nome: z.string() },
    async ({ nome }) => {
      try {
        const st = await getStorage();
        const r = Object.values(st.files).filter(n => n.name && n.name.toLowerCase().includes(nome.toLowerCase())).map(nodeInfo);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      } catch (e) { return { content: [{ type: 'text', text: 'Erro: ' + e.message }] }; }
    }
  );

  s.tool('criar_pasta', 'Cria pasta no MEGA.',
    { caminho_pai: z.string(), nome: z.string() },
    async ({ caminho_pai, nome }) => {
      try {
        const st = await getStorage();
        const pai = caminho_pai === '/' ? st.root : await byPath(st, caminho_pai.replace(/^\//, '').split('/'));
        if (!pai) return { content: [{ type: 'text', text: 'Pai nao encontrado' }] };
        const nova = await new Promise((res, rej) => pai.mkdir(nome, (err, f) => err ? rej(err) : res(f)));
        return { content: [{ type: 'text', text: 'Criada: ' + nova.name }] };
      } catch (e) { return { content: [{ type: 'text', text: 'Erro: ' + e.message }] }; }
    }
  );

  s.tool('gerar_link', 'Gera link publico de arquivo no MEGA.',
    { caminho: z.string() },
    async ({ caminho }) => {
      try {
        const st = await getStorage();
        const node = await byPath(st, caminho.replace(/^\//, '').split('/'));
        if (!node) return { content: [{ type: 'text', text: 'Nao encontrado' }] };
        const link = await new Promise((res, rej) => node.link((err, l) => err ? rej(err) : res(l)));
        return { content: [{ type: 'text', text: link }] };
      } catch (e) { return { content: [{ type: 'text', text: 'Erro: ' + e.message }] }; }
    }
  );

  s.tool('info_conta', 'Info da conta MEGA.', {},
    async () => {
      try {
        const st = await getStorage();
        return { content: [{ type: 'text', text: JSON.stringify({ usado_GB: (st.bytesUsed/1e9).toFixed(2), total_GB: (st.bytesTotal/1e9).toFixed(2) }, null, 2) }] };
      } catch (e) { return { content: [{ type: 'text', text: 'Erro: ' + e.message }] }; }
    }
  );

  return s;
}

const app = express();
app.use(express.json());

app.use('/mcp', (req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '') || req.query.apiKey;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const sessions = {};

app.post('/mcp', async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { sessions[sid] = transport; },
    });
    transport.onclose = () => { if (transport.sessionId) delete sessions[transport.sessionId]; };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('POST /mcp error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/mcp', async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];
    if (!sid || !sessions[sid]) return res.status(400).json({ error: 'Session invalida' });
    await sessions[sid].handleRequest(req, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.delete('/mcp', async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];
    if (sid && sessions[sid]) await sessions[sid].close();
  } catch (_) {}
  res.status(200).end();
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log('mega-mcp-server rodando na porta ' + PORT);
  console.log('Endpoint MCP: http://localhost:' + PORT + '/mcp');
});
