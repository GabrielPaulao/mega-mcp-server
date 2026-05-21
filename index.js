import 'dotenv/config';
import { Storage } from 'megajs';
import express from 'express';
import { authenticator } from 'otplib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (r) => console.error('Rejection:', r));

const MEGA_EMAIL    = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const MEGA_TOTP_SECRET = process.env.MEGA_TOTP_SECRET;
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.MCP_API_KEY;

if (!MEGA_EMAIL || !MEGA_PASSWORD) { console.error('ERRO: sem credenciais MEGA'); process.exit(1); }

let _storage = null;
let _storagePromise = null;

function createStoragePromise() {
  const loginOpts = {
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
    keepalive: false,
  };
  if (MEGA_TOTP_SECRET) {
    try {
      loginOpts.secondFactorCode = authenticator.generate(MEGA_TOTP_SECRET);
    } catch (e) {
      console.error('TOTP error:', e.message);
    }
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MEGA login timeout after 45s')), 45000);
    const storage = new Storage(loginOpts);
    storage.on('ready', () => { clearTimeout(timeout); _storage = storage; resolve(storage); });
    storage.on('error', (err) => { clearTimeout(timeout); _storagePromise = null; reject(err); });
  });
}

async function getStorage() {
  if (_storage) return _storage;
  if (!_storagePromise) _storagePromise = createStoragePromise();
  return _storagePromise;
}

// Navega ate um no pelo path
function resolvePath(storage, path) {
  let target = storage.root;
  if (!path || !path.trim()) return target;
  const parts = path.trim().split('/').filter(Boolean);
  for (const part of parts) {
    const found = (target.children || []).find(c => c.name === part);
    if (!found) throw new Error(`Caminho nao encontrado: ${part}`);
    target = found;
  }
  return target;
}

// Calcula tamanho recursivo de um no
function calcSize(node) {
  if (!node.directory) return node.size || 0;
  return (node.children || []).reduce((acc, c) => acc + calcSize(c), 0);
}

// Detecta MIME type pelo nome do arquivo
function getMimeType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const mimeMap = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function createServer() {
  const server = new McpServer({ name: 'mega-mcp-server', version: '2.1.0' });

  // ── FERRAMENTAS ORIGINAIS ──────────────────────────────────────────────

  server.tool('list_files',
    'Lista arquivos e pastas no MEGA. Use path para navegar (ex: "" para raiz, "Filmes" para a pasta Filmes)',
    { path: z.string().optional().describe('Caminho da pasta (vazio = raiz)') },
    async ({ path }) => {
      const storage = await getStorage();
      const target = resolvePath(storage, path || '');
      const children = (target.children || []).map(f => ({
        name: f.name,
        type: f.directory ? 'folder' : 'file',
        size: f.size || 0,
        children_count: f.directory && f.children ? f.children.length : undefined,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ path: path || '/', total: children.length, items: children }, null, 2) }] };
    }
  );

  server.tool('get_file_link',
    'Obtem link publico de um arquivo no MEGA pelo nome',
    { name: z.string().describe('Nome do arquivo') },
    async ({ name }) => {
      const storage = await getStorage();
      const file = Object.values(storage.files || {}).find(f => f.name === name);
      if (!file) throw new Error(`Arquivo nao encontrado: ${name}`);
      const link = await new Promise((res, rej) => file.link((err, url) => err ? rej(err) : res(url)));
      return { content: [{ type: 'text', text: link }] };
    }
  );

  server.tool('upload_text',
    'Envia um arquivo de texto para o MEGA',
    {
      filename: z.string().describe('Nome do arquivo a criar'),
      content:  z.string().describe('Conteudo do arquivo'),
      path:     z.string().optional().describe('Pasta destino (vazio = raiz)'),
    },
    async ({ filename, content, path }) => {
      const storage = await getStorage();
      const folder = path ? resolvePath(storage, path) : storage.root;
      const buf = Buffer.from(content, 'utf8');
      await new Promise((res, rej) => {
        storage.upload({ name: filename, size: buf.length }, buf, (err) => err ? rej(err) : res());
      });
      return { content: [{ type: 'text', text: `Arquivo '${filename}' enviado com sucesso.` }] };
    }
  );

  // ── NOVAS FERRAMENTAS v2.0 ────────────────────────────────────────────

  // mega_pwd — mostra o caminho atual (sempre retorna raiz pois megajs nao tem estado de sessao)
  server.tool('mega_pwd',
    'Mostra o diretorio raiz do MEGA',
    {},
    async () => {
      await getStorage();
      return { content: [{ type: 'text', text: '/' }] };
    }
  );

  // mega_cd — navega e lista conteudo de um diretorio
  server.tool('mega_cd',
    'Navega para uma pasta e lista seu conteudo',
    { path: z.string().describe('Caminho da pasta (ex: "Filmes" ou "Filmes/Acao")') },
    async ({ path }) => {
      const storage = await getStorage();
      const target = resolvePath(storage, path);
      if (!target.directory) throw new Error('O caminho informado nao e uma pasta');
      const children = (target.children || []).map(f => ({
        name: f.name,
        type: f.directory ? 'folder' : 'file',
        size: f.size || 0,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ pwd: path, total: children.length, items: children }, null, 2) }] };
    }
  );

  // mega_df — espaco total e usado na conta
  server.tool('mega_df',
    'Mostra o espaco total e usado na conta MEGA',
    {},
    async () => {
      const storage = await getStorage();
      const bytesUsed = storage.bytesUsed || 0;
      const bytesTotal = storage.bytesTotal || 0;
      const gb = (b) => (b / 1073741824).toFixed(2) + ' GB';
      return { content: [{ type: 'text', text: JSON.stringify({ usado: gb(bytesUsed), total: gb(bytesTotal), livre: gb(bytesTotal - bytesUsed), bytes_usados: bytesUsed, bytes_total: bytesTotal }, null, 2) }] };
    }
  );

  // mega_du — tamanho de uma pasta ou arquivo
  server.tool('mega_du',
    'Mostra o tamanho de uma pasta ou arquivo no MEGA',
    { path: z.string().describe('Caminho do arquivo ou pasta') },
    async ({ path }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, path);
      const size = calcSize(node);
      const mb = (size / 1048576).toFixed(2);
      return { content: [{ type: 'text', text: JSON.stringify({ path, tipo: node.directory ? 'pasta' : 'arquivo', tamanho_bytes: size, tamanho_mb: mb + ' MB' }, null, 2) }] };
    }
  );

  // mega_mkdir — cria uma pasta
  server.tool('mega_mkdir',
    'Cria uma nova pasta no MEGA',
    {
      name:   z.string().describe('Nome da nova pasta'),
      parent: z.string().optional().describe('Pasta pai (vazio = raiz)'),
    },
    async ({ name, parent }) => {
      const storage = await getStorage();
      const parentNode = parent ? resolvePath(storage, parent) : storage.root;
      await new Promise((res, rej) => {
        parentNode.mkdir(name, (err, folder) => err ? rej(err) : res(folder));
      });
      const fullPath = parent ? `${parent}/${name}` : `/${name}`;
      return { content: [{ type: 'text', text: `Pasta '${fullPath}' criada com sucesso.` }] };
    }
  );

  // mega_rm — remove arquivo ou pasta
  server.tool('mega_rm',
    'Remove um arquivo ou pasta do MEGA',
    { path: z.string().describe('Caminho do arquivo ou pasta a remover') },
    async ({ path }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, path);
      await new Promise((res, rej) => {
        node.delete(false, (err) => err ? rej(err) : res());
      });
      return { content: [{ type: 'text', text: `'${path}' removido com sucesso.` }] };
    }
  );

  // mega_mv — move ou renomeia arquivo/pasta
  server.tool('mega_mv',
    'Move ou renomeia um arquivo ou pasta no MEGA',
    {
      source: z.string().describe('Caminho de origem'),
      dest:   z.string().describe('Novo caminho ou novo nome'),
    },
    async ({ source, dest }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, source);
      const destParts = dest.split('/');
      const newName = destParts.pop();
      const destParentPath = destParts.join('/');
      const destParent = destParentPath ? resolvePath(storage, destParentPath) : storage.root;
      await new Promise((res, rej) => node.moveTo(destParent, (err) => err ? rej(err) : res()));
      if (newName && newName !== node.name) {
        await new Promise((res, rej) => node.rename(newName, (err) => err ? rej(err) : res()));
      }
      return { content: [{ type: 'text', text: `Movido/renomeado de '${source}' para '${dest}'.` }] };
    }
  );

  // mega_cp — copia arquivo para outra pasta
  server.tool('mega_cp',
    'Copia um arquivo para outra pasta no MEGA',
    {
      source: z.string().describe('Caminho do arquivo de origem'),
      dest:   z.string().describe('Caminho da pasta destino'),
    },
    async ({ source, dest }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, source);
      const destNode = resolvePath(storage, dest);
      await new Promise((res, rej) => node.copyTo(destNode, (err) => err ? rej(err) : res()));
      return { content: [{ type: 'text', text: `Copiado '${source}' para '${dest}'.` }] };
    }
  );

  // mega_cat — le conteudo de um arquivo texto remoto
  server.tool('mega_cat',
    'Le o conteudo de um arquivo de texto armazenado no MEGA',
    { path: z.string().describe('Caminho do arquivo') },
    async ({ path }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, path);
      if (node.directory) throw new Error('O caminho informado e uma pasta, nao um arquivo');
      const data = await new Promise((res, rej) => {
        const chunks = [];
        const stream = node.download();
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', rej);
      });
      return { content: [{ type: 'text', text: data }] };
    }
  );

  // mega_get — gera link de download direto para um arquivo
  server.tool('mega_get',
    'Gera link de download direto para um arquivo no MEGA',
    { path: z.string().describe('Caminho do arquivo') },
    async ({ path }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, path);
      if (node.directory) throw new Error('O caminho informado e uma pasta');
      const link = await new Promise((res, rej) => node.link((err, url) => err ? rej(err) : res(url)));
      return { content: [{ type: 'text', text: JSON.stringify({ arquivo: node.name, tamanho_bytes: node.size, link_download: link }, null, 2) }] };
    }
  );

  // mega_put — upload de qualquer arquivo via URL externa (busca o arquivo de uma URL e sobe para o MEGA)
  server.tool('mega_put',
    'Faz upload de um arquivo para o MEGA a partir de uma URL publica',
    {
      url:      z.string().describe('URL publica do arquivo a fazer upload'),
      filename: z.string().describe('Nome do arquivo no MEGA'),
      path:     z.string().optional().describe('Pasta destino no MEGA (vazio = raiz)'),
    },
    async ({ url, filename, path }) => {
      const storage = await getStorage();
      const folder = path ? resolvePath(storage, path) : storage.root;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Erro ao baixar URL: ${resp.status} ${resp.statusText}`);
      const arrayBuf = await resp.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      await new Promise((res, rej) => {
        storage.upload({ name: filename, size: buf.length }, buf, (err) => err ? rej(err) : res());
      });
      return { content: [{ type: 'text', text: `Arquivo '${filename}' (${buf.length} bytes) enviado com sucesso para '${path || '/'}.'` }] };
    }
  );

  // mega_export — cria link publico com opcao de senha
  server.tool('mega_export',
    'Cria um link publico de compartilhamento para um arquivo ou pasta',
    {
      path:     z.string().describe('Caminho do arquivo ou pasta'),
      password: z.string().optional().describe('Senha para proteger o link (opcional)'),
    },
    async ({ path, password }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, path);
      const link = await new Promise((res, rej) => {
        if (password) {
          node.link({ noKey: false, password }, (err, url) => err ? rej(err) : res(url));
        } else {
          node.link((err, url) => err ? rej(err) : res(url));
        }
      });
      return { content: [{ type: 'text', text: JSON.stringify({ path, link, protegido_com_senha: !!password }, null, 2) }] };
    }
  );

  // mega_share — compartilha pasta com outro usuario MEGA
  server.tool('mega_share',
    'Compartilha uma pasta com outro usuario MEGA via email',
    {
      path:  z.string().describe('Caminho da pasta a compartilhar'),
      email: z.string().describe('Email do usuario MEGA a convidar'),
    },
    async ({ path, email }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, path);
      if (!node.directory) throw new Error('Somente pastas podem ser compartilhadas');
      await new Promise((res, rej) => {
        node.share({ user: email, access: 1 }, (err) => err ? rej(err) : res());
      });
      return { content: [{ type: 'text', text: `Pasta '${path}' compartilhada com ${email}.` }] };
    }
  );

  // mega_import — importa um link publico para a conta
  server.tool('mega_import',
    'Importa um link publico do MEGA para dentro da sua conta',
    {
      link:   z.string().describe('Link publico do MEGA a importar'),
      path:   z.string().optional().describe('Pasta destino (vazio = raiz)'),
    },
    async ({ link, path }) => {
      const storage = await getStorage();
      const destFolder = path ? resolvePath(storage, path) : storage.root;
      const imported = await new Promise((res, rej) => {
        storage.import(link, destFolder, (err, node) => err ? rej(err) : res(node));
      });
      return { content: [{ type: 'text', text: `Link importado com sucesso. Nome: '${imported.name}', Tamanho: ${imported.size || 0} bytes.` }] };
    }
  );

  // ── NOVA FERRAMENTA v2.1 ──────────────────────────────────────────────

  // mega_download_base64 — baixa um arquivo binario e retorna em base64 para ser anexado no chat
  server.tool('mega_download_base64',
    'Baixa um arquivo binario do MEGA e retorna seu conteudo em base64. Use para anexar PDFs, imagens e outros arquivos diretamente no chat.',
    { path: z.string().describe('Caminho completo do arquivo no MEGA (ex: "MegaSync/Faculdade/arquivo.pdf")') },
    async ({ path }) => {
      const storage = await getStorage();
      const node = resolvePath(storage, path);
      if (node.directory) throw new Error('O caminho informado e uma pasta, nao um arquivo');

      const MAX_SIZE = 20 * 1024 * 1024; // 20 MB limite
      if (node.size > MAX_SIZE) {
        throw new Error(`Arquivo muito grande (${(node.size / 1048576).toFixed(1)} MB). Limite: 20 MB. Use mega_get para obter o link de download.`);
      }

      const buf = await new Promise((res, rej) => {
        const chunks = [];
        const stream = node.download();
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => res(Buffer.concat(chunks)));
        stream.on('error', rej);
      });

      const base64 = buf.toString('base64');
      const mimeType = getMimeType(node.name);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              nome: node.name,
              tamanho_bytes: node.size,
              mime_type: mimeType,
              base64: base64,
            })
          }
        ]
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

function checkAuth(req, res) {
  if (!API_KEY) return true;
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${API_KEY}`) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
    }
  }
});

app.get('/mcp', (req, res) => res.status(405).json({ error: 'Method not allowed. Use POST.' }));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.1.0', tools: 17 }));

app.listen(PORT, () => console.log(`MCP server v2.1.0 rodando na porta ${PORT}`));
