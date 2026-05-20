import 'dotenv/config';
import { Storage } from 'megajs';
import express from 'express';
import { randomUUID } from 'crypto';
import { authenticator } from 'otplib';

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (r) => console.error('Rejection:', r));

const MEGA_EMAIL    = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const MEGA_TOTP_SECRET = process.env.MEGA_TOTP_SECRET;
const PORT         = process.env.PORT || 3000;
const API_KEY      = process.env.MCP_API_KEY;

if (!MEGA_EMAIL || !MEGA_PASSWORD) { console.error('ERRO: sem credenciais MEGA'); process.exit(1); }

let _storage = null;
let _storageErr = null;

async function getStorage() {
  if (_storage) return _storage;
  if (_storageErr) throw _storageErr;

  const loginOpts = {
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
    autologin: false,
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
    const storage = new Storage(loginOpts, (err) => {
      if (err) {
        _storageErr = err;
        console.error('MEGA login error:', err.message);
        reject(err);
      } else {
        _storage = storage;
        console.log('MEGA login OK, files:', Object.keys(storage.files || {}).length);
        resolve(storage);
      }
    });
  });
}

function checkAuth(req, res) {
  if (!API_KEY) return true;
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${API_KEY}`) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

const app = express();
app.use(express.json());

// MCP endpoint
app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const body = req.body;
  const id = body.id ?? null;

  // Handle batch
  if (Array.isArray(body)) {
    const results = await Promise.all(body.map(b => handleRpc(b)));
    return res.json(results);
  }

  const result = await handleRpc(body);
  res.json(result);
});

async function handleRpc(body) {
  const { method, params, id } = body;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'mega-mcp-server', version: '1.0.0' },
        capabilities: { tools: {} }
      }
    };
  }

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name: 'list_files',
            description: 'Lista todos os arquivos e pastas no MEGA',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'get_file_link',
            description: 'Obtem link publico de um arquivo no MEGA pelo nome',
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string', description: 'Nome do arquivo' } },
              required: ['name']
            }
          },
          {
            name: 'upload_text',
            description: 'Envia um arquivo de texto para o MEGA',
            inputSchema: {
              type: 'object',
              properties: {
                filename: { type: 'string', description: 'Nome do arquivo a criar' },
                content: { type: 'string', description: 'Conteudo do arquivo' }
              },
              required: ['filename', 'content']
            }
          }
        ]
      }
    };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    try {
      const storage = await getStorage();

      if (toolName === 'list_files') {
        const files = Object.values(storage.files || {}).map(f => ({
          name: f.name,
          size: f.size,
          type: f.directory ? 'folder' : 'file'
        }));
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] }
        };
      }

      if (toolName === 'get_file_link') {
        const name = toolArgs.name;
        const file = Object.values(storage.files || {}).find(f => f.name === name);
        if (!file) throw new Error(`Arquivo nao encontrado: ${name}`);
        const link = await new Promise((res, rej) => file.link((err, url) => err ? rej(err) : res(url)));
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: link }] }
        };
      }

      if (toolName === 'upload_text') {
        const { filename, content } = toolArgs;
        const buf = Buffer.from(content, 'utf8');
        await new Promise((res, rej) => {
          storage.upload({ name: filename, size: buf.length }, buf, (err) => err ? rej(err) : res());
        });
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: `Arquivo '${filename}' enviado com sucesso.` }] }
        };
      }

      throw new Error(`Ferramenta desconhecida: ${toolName}`);
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        error: { code: -32000, message: err.message }
      };
    }
  }

  return {
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`MCP server on port ${PORT}`));
