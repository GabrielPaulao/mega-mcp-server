# Changelog

Todas as mudanças notáveis neste projeto estão documentadas aqui.

---

## [v2.2.0] - 2026-05-21

### Adicionado
- **`mega_download_base64_chunk`** — nova ferramenta que baixa arquivos do MEGA em pedaços (chunks) de base64, permitindo trabalhar com arquivos de **qualquer tamanho** sem truncamento no chat.
  - Parâmetros: `path`, `chunk` (índice, começa em 0), `chunk_size` (opcional, padrão 50.000 chars ~37KB de dados)
  - O arquivo é baixado do MEGA **uma única vez** e fica em **cache por 10 minutos** — chamadas subsequentes para o mesmo `path` reutilizam o cache automaticamente
  - A resposta inclui `total_chunks` para saber quantas chamadas são necessárias
  - Suporta arquivos de até **50 MB**
  - Funciona com **qualquer formato de arquivo** (PDF, imagem, ZIP, DOCX, XLSX, etc.)
- **Cache em memória** com TTL de 10 minutos e purge automático a cada 5 minutos

### Fluxo de uso do chunk
```
chunk=0 → retorna base64_chunk + total_chunks (ex: 8)
chunk=1 → retorna base64_chunk
...
chunk=7 → retorna base64_chunk + concluido: true

Concatenar todos os base64_chunk em ordem → decodificar base64 → arquivo completo
```

### Endpoint de saúde
- `GET /health` agora retorna `version: "2.2.0"` e `tools: 18`

---

## [v2.1.0] - 2026-05-21

### Adicionado
- **`mega_download_base64`** — baixa um arquivo binário do MEGA e retorna seu conteúdo em base64 para ser usado diretamente no chat
  - Suporta qualquer formato (PDF, imagens, documentos)
  - Limite de 20 MB por arquivo
  - Detecta MIME type automaticamente pelo nome do arquivo
- **`getMimeType()`** — função auxiliar para detecção de MIME type por extensão

### Endpoint de saúde
- `GET /health` retorna `version: "2.1.0"` e `tools: 17`

---

## [v2.0.0] - 2026-05-20

### Adicionado
Expansão massiva com 14 novas ferramentas inspiradas em comandos Unix:
- `mega_pwd` — mostra o diretório raiz
- `mega_cd` — navega e lista conteúdo de uma pasta
- `mega_df` — espaço total e usado na conta
- `mega_du` — tamanho de arquivo ou pasta
- `mega_mkdir` — cria pasta
- `mega_rm` — remove arquivo ou pasta
- `mega_mv` — move ou renomeia
- `mega_cp` — copia arquivo para outra pasta
- `mega_cat` — lê conteúdo de arquivo de texto
- `mega_get` — gera link de download direto
- `mega_put` — upload via URL pública
- `mega_export` — cria link público (com suporte a senha)
- `mega_share` — compartilha pasta com outro usuário MEGA
- `mega_import` — importa link público para a conta

---

## [v1.0] - 2026-05-20

### Lançamento inicial
Servidor MCP para o MEGA com 3 ferramentas básicas:
- `list_files` — lista arquivos e pastas
- `get_file_link` — obtém link público de um arquivo
- `upload_text` — envia arquivos de texto
