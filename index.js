import 'dotenv/config';
import { Storage } from 'megajs';
import express from 'express';
import { authenticator } from '@otplib/preset-default';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (r) => console.error('Rejection:', r));

const VERSION     = '2.8.0';
const TOOLS_COUNT = 21;

const MEGA_EMAIL       = process.env.MEGA_EMAIL;
const MEGA_PASSWORD    = process.env.MEGA_PASSWORD;
const MEGA_TOTP_SECRET = process.env.MEGA_TOTP_SECRET;
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.MCP_API_KEY;

if (!MEGA_EMAIL || !MEGA_PASSWORD) { console.error('ERRO: sem credenciais MEGA'); process.exit(1); }

let _storage        = null;
let _storagePromise = null;
let _lastLoginAt    = null;
let _retryTimer     = null;

const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const LOGIN_TIMEOUT_MS   = 120_000;
const MAX_RETRIES        = 5;
const RETRY_DELAYS_MS    = [5_000, 15_000, 30_000, 60_000, 120_000];

let _quotaBytes = { used: 0, total: 0 };

function attemptLogin() {
  const loginOpts = { email: MEGA_EMAIL, password: MEGA_PASSWORD, keepalive: false };
  if (MEGA_TOTP_SECRET) {
    try {
      loginOpts.secondFactorCode = authenticator.generate(MEGA_TOTP_SECRET);
      console.log('MEGA: TOTP gerado com sucesso');
    } catch (e) {
      console.error('TOTP error:', e.message);
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MEGA login timeout after ${LOGIN_TIMEOUT_MS / 1000}s`));
    }, LOGIN_TIMEOUT_MS);

    const storage = new Storage(loginOpts);

    storage.on('ready', async () => {
      clearTimeout(timer);
      _storage     = storage;
      _lastLoginAt = Date.now();

      // FIX mega_df: força reload para popular bytesUsed/bytesTotal
      try {
        await new Promise((res, rej) => {
          storage.reload(true, (err) => {
            if (err) { rej(err); return; }
            _quotaBytes.used  = storage.bytesUsed  || 0;
            _quotaBytes.total = storage.bytesTotal || 0;
            console.log(`MEGA: quota apos reload (usado: ${_quotaBytes.used}, total: ${_quotaBytes.total})`);
            res();
          });
        });
      } catch (reloadErr) {
        console.warn('MEGA: reload falhou, quota pode estar zerada:', reloadErr.message);
        _quotaBytes.used  = storage.bytesUsed  || 0;
        _quotaBytes.total = storage.bytesTotal || 0;
      }

      resolve(storage);
    });

    storage.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function loginWithRetry(attempt = 0) {
  _storagePromise = null; _storage = null;
  try {
    const storage = await attemptLogin();
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    return storage;
  } catch (err) {
    const nextAttempt = attempt + 1;
    console.error(`MEGA: falha no login (tentativa ${nextAttempt}/${MAX_RETRIES}): ${err.message}`);
    if (nextAttempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 120_000;
      console.error(`MEGA: retentando em ${delay / 1000}s...`);
      _storagePromise = new Promise((resolve) => {
        _retryTimer = setTimeout(async () => {
          _retryTimer = null;
          resolve(loginWithRetry(nextAttempt));
        }, delay);
      });
      return _storagePromise;
    }
    console.error(`MEGA: falha definitiva apos ${MAX_RETRIES} tentativas: ${err.message}`);
    _storagePromise = null;
    _retryTimer = setTimeout(() => {
      _retryTimer = null;
      console.log('MEGA: tentando reconectar (ciclo de recuperacao)...');
      _storagePromise = loginWithRetry(0);
    }, 5 * 60_000);
    throw err;
  }
}

async function isSessionAlive(storage) {
  try {
    if (!storage || !storage.root) return false;
    if (_lastLoginAt && (Date.now() - _lastLoginAt) > SESSION_MAX_AGE_MS) {
      console.log('MEGA: sessao expirou por tempo (>4h), reconectando...');
      return false;
    }
    return true;
  } catch { return false; }
}

async function getStorage() {
  if (_storage) {
    const alive = await isSessionAlive(_storage);
    if (!alive) {
      console.log('MEGA: sessao invalida, reconectando...');
      try { _storage.close?.(); } catch { /* ignora */ }
      _storage = null; _storagePromise = null; _lastLoginAt = null;
      _quotaBytes = { used: 0, total: 0 };
    }
  }
  if (!_storagePromise) _storagePromise = loginWithRetry(0);
  return _storagePromise;
}

async function withStorage(fn) {
  let storage = await getStorage();
  try {
    return await fn(storage);
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    const isSessionError =
      msg.includes('esid') || msg.includes('sid') || msg.includes('enoent') ||
      msg.includes('session') || msg.includes('access denied') ||
      msg.includes('-15') || msg.includes('-16');
    if (isSessionError) {
      console.log(`MEGA: erro de sessao ("${err.message}"), reconectando...`);
      try { _storage?.close?.(); } catch { /* ignora */ }
      _storage = null; _storagePromise = null; _lastLoginAt = null;
      _quotaBytes = { used: 0, total: 0 };
      storage = await getStorage();
      return await fn(storage);
    }
    throw err;
  }
}

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

function searchNodes(node, query, tipo, parentPath, results, limit) {
  if (results.length >= limit) return;
  const children = node.children || [];
  for (const child of children) {
    if (results.length >= limit) break;
    const childPath = parentPath ? `${parentPath}/${child.name}` : child.name;
    const isFolder  = !!child.directory;
    if (tipo === 'file' && isFolder) { /* pula */ }
    else if (tipo === 'folder' && !isFolder) { /* pula */ }
    else {
      const nameLC  = (child.name || '').toLowerCase();
      const queryLC = query.toLowerCase();
      const matched = queryLC.includes('*') || queryLC.includes('?')
        ? globMatch(nameLC, queryLC)
        : nameLC.includes(queryLC);
      if (matched) results.push({ nome: child.name, tipo: isFolder ? 'folder' : 'file', path: childPath, tamanho_bytes: isFolder ? null : (child.size || 0) });
    }
    if (isFolder) searchNodes(child, query, tipo, childPath, results, limit);
  }
}

function globMatch(str, pattern) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(str);
}

function calcSize(node) {
  if (!node.directory) return node.size || 0;
  return (node.children || []).reduce((acc, c) => acc + calcSize(c), 0);
}

function getMimeType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const mimeMap = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4',
    mp3: 'audio/mpeg', zip: 'application/zip', rar: 'application/x-rar-compressed',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', json: 'application/json', csv: 'text/csv',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

const _bufferCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
function setCacheBuffer(key, buf) { _bufferCache.set(key, { buf, ts: Date.now() }); }
function getCacheBuffer(key) {
  const entry = _bufferCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { _bufferCache.delete(key); return null; }
  return entry.buf;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of _bufferCache) if (now - e.ts > CACHE_TTL_MS) _bufferCache.delete(k); }, 5 * 60 * 1000);

function startKeepAlive() {
  const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;
  setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (!res.ok) console.warn('Keep-alive: resposta inesperada', res.status);
    } catch (e) {
      console.warn('Keep-alive: erro no ping:', e.message);
    }
  }, KEEP_ALIVE_INTERVAL_MS);
  console.log(`Keep-alive ativo (ping a cada ${KEEP_ALIVE_INTERVAL_MS / 60000} min)`);
}

const SHARE_ACCESS_LEVELS = {
  leitura:         0,
  leitura_escrita: 1,
  full:            2,
};

function buildMcpServer() {
  const server = new McpServer({ name: 'mega-mcp-server', version: VERSION });

  server.tool('list_files', 'Lista arquivos e pastas no MEGA. Use path para navegar (ex: "" para raiz, "Filmes" para a pasta Filmes)',
    { path: z.string().optional().describe('Caminho da pasta (vazio = raiz)') },
    async ({ path }) => withStorage(async (storage) => {
      const target = resolvePath(storage, path || '');
      const children = (target.children || []).map(f => ({ name: f.name, type: f.directory ? 'folder' : 'file', size: f.size || 0, children_count: f.directory && f.children ? f.children.length : undefined }));
      return { content: [{ type: 'text', text: JSON.stringify({ path: path || '/', total: children.length, items: children }, null, 2) }] };
    })
  );

  server.tool('get_file_link', 'Obtem link publico de um arquivo no MEGA pelo nome',
    { name: z.string().describe('Nome do arquivo') },
    async ({ name }) => withStorage(async (storage) => {
      const file = Object.values(storage.files || {}).find(f => f.name === name);
      if (!file) throw new Error(`Arquivo nao encontrado: ${name}`);
      const link = await new Promise((res, rej) => file.link((err, url) => err ? rej(err) : res(url)));
      return { content: [{ type: 'text', text: link }] };
    })
  );

  server.tool('upload_text', 'Envia um arquivo de texto para o MEGA',
    { filename: z.string().describe('Nome do arquivo a criar'), content: z.string().describe('Conteudo do arquivo'), path: z.string().optional().describe('Pasta destino (vazio = raiz)') },
    async ({ filename, content, path }) => withStorage(async (storage) => {
      const folder = path ? resolvePath(storage, path) : storage.root;
      const buf    = Buffer.from(content, 'utf8');
      await new Promise((res, rej) => folder.upload({ name: filename, size: buf.length }, buf, (err) => err ? rej(err) : res()));
      return { content: [{ type: 'text', text: `Arquivo '${filename}' enviado com sucesso para '${path || '/'}'.` }] };
    })
  );

  server.tool('mega_pwd', 'Mostra o diretorio raiz e informacoes basicas da conta MEGA', {},
    async () => withStorage(async (storage) => {
      const rootChildren = (storage.root.children || []).length;
      return { content: [{ type: 'text', text: JSON.stringify({
        diretorio_raiz: '/',
        total_itens_raiz: rootChildren,
        email: MEGA_EMAIL,
        sessao: 'conectada',
      }, null, 2) }] };
    })
  );

  server.tool('mega_cd', 'Navega para uma pasta e lista seu conteudo',
    { path: z.string().describe('Caminho da pasta (ex: "Filmes" ou "Filmes/Acao")') },
    async ({ path }) => withStorage(async (storage) => {
      const target = resolvePath(storage, path);
      if (!target.directory) throw new Error('O caminho informado nao e uma pasta');
      const children = (target.children || []).map(f => ({ name: f.name, type: f.directory ? 'folder' : 'file', size: f.size || 0 }));
      return { content: [{ type: 'text', text: JSON.stringify({ pwd: path, total: children.length, items: children }, null, 2) }] };
    })
  );

  server.tool('mega_df', 'Mostra o espaco total e usado na conta MEGA', {},
    async () => withStorage(async (storage) => {
      const bytesUsed  = _quotaBytes.used  || storage.bytesUsed  || 0;
      const bytesTotal = _quotaBytes.total || storage.bytesTotal || 0;
      const gb = (b) => (b / 1073741824).toFixed(2) + ' GB';
      const aviso = bytesTotal === 0
        ? 'Quota nao disponivel ainda — tente novamente em alguns segundos.'
        : undefined;
      return { content: [{ type: 'text', text: JSON.stringify({
        usado:        gb(bytesUsed),
        total:        gb(bytesTotal),
        livre:        gb(bytesTotal - bytesUsed),
        bytes_usados: bytesUsed,
        bytes_total:  bytesTotal,
        ...(aviso && { aviso }),
      }, null, 2) }] };
    })
  );

  server.tool('mega_du', 'Mostra o tamanho de uma pasta ou arquivo no MEGA',
    { path: z.string().describe('Caminho do arquivo ou pasta') },
    async ({ path }) => withStorage(async (storage) => {
      const node = resolvePath(storage, path), size = calcSize(node);
      return { content: [{ type: 'text', text: JSON.stringify({ path, tipo: node.directory ? 'pasta' : 'arquivo', tamanho_bytes: size, tamanho_mb: (size / 1048576).toFixed(2) + ' MB' }, null, 2) }] };
    })
  );

  server.tool('mega_mkdir', 'Cria uma nova pasta no MEGA',
    { name: z.string().describe('Nome da nova pasta'), parent: z.string().optional().describe('Pasta pai (vazio = raiz)') },
    async ({ name, parent }) => withStorage(async (storage) => {
      const parentNode = parent ? resolvePath(storage, parent) : storage.root;
      await new Promise((res, rej) => parentNode.mkdir(name, (err, folder) => err ? rej(err) : res(folder)));
      return { content: [{ type: 'text', text: `Pasta '${parent ? `${parent}/${name}` : `/${name}`}' criada com sucesso.` }] };
    })
  );

  server.tool('mega_rm', 'Remove um arquivo ou pasta do MEGA',
    { path: z.string().describe('Caminho do arquivo ou pasta a remover') },
    async ({ path }) => withStorage(async (storage) => {
      const node = resolvePath(storage, path);
      await new Promise((res, rej) => node.delete(false, (err) => err ? rej(err) : res()));
      return { content: [{ type: 'text', text: `'${path}' removido com sucesso.` }] };
    })
  );

  server.tool('mega_mv', 'Move ou renomeia um arquivo ou pasta no MEGA',
    { source: z.string().describe('Caminho de origem'), dest: z.string().describe('Novo caminho ou novo nome') },
    async ({ source, dest }) => withStorage(async (storage) => {
      const node = resolvePath(storage, source);
      const destParts = dest.split('/'), newName = destParts.pop();
      const destParent = destParts.length ? resolvePath(storage, destParts.join('/')) : storage.root;
      await new Promise((res, rej) => node.moveTo(destParent, (err) => err ? rej(err) : res()));
      if (newName && newName !== node.name)
        await new Promise((res, rej) => node.rename(newName, (err) => err ? rej(err) : res()));
      return { content: [{ type: 'text', text: `Movido/renomeado de '${source}' para '${dest}'.` }] };
    })
  );

  server.tool('mega_cp', 'Copia um arquivo para outra pasta no MEGA',
    { source: z.string().describe('Caminho do arquivo de origem'), dest: z.string().describe('Caminho da pasta destino') },
    async ({ source, dest }) => withStorage(async (storage) => {
      const node = resolvePath(storage, source), destNode = resolvePath(storage, dest);
      await new Promise((res, rej) => node.copyTo(destNode, (err) => err ? rej(err) : res()));
      return { content: [{ type: 'text', text: `Copiado '${source}' para '${dest}'.` }] };
    })
  );

  const MEGA_CAT_MAX_MB = 10;
  server.tool('mega_cat', 'Le o conteudo de um arquivo de texto armazenado no MEGA',
    { path: z.string().describe('Caminho do arquivo') },
    async ({ path }) => withStorage(async (storage) => {
      const node = resolvePath(storage, path);
      if (node.directory) throw new Error('O caminho informado e uma pasta, nao um arquivo');
      if (node.size > MEGA_CAT_MAX_MB * 1024 * 1024)
        throw new Error(`Arquivo muito grande para mega_cat (${(node.size / 1048576).toFixed(1)} MB). Limite: ${MEGA_CAT_MAX_MB} MB. Use mega_download_base64_chunk para arquivos grandes.`);
      const data = await new Promise((res, rej) => {
        const chunks = [], stream = node.download();
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', rej);
      });
      return { content: [{ type: 'text', text: data }] };
    })
  );

  server.tool('mega_get', 'Gera link de download direto para um arquivo no MEGA',
    { path: z.string().describe('Caminho do arquivo') },
    async ({ path }) => withStorage(async (storage) => {
      const node = resolvePath(storage, path);
      if (node.directory) throw new Error('O caminho informado e uma pasta');
      const link = await new Promise((res, rej) => node.link((err, url) => err ? rej(err) : res(url)));
      return { content: [{ type: 'text', text: JSON.stringify({ arquivo: node.name, tamanho_bytes: node.size, link_download: link }, null, 2) }] };
    })
  );

  server.tool('mega_put', 'Faz upload de um arquivo para o MEGA a partir de uma URL publica',
    { url: z.string().describe('URL publica do arquivo a fazer upload'), filename: z.string().describe('Nome do arquivo no MEGA'), path: z.string().optional().describe('Pasta destino no MEGA (vazio = raiz)') },
    async ({ url, filename, path }) => withStorage(async (storage) => {
      const folder = path ? resolvePath(storage, path) : storage.root;
      const resp   = await fetch(url);
      if (!resp.ok) throw new Error(`Erro ao baixar URL: ${resp.status} ${resp.statusText}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      await new Promise((res, rej) => folder.upload({ name: filename, size: buf.length }, buf, (err) => err ? rej(err) : res()));
      return { content: [{ type: 'text', text: `Arquivo '${filename}' (${buf.length} bytes) enviado com sucesso para '${path || '/'}'.` }] };
    })
  );

  server.tool('mega_export', 'Cria um link publico de compartilhamento para um arquivo ou pasta',
    { path: z.string().describe('Caminho do arquivo ou pasta'), password: z.string().optional().describe('Senha para proteger o link (opcional)') },
    async ({ path, password }) => withStorage(async (storage) => {
      const node = resolvePath(storage, path);
      const link = await new Promise((res, rej) => {
        if (password) node.link({ noKey: false, password }, (err, url) => err ? rej(err) : res(url));
        else          node.link((err, url) => err ? rej(err) : res(url));
      });
      return { content: [{ type: 'text', text: JSON.stringify({ path, link, protegido_com_senha: !!password }, null, 2) }] };
    })
  );

  server.tool('mega_share', 'Compartilha uma pasta com outro usuario MEGA via email',
    {
      path:   z.string().describe('Caminho da pasta a compartilhar'),
      email:  z.string().describe('Email do usuario MEGA a convidar'),
      acesso: z.enum(['leitura', 'leitura_escrita', 'full']).optional()
               .describe('Nivel de acesso: leitura (0), leitura_escrita (1, padrao) ou full (2)'),
    },
    async ({ path, email, acesso }) => withStorage(async (storage) => {
      const node = resolvePath(storage, path);
      if (!node.directory) throw new Error('Somente pastas podem ser compartilhadas');
      const accessLevel = SHARE_ACCESS_LEVELS[acesso ?? 'leitura_escrita'];
      await new Promise((res, rej) => node.share({ user: email, access: accessLevel }, (err) => err ? rej(err) : res()));
      return { content: [{ type: 'text', text: `Pasta '${path}' compartilhada com ${email} (acesso: ${acesso ?? 'leitura_escrita'}).` }] };
    })
  );

  server.tool('mega_import', 'Importa um link publico do MEGA para dentro da sua conta',
    { link: z.string().describe('Link publico do MEGA a importar'), path: z.string().optional().describe('Pasta destino (vazio = raiz)') },
    async ({ link, path }) => withStorage(async (storage) => {
      const destFolder = path ? resolvePath(storage, path) : storage.root;
      const imported   = await new Promise((res, rej) => storage.import(link, destFolder, (err, node) => err ? rej(err) : res(node)));
      return { content: [{ type: 'text', text: `Link importado com sucesso. Nome: '${imported.name}', Tamanho: ${imported.size || 0} bytes.` }] };
    })
  );

  server.tool('mega_download_base64',
    'Baixa um arquivo binario do MEGA e retorna seu conteudo em base64. Use para anexar PDFs, imagens e outros arquivos diretamente no chat.',
    { path: z.string().describe('Caminho completo do arquivo no MEGA (ex: "MegaSync/Faculdade/arquivo.pdf")') },
    async ({ path }) => withStorage(async (storage) => {
      const node = resolvePath(storage, path);
      if (node.directory) throw new Error('O caminho informado e uma pasta, nao um arquivo');
      if (node.size > 20 * 1024 * 1024) throw new Error(`Arquivo muito grande (${(node.size / 1048576).toFixed(1)} MB). Limite: 20 MB. Use mega_get para obter o link de download.`);
      const buf = await new Promise((res, rej) => {
        const chunks = [], stream = node.download();
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => res(Buffer.concat(chunks)));
        stream.on('error', rej);
      });
      return { content: [{ type: 'text', text: JSON.stringify({ nome: node.name, tamanho_bytes: node.size, mime_type: getMimeType(node.name), base64: buf.toString('base64') }) }] };
    })
  );

  server.tool('mega_download_base64_chunk',
    'Baixa um arquivo do MEGA em chunks de base64. Permite ler arquivos de qualquer tamanho sem truncamento. Use chunk=0 para comecar — a resposta inclui total_chunks para saber quantas chamadas fazer. Concatene os campos base64_chunk de cada resposta em ordem para montar o arquivo completo.',
    {
      path:       z.string().describe('Caminho completo do arquivo no MEGA (ex: "MegaSync/Faculdade/arquivo.pdf")'),
      chunk:      z.number().int().min(0).describe('Indice do chunk a retornar (comeca em 0)'),
      chunk_size: z.number().int().min(1024).max(200000).optional().describe('Tamanho de cada chunk em bytes de base64 (padrao: 50000 ~= 37KB de dados binarios). Max: 200000.'),
    },
    async ({ path, chunk, chunk_size }) => {
      const CHUNK_SIZE = chunk_size || 50000;
      return withStorage(async (storage) => {
        const node = resolvePath(storage, path);
        if (node.directory) throw new Error('O caminho informado e uma pasta, nao um arquivo');
        if (node.size > 50 * 1024 * 1024) throw new Error(`Arquivo muito grande (${(node.size / 1048576).toFixed(1)} MB). Limite: 50 MB.`);
        let buf = getCacheBuffer(path);
        if (!buf) {
          buf = await new Promise((res, rej) => {
            const chunks = [], stream = node.download();
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => res(Buffer.concat(chunks)));
            stream.on('error', rej);
          });
          setCacheBuffer(path, buf);
        }
        const fullBase64  = buf.toString('base64');
        const totalChunks = Math.ceil(fullBase64.length / CHUNK_SIZE);
        if (chunk >= totalChunks) throw new Error(`Chunk ${chunk} fora do intervalo. Total de chunks: ${totalChunks} (0 a ${totalChunks - 1}).`);
        const start = chunk * CHUNK_SIZE, end = Math.min(start + CHUNK_SIZE, fullBase64.length);
        return { content: [{ type: 'text', text: JSON.stringify({ nome: node.name, mime_type: getMimeType(node.name), tamanho_bytes: node.size, chunk_atual: chunk, total_chunks: totalChunks, chunk_size: CHUNK_SIZE, base64_total_chars: fullBase64.length, base64_chunk: fullBase64.slice(start, end), concluido: chunk === totalChunks - 1 }) }] };
      });
    }
  );

  server.tool('mega_search',
    'Busca arquivos e pastas por nome em toda a arvore do MEGA (ou dentro de uma pasta especifica). Suporta busca parcial (ex: "relatorio") e glob simples (ex: "*.pdf", "foto_202?"). Retorna o caminho completo de cada resultado para uso direto nas outras ferramentas.',
    {
      query:  z.string().describe('Texto a buscar no nome do arquivo/pasta. Suporta * e ? como wildcards (ex: "*.pdf", "relatorio*", "foto_202?")'),
      path:   z.string().optional().describe('Pasta raiz da busca (vazio = busca em todo o MEGA)'),
      tipo:   z.enum(['all', 'file', 'folder']).optional().describe('Filtrar por tipo: all (padrao), file (apenas arquivos), folder (apenas pastas)'),
      limite: z.number().int().min(1).max(200).optional().describe('Numero maximo de resultados (padrao: 50, max: 200)'),
    },
    async ({ query, path, tipo, limite }) => {
      if (!query || !query.trim()) throw new Error('O parametro query nao pode ser vazio');
      const limit = limite || 50, filter = tipo || 'all';
      return withStorage(async (storage) => {
        const root = path ? resolvePath(storage, path) : storage.root;
        const results = [];
        searchNodes(root, query.trim(), filter, path || '', results, limit);
        const truncated = results.length >= limit;
        return { content: [{ type: 'text', text: JSON.stringify({ query, busca_em: path || '/', tipo_filtro: filter, total: results.length, truncado: truncated, aviso: truncated ? `Resultado limitado a ${limit} itens. Use o parametro 'limite' ou refine a busca.` : undefined, resultados: results }, null, 2) }] };
      });
    }
  );

  return server;
}

const mcpServer = buildMcpServer();

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
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err.message);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
  }
});

app.get('/mcp', (req, res) => res.status(405).json({ error: 'Method not allowed. Use POST.' }));

app.get('/health', (req, res) => {
  const sessionAge = _lastLoginAt ? Math.round((Date.now() - _lastLoginAt) / 1000 / 60) : null;
  res.json({
    status:              'ok',
    version:             VERSION,
    tools:               TOOLS_COUNT,
    mega_session:        _storage ? 'connected' : 'disconnected',
    session_age_minutes: sessionAge,
    retry_pending:       !!_retryTimer,
    quota_bytes_used:    _quotaBytes.used,
    quota_bytes_total:   _quotaBytes.total,
  });
});

console.log(`MCP server v${VERSION} rodando na porta ${PORT}`);
app.listen(PORT, () => {
  getStorage()
    .then(() => startKeepAlive())
    .catch((err) => {
      console.error('MEGA: erro critico no boot:', err.message);
      startKeepAlive();
    });
});
