import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Storage } from 'megajs';
import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// -------------------------------------------------------
// Configuracao - tudo via variaveis de ambiente (.env)
// -------------------------------------------------------
const MEGA_EMAIL    = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const PORT          = process.env.PORT || 3000;
const API_KEY       = process.env.MCP_API_KEY;

if (!MEGA_EMAIL || !MEGA_PASSWORD) {
  console.error('ERRO: Defina MEGA_EMAIL e MEGA_PASSWORD no arquivo .env');
  process.exit(1);
}

// -------------------------------------------------------
// Sessao MEGA (singleton reutilizado)
// -------------------------------------------------------
let storageInstance = null;

async function getMegaStorage() {
  if (storageInstance) return storageInstance;
  storageInstance = await new Promise((resolve, reject) => {
    const s = new Storage({ email: MEGA_EMAIL, password: MEGA_PASSWORD });
    s.on('ready', () => resolve(s));
    s.on('error', reject);
  });
  return storageInstance;
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
function nodeToInfo(node) {
  return {
    id:       node.nodeId,
    name:     node.name,
    type:     node.directory ? 'folder' : 'file',
    size:     node.size || 0,
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

// -------------------------------------------------------
// Servidor MCP
// -------------------------------------------------------
const server = new McpServer({
  name: 'mega-mcp-server',
  version: '1.0.0',
});

// --- listar_pasta ---
server.tool(
  'listar_pasta',
  'Lista arquivos e pastas dentro de um caminho do MEGA. Use / para a raiz.',
  { caminho: z.string().describe('Caminho da pasta, ex: / ou /Fotos/2024') },
  async ({ caminho }) => {
    const storage = await getMegaStorage();
    let node;
    if (caminho === '/') {
      node = storage.root;
    } else {
      const parts = caminho.replace(/^\//, '').split('/');
      node = await findNodeByPath(storage, parts);
    }
    if (!node) return { content: [{ type: 'text', text: `Pasta nao encontrada: ${caminho}` }] };
    const items = (node.children || []).map(nodeToInfo);
    return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
  }
);

// --- buscar_arquivo ---
server.tool(
  'buscar_arquivo',
  'Busca arquivos no MEGA pelo nome (parcial ou total).',
  { nome: z.string().describe('Nome ou parte do nome do arquivo') },
  async ({ nome }) => {
    const storage = await getMegaStorage();
    const lowerNome = nome.toLowerCase();
    const resultados = Object.values(storage.files)
      .filter(n => n.name && n.name.toLowerCase().includes(lowerNome))
      .map(nodeToInfo);
    return { content: [{ type: 'text', text: JSON.stringify(resultados, null, 2) }] };
  }
);

// --- criar_pasta ---
server.tool(
  'criar_pasta',
  'Cria uma nova pasta dentro de um caminho do MEGA.',
  {
    caminho_pai: z.string().describe('Caminho da pasta pai, ex: / ou /Projetos'),
    nome:        z.string().describe('Nome da nova pasta'),
  },
  async ({ caminho_pai, nome }) => {
    const storage = await getMegaStorage();
    let pai;
    if (caminho_pai === '/') {
      pai = storage.root;
    } else {
      const parts = caminho_pai.replace(/^\//, '').split('/');
      pai = await findNodeByPath(storage, parts);
    }
    if (!pai) return { content: [{ type: 'text', text: `Pasta pai nao encontrada: ${caminho_pai}` }] };
    const novasPasta = await new Promise((resolve, reject) =>
      pai.mkdir(nome, (err, f) => err ? reject(err) : resolve(f))
    );
    return { content: [{ type: 'text', text: `Pasta criada: ${novasPasta.name} (id: ${novasPasta.nodeId})` }] };
  }
);

// --- gerar_link ---
server.tool(
  'gerar_link',
  'Gera um link publico de compartilhamento para um arquivo ou pasta no MEGA.',
  { caminho: z.string().describe('Caminho completo do arquivo, ex: /Fotos/imagem.jpg') },
  async ({ caminho }) => {
    const storage = await getMegaStorage();
    const parts = caminho.replace(/^\//, '').split('/');
    const node = await findNodeByPath(storage, parts);
    if (!node) return { content: [{ type: 'text', text: `Arquivo nao encontrado: ${caminho}` }] };
    const link = await new Promise((resolve, reject) =>
      node.link((err, l) => err ? reject(err) : resolve(l))
    );
    return { content: [{ type: 'text', text: link }] };
  }
);

// --- info_conta ---
server.tool(
  'info_conta',
  'Retorna informacoes basicas da conta MEGA (espaco usado e disponivel).',
  {},
  async () => {
    const storage = await getMegaStorage();
    const info = {
      espaco_usado_GB:       (storage.bytesUsed  / 1e9).toFixed(2),
      espaco_disponivel_GB:  (storage.bytesTotal / 1e9).toFixed(2),
    };
    return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
  }
);

// -------------------------------------------------------
// Transporte HTTP
// -------------------------------------------------------
const app = express();
app.use(express.json());

// Middleware de autenticacao por API key (opcional mas recomendado)
app.use('/mcp', (req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const transports = {};

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => { transports[sessionId] = transport; },
  });
  transport.onclose = () => { delete transports[transport.sessionId]; };
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).json({ error: 'Session invalida ou expirada' });
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].close();
  }
  res.status(200).end();
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'mega-mcp-server' }));

app.listen(PORT, () => {
  console.log(`mega-mcp-server rodando na porta ${PORT}`);
  console.log(`Endpoint MCP: http://localhost:${PORT}/mcp`);
});
