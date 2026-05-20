import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Storage } from 'megajs';
import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const MEGA_EMAIL    = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const PORT          = process.env.PORT || 3000;
const API_KEY       = process.env.MCP_API_KEY;

if (!MEGA_EMAIL || !MEGA_PASSWORD) {
  console.error('ERRO: Defina MEGA_EMAIL e MEGA_PASSWORD');
  process.exit(1);
}

let storageInstance = null;
let storageError    = null;

async function getMegaStorage() {
  if (storageInstance) return storageInstance;
  if (storageError) throw storageError;
  storageInstance = await new Promise((resolve, reject) => {
    const s = new Storage({ email: MEGA_EMAIL, password: MEGA_PASSWORD, userAgent: 'mega-mcp-server/1.0' });
    s.on('ready', () => resolve(s));
    s.on('error', (err) => {
      storageError = err;
      reject(err);
    });
  });
  return storageInstance;
}

function nodeToInfo(node) {
  return {
    id: node.nodeId,
    name: node.name,
    type: node.directory ? 'folder' : 'file',
    size: node.size || 0,
  };
}

async function findNodeByPath(storage, pathParts) {
  let current = storage.root;
  for (const part of pathParts) {
    if (!current.children) return null;
    current = current.children.find(n => n.name === part);
    if (!current) return null;
  }
  return current;
}

const server = new McpServer({ name: 'mega-mcp-server', version: '1.0.0' });

server.tool('listar_pasta',
  'Lista arquivos e pastas dentro de um caminho do MEGA. Use / para a raiz.',
  { caminho: z.string().describe('Caminho da pasta, ex: / ou /Fotos/2024') },
  async ({ caminho }) => {
    try {
      const storage = await getMegaStorage();
      let node;
      if (caminho === '/') {
        node = storage.root;
      } else {
        node = await findNodeByPath(storage, caminho.replace(/^\//, '').split('/'));
      }
      if (!node) return { content: [{ type: 'text', text: `Pasta nao encontrada: ${caminho}` }] };
      const items = (node.children || []).map(nodeToInfo);
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Erro: ${e.message}` }] };
    }
  }
);

server.tool('buscar_arquivo',
  'Busca arquivos no MEGA pelo nome.',
  { nome: z.string().describe('Nome ou parte do nome do arquivo') },
  async ({ nome }) => {
    try {
      const storage = await getMegaStorage();
      const lower = nome.toLowerCase();
      const resultados = Object.values(storage.files)
        .filter(n => n.name && n.name.toLowerCase().includes(lower))
        .map(nodeToInfo);
      return { content: [{ type: 'text', text: JSON.stringify(resultados, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Erro: ${e.message}` }] };
    }
  }
);

server.tool('criar_pasta',
  'Cria uma nova pasta no MEGA.',
  {
    caminho_pai: z.string().describe('Caminho da pasta pai, ex: / ou /Projetos'),
    nome: z.string().describe('Nome da nova pasta'),
  },
  async ({ caminho_pai, nome }) => {
    try {
      const storage = await getMegaStorage();
      const pai = caminho_pai === '/'
        ? storage.root
        : await findNodeByPath(storage, caminho_pai.replace(/^\//, '').split('/'));
      if (!pai) return { content: [{ type: 'text', text: `Pasta pai nao encontrada: ${caminho_pai}` }] };
      const nova = await new Promise((resolve, reject) =>
        pai.mkdir(nome, (err, f) => err ? reject(err) : resolve(f))
      );
      return { content: [{ type: 'text', text: `Pasta criada: ${nova.name} (id: ${nova.nodeId})` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Erro: ${e.message}` }] };
    }
  }
);

server.tool('gerar_link',
  'Gera link publico de compartilhamento para um arquivo no MEGA.',
  { caminho: z.string().describe('Caminho completo do arquivo, ex: /Fotos/imagem.jpg') },
  async ({ caminho }) => {
    try {
      const storage = await getMegaStorage();
      const node = await findNodeByPath(storage, caminho.replace(/^\//, '').split('/'));
      if (!node) return { content: [{ type: 'text', text: `Arquivo nao encontrado: ${caminho}` }] };
      const link = await new Promise((resolve, reject) =>
        node.link((err, l) => err ? reject(err) : resolve(l))
      );
      return { content: [{ type: 'text', text: link }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Erro: ${e.message}` }] };
    }
  }
);

server.tool('info_conta',
  'Retorna informacoes da conta MEGA (espaco usado e disponivel).',
  {},
  async () => {
    try {
      const storage = await getMegaStorage();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            espaco_usado_GB: (storage.bytesUsed / 1e9).toFixed(2),
            espaco_disponivel_GB: (storage.bytesTotal / 1e9).toFixed(2),
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Erro: ${e.message}` }] };
    }
  }
);

const app = express();
app.use(express.json());

app.use('/mcp', (req, res, next) => {
  if (!API_KEY) return next();
  const fromHeader = req.headers['x-api-key'];
  const fromBearer = (req.headers['authorization'] || '').replace('Bearer ', '');
  const fromQuery  = req.query.apiKey;
  const key = fromHeader || fromBearer || fromQuery;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const transports = {};

app.post('/mcp', async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => { transports[sessionId] = transport; },
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('POST /mcp error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId])
      return res.status(400).json({ error: 'Session invalida ou expirada' });
    await transports[sessionId].handleRequest(req, res);
  } catch (e) {
    console.error('GET /mcp error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.delete('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && transports[sessionId]) await transports[sessionId].close();
    res.status(200).end();
  } catch (e) {
    res.status(200).end();
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'mega-mcp-server' }));

app.listen(PORT, () => {
  console.log(`mega-mcp-server rodando na porta ${PORT}`);
  console.log(`Endpoint MCP: http://localhost:${PORT}/mcp`);
});
