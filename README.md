# mega-mcp-server

Servidor MCP (Model Context Protocol) para conectar o **MEGA.io** ao **Perplexity** como conector personalizado, funcionando igual ao Google Drive e OneDrive nativos.

## Ferramentas disponíveis

| Ferramenta | O que faz |
|---|---|
| `listar_pasta` | Lista arquivos e pastas de um caminho do MEGA |
| `buscar_arquivo` | Busca arquivos pelo nome em toda a conta |
| `criar_pasta` | Cria uma nova pasta no MEGA |
| `gerar_link` | Gera link público de compartilhamento |
| `info_conta` | Mostra espaço usado e disponível na conta |

## Pré-requisitos

- Node.js 18 ou superior
- Conta MEGA (qualquer plano)
- Perplexity Pro/Max/Enterprise (para adicionar o conector)
- Hospedagem com HTTPS (Railway, Render, Fly.io, etc.)

## Instalação

```bash
# Clone o repositório
git clone https://github.com/GabrielPaulao/mega-mcp-server.git
cd mega-mcp-server

# Instale as dependências
npm install

# Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com seu email e senha do MEGA
```

## Configuração do .env

```env
MEGA_EMAIL=seu-email@exemplo.com
MEGA_PASSWORD=sua-senha-do-mega
PORT=3000
MCP_API_KEY=chave-gerada-com-openssl-rand-hex-32
```

> **IMPORTANTE:** Nunca commite o arquivo `.env` no GitHub. Ele já está no `.gitignore`.

## Rodando localmente

```bash
npm start
```

O servidor sobe em `http://localhost:3000/mcp`.

## Deploy (hospedagem gratuita)

### Railway
1. Crie conta em railway.app
2. New Project > Deploy from GitHub repo
3. Selecione este repositório
4. Em **Variables**, adicione as mesmas variáveis do `.env`
5. O Railway gera uma URL HTTPS automaticamente

### Render
1. Crie conta em render.com
2. New > Web Service > conecte este repositório
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Adicione as variáveis de ambiente no painel
6. O Render gera uma URL HTTPS automaticamente

## Conectando ao Perplexity

1. Abra o Perplexity e vá em **Configurações > Conectores**
2. Clique em **Adicionar conector personalizado**
3. Informe a URL do seu servidor: `https://sua-url.railway.app/mcp`
4. Escolha **API Key** como autenticação
5. Header: `x-api-key` / Valor: o mesmo `MCP_API_KEY` do seu `.env`
6. Salve e pronto

## Segurança

- Credenciais do MEGA ficam **somente no servidor**, nunca expostas ao Perplexity
- O endpoint `/mcp` é protegido por API Key
- O arquivo `.env` está bloqueado pelo `.gitignore`
- Nenhuma senha ou token é commitado no repositório

## Licença

MIT
