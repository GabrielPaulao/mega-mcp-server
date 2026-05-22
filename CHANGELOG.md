# Changelog

Todas as mudanças notáveis neste projeto estão documentadas aqui.

---

## [v2.6.1] - 2026-05-22

### Corrigido
- **Reconexão MEGA após restart do Render** — `getStorage()` agora é chamado dentro do callback do `app.listen`, garantindo que o servidor HTTP está pronto antes de tentar autenticar no MEGA e eliminando a race condition que impedia a exibição do log `MEGA: sessao estabelecida` em reinicializações.
- **Erros de boot silenciosos** — falhas de login no boot agora são logadas explicitamente com a mensagem de erro completa (`MEGA: erro critico no boot: ...`), facilitando o diagnóstico.
- **Log de retry mais detalhado** — mensagem de erro e aviso de retentativa agora aparecem em linhas separadas, com número da tentativa e delay em segundos.

### Adicionado
- **Keep-alive interno** — após a sessão MEGA ser estabelecida no boot, um `setInterval` faz ping no próprio `/health` a cada **10 minutos**, mantendo o processo ativo no Render e evitando hibernações inesperadas. Log de confirmação: `Keep-alive ativo (ping a cada N min)`.

---

## [v2.6.0] - 2026-05-21

### Adicionado
- **`mega_search`** — ferramenta de busca que varre toda a árvore do MEGA (ou uma subpasta) por nome, com suporte a busca parcial e wildcards (`*`, `?`). Retorna caminhos completos prontos para uso nas demais ferramentas.
  - Parâmetros: `query`, `path?`, `tipo?` (`all` / `file` / `folder`), `limite?` (padrão 50, máx 200)
  - Suporte a globs simples: `*.pdf`, `relatorio*`, `foto_202?`
- **Reconexão automática com backoff exponencial** — login com até 5 tentativas e delays progressivos (5 s → 15 s → 30 s → 60 s → 120 s), seguido de ciclo de recuperação a cada 5 min após falha definitiva.
- **Detecção de sessão expirada por tempo** — sessões com mais de 4 horas são invalidadas proativamente.
- **Tratamento de erro de sessão em operações** — `withStorage()` detecta erros de sessão (`ESID`, `SID`, `-15`, `-16`, `access denied`) e reconecta automaticamente antes de retentar a operação.
- **Timeout de login configurável** — padrão de 120 s para tolerar boots lentos no Render.

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

---

## [v2.1.0] - 2026-05-21

### Adicionado
- **`mega_download_base64`** — baixa um arquivo binário do MEGA e retorna seu conteúdo em base64 para ser usado diretamente no chat
  - Suporte a qualquer formato (PDF, imagens, documentos)
  - Limite de 20 MB por arquivo
  - Detecção automática de MIME type pelo nome do arquivo

---

## [v2.0.0] - 2026-05-20

### Adicionado
Expansão massiva com 14 novas ferramentas inspiradas em comandos Unix:
- `mega_pwd`, `mega_cd`, `mega_df`, `mega_du`, `mega_mkdir`, `mega_rm`, `mega_mv`, `mega_cp`, `mega_cat`, `mega_get`, `mega_put`, `mega_export`, `mega_share`, `mega_import`

---

## [v1.0] - 2026-05-20

### Lançamento inicial
Servidor MCP para o MEGA com 3 ferramentas básicas:
- `list_files`, `get_file_link`, `upload_text`
