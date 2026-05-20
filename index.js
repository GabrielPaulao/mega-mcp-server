import 'dotenv/config';
import { Storage } from 'megajs';
import express from 'express';
import { authenticator } from 'otplib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (r) => console.error('Rejection:', r));

const MEGA_EMAIL       = process.env.MEGA_EMAIL;
const MEGA_PASSWORD    = process.env.MEGA_PASSWORD;
const MEGA_TOTP_SECRET = process.env.MEGA_TOTP_SECRET;
const PORT             = process.env.PORT || 3000;
const API_KEY          = process.env.MCP_API_KEY;

if (!MEGA_EMAIL || !MEGA_PASSWORD) { console.error('ERRO: sem credenciais MEGA'); process.exit(1); }

let _storage = null;

async function getStorage() {
  if (_storage) return _storage;

  const loginOpts = {
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
  };

  if (MEGA_TOTP_SECRET) {
    try {
      loginOpts.secondFactorCode = authenticator.generate(MEGA_TOTP_SECRET);
      console.log('TOTP code generated for 2FA login');
    } catch (e) {
      console.error('Failed to generate TOTP:', e.message);
    }
  }

  return new Promise((resolve, reject) => {
    const storage = new Storage(loginOpts);

    storage.on('ready', () => {
      _storage = storage;
      const count = Object.keys(storage.files || {}).length;
      console.log('MEGA ready, files:', count);
      resolve(storage);
    });

    storage.on('error', (err) => {
      console.error('MEGA storage error:', err.message);
      reject(err);
    });
  });
}

function createServer() {
  const server = new McpServer({
    name: 'mega-mcp-server',
    version: '1.0.0',
  });

  server.tool(
    'list_files',
    'Lista todos os arquivos e pastas no MEGA',
    {},
    async () => {
      const storage = await getStorage();
      const files = Object.values(storage.files || {}).map(f => ({
        name: f.name,
        size: f.size,
        type: f.directory ? 'folder' : 'file'
      }));
      return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
    }
  );

  server.tool(
    'get_file_link',
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

  server.tool(
    'upload_text',
    'Envia um arquivo de texto para o MEGA',
    {
      filename: z.string().describe('Nome do arquivo a criar'),
      content: z.string().describe('Conteudo do arquivo')
    },
    async ({ filename, content }) => {
      const storage = await getStorage();
      const buf = Buffer.from(content, 'utf8');
      await new Promise((res, rej) => {
        storage.upload({ name: filename, size: buf.length }, buf, (err) => err ? rej(err) : res());
      });
      return { content: [{ type: 'text', text: `Arquivo '${filename}' enviado com sucesso.` }] };
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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
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

app.get('/mcp', async (req, res) => {
  res.status(405).json({ error: 'Method not allowed. Use POST.' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`MCP server on port ${PORT}`));
