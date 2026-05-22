# 🗂️ MEGA MCP Server

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/Licença-MIT-blue?style=for-the-badge)
![MCP](https://img.shields.io/badge/Protocol-MCP-6366f1?style=for-the-badge)
![MEGA](https://img.shields.io/badge/Storage-MEGA.io-d9272e?style=for-the-badge&logo=mega&logoColor=white)
![Status](https://img.shields.io/badge/Status-Produção%20✅-22c55e?style=for-the-badge)
![Version](https://img.shields.io/badge/Versão-2.6.1-f59e0b?style=for-the-badge)

**Servidor [Model Context Protocol (MCP)](https://modelcontextprotocol.io) que conecta sua conta MEGA.io ao Perplexity — funcionando como um conector nativo, igual ao Google Drive e OneDrive.**

[🚀 Deploy Rápido](#-deploy-gratuito) · [📖 Documentação](#-ferramentas-disponíveis) · [🔌 Conectar ao Perplexity](#-conectando-ao-perplexity)

</div>

---

> ✅ **Conexão verificada em produção** — integração com o Perplexity funcionando plenamente em 22/05/2026. O servidor está rodando no Render e todas as 21 ferramentas MCP foram testadas com sucesso, incluindo leitura de PDFs do MEGA diretamente no chat.

---

## ✨ O que é isso?

Este projeto implementa um servidor compatível com o protocolo **MCP (Model Context Protocol)**, permitindo que o **Perplexity AI** acesse e gerencie arquivos da sua conta **MEGA.io** diretamente durante as conversas — sem precisar baixar nada manualmente.

Com ele você pode pedir ao Perplexity coisas como:
- *"Liste os arquivos da minha pasta Faculdade"*
- *"Qual o espaço disponível na minha conta MEGA?"*
- *"Gere um link público para o arquivo relatório.pdf"*
- *"Leia o conteúdo do arquivo notas.txt"*
- *"Busque todos os PDFs na pasta Trabalho"*
- *"Leia o PDF X e me faça um resumo"*

---

## 🛠️ Ferramentas disponíveis

| Ferramenta | Descrição | Parâmetros |
|---|---|---|
| `list_files` | Lista arquivos e pastas de um caminho | `path?` |
| `get_file_link` | Obtém link público de um arquivo pelo nome | `name` |
| `upload_text` | Envia um arquivo de texto para o MEGA | `filename`, `content`, `path?` |
| `mega_pwd` | Mostra o diretório raiz da conta | — |
| `mega_cd` | Navega para uma pasta e lista seu conteúdo | `path` |
| `mega_df` | Exibe espaço total e usado na conta | — |
| `mega_du` | Mostra o tamanho de um arquivo ou pasta | `path` |
| `mega_mkdir` | Cria uma nova pasta | `name`, `parent?` |
| `mega_rm` | Remove um arquivo ou pasta | `path` |
| `mega_mv` | Move ou renomeia um arquivo/pasta | `source`, `dest` |
| `mega_cp` | Copia um arquivo para outra pasta | `source`, `dest` |
| `mega_cat` | Lê o conteúdo de um arquivo de texto | `path` |
| `mega_get` | Gera link de download direto | `path` |
| `mega_put` | Faz upload de arquivo a partir de URL pública | `url`, `filename`, `path?` |
| `mega_export` | Cria link público de compartilhamento | `path`, `password?` |
| `mega_share` | Compartilha pasta com outro usuário MEGA | `path`, `email` |
| `mega_import` | Importa link público para sua conta | `link`, `path?` |
| `mega_download_base64` | Baixa arquivo binário em base64 (até 20 MB) | `path` |
| `mega_download_base64_chunk` | Baixa arquivo grande em chunks base64 (até 50 MB) | `path`, `chunk`, `chunk_size?` |
| `mega_search` | Busca arquivos/pastas por nome com wildcards | `query`, `path?`, `tipo?`, `limite?` |

> 💡 **21 ferramentas** disponíveis. O servidor reconecta automaticamente ao MEGA em caso de queda de sessão, com backoff exponencial e keep-alive interno.

---

## 📋 Pré-requisitos

- **Node.js** 18 ou superior
- **Conta MEGA** (qualquer plano, incluindo gratuito)
- **Perplexity Pro/Max/Enterprise** (para adicionar conectores personalizados)
- **Hospedagem com HTTPS** — Railway, Render, Fly.io, etc.

---

## ⚡ Instalação

```bash
# 1. Clone o repositório
git clone https://github.com/GabrielPaulao/mega-mcp-server.git
cd mega-mcp-server

# 2. Instale as dependências
npm install

# 3. Configure as variáveis de ambiente
cp .env.example .env
```

Edite o arquivo `.env` com suas credenciais:

```env
MEGA_EMAIL=seu-email@exemplo.com
MEGA_PASSWORD=sua-senha-do-mega
PORT=3000
MCP_API_KEY=chave-gerada-com-openssl-rand-hex-32
# Opcional — apenas se sua conta MEGA tiver 2FA ativado
# MEGA_TOTP_SECRET=sua-chave-totp
```

> ⚠️ **IMPORTANTE:** Nunca commite o arquivo `.env`. Ele já está protegido pelo `.gitignore`.

### Gerar a MCP_API_KEY

```bash
# Linux / macOS
openssl rand -hex 32

# Windows (PowerShell)
[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

### Rodar localmente

```bash
npm start
# Servidor disponível em: http://localhost:3000/mcp
```

---

## 🚀 Deploy Gratuito

### Render *(recomendado — testado em produção)*

1. Crie conta em [render.com](https://render.com)
2. **New** → **Web Service** → conecte este repositório
3. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Em **Environment Variables**, adicione `MEGA_EMAIL`, `MEGA_PASSWORD` e `MCP_API_KEY`
5. Clique em **Deploy** — URL HTTPS gerada automaticamente ✅

> 💡 O servidor inclui um **keep-alive interno** que faz ping a cada 10 minutos, evitando hibernações no plano gratuito do Render.

### Railway

1. Crie conta em [railway.app](https://railway.app)
2. **New Project** → **Deploy from GitHub repo**
3. Selecione este repositório
4. Em **Variables**, adicione as variáveis do `.env`
5. O Railway gera a URL HTTPS automaticamente ✅

### Fly.io

```bash
# Instale o flyctl e faça login
curl -L https://fly.io/install.sh | sh
fly auth login

# Deploy
fly launch
fly secrets set MEGA_EMAIL=... MEGA_PASSWORD=... MCP_API_KEY=...
fly deploy
```

---

## 🔌 Conectando ao Perplexity

1. Acesse o Perplexity e vá em **Configurações → Conectores**
2. Clique em **Adicionar conector personalizado**
3. Informe a URL: `https://sua-url.onrender.com/mcp`
4. Escolha **API Key** como método de autenticação
   - **Header:** `x-api-key`
   - **Valor:** o mesmo `MCP_API_KEY` do seu `.env`
5. Salve e pronto — o MEGA aparecerá como conector nativo 🎉

---

## 🏗️ Arquitetura

```
┌─────────────────┐        HTTPS/MCP       ┌──────────────────────┐
│  Perplexity AI  │ ◄────────────────────► │  mega-mcp-server     │
│  (cliente MCP)  │                        │  (Node.js + Express) │
└─────────────────┘                        └──────────┬───────────┘
                                                      │
                                                      │ megajs SDK
                                                      ▼
                                           ┌──────────────────────┐
                                           │     MEGA.io API      │
                                           │  (armazenamento)     │
                                           └──────────────────────┘
```

---

## 🔁 Resiliência & Reconexão

O servidor foi projetado para manter a sessão MEGA estável em ambientes de produção:

- **Retry com backoff exponencial** — até 5 tentativas com delays de 5 s, 15 s, 30 s, 60 s e 120 s
- **Ciclo de recuperação** — após falha definitiva, tenta reconectar a cada 5 minutos
- **Detecção de sessão expirada** — sessões com mais de 4 horas são invalidadas proativamente
- **Reconexão automática em operações** — erros de sessão durante o uso reconectam e retentam automaticamente
- **Keep-alive interno** — ping no `/health` a cada 10 minutos para manter o processo ativo
- **Endpoint `/health`** — retorna status da sessão, versão e tempo de conexão

---

## 🔒 Segurança

- ✅ Credenciais do MEGA ficam **somente no servidor**, nunca expostas ao Perplexity
- ✅ O endpoint `/mcp` é protegido por **API Key** em cada requisição
- ✅ O arquivo `.env` está bloqueado pelo `.gitignore`
- ✅ Nenhuma senha ou token é commitado no repositório
- ✅ Comunicação sempre via **HTTPS** em produção
- ✅ Suporte a **2FA (TOTP)** via `MEGA_TOTP_SECRET`

---

## 📦 Tecnologias utilizadas

| Pacote | Versão | Função |
|---|---|---|
| `megajs` | latest | SDK do MEGA.io |
| `@modelcontextprotocol/sdk` | latest | Implementação do protocolo MCP |
| `express` | latest | Servidor HTTP |
| `dotenv` | latest | Gerenciamento de variáveis de ambiente |
| `otplib` | latest | Geração de código TOTP para 2FA |
| `zod` | latest | Validação de parâmetros das ferramentas |

---

## 📄 Licença

Distribuído sob a licença **MIT**. Veja [`LICENSE`](LICENSE) para mais informações.

---

<div align="center">

Feito com ☁️ para integrar o MEGA ao ecossistema de IA

</div>
