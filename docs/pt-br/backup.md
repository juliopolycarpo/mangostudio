# Backup portátil dos dados do usuário

Pare o Hub (`mangostudio stop`) e os editores, runtimes e ferramentas externas que escrevem
nos dados configurados. Execute em um diretório privado:

```sh
mangostudio backup /destino/privado/dados.tar.gz
mangostudio backup /destino/privado/dados.tar.gz --no-checkpoints
```

Esta versão define o schema 1 do arquivo. Não existe comando de restore; não extraia o
arquivo sobre uma instalação em execução. O backup resolve os caminhos configurados do
banco, uploads, imagens geradas, avatares, agentes, skills e checkpoints. Checkpoints são
incluídos por padrão. Perfis, preferências e histórico estão no banco. Raízes opcionais
ausentes são registradas; locais ilegíveis, links, arquivos especiais, nomes não portáteis
ou colisões de nomes interrompem a captura inteira, assim como arquivos com mais de um
hard link. Links simbólicos na própria raiz configurada são recusados mesmo quando o
destino não existe. As raízes configuradas não podem se sobrepor, mesmo quando os
checkpoints são omitidos. O destino deve ficar fora dessas raízes e em um sistema de
arquivos que aceite hard links. A captura recusa destinos existentes antes de preparar
os arquivos. Configure caminhos explícitos sem componentes `..`. Remover `..` após
um link intermediário pode selecionar um diretório diferente do que a aplicação lê.

## Consistência e privacidade

A inicialização do Hub e a captura usam a mesma trava SQLite exclusiva ao lado do banco.
O sistema libera a posse se o processo morrer; nunca remova o banco de trava enquanto
algum processo puder usá-lo. O banco e o arquivo de trava precisam ser arquivos regulares
com um único link. Um Hub antigo ativo também é recusado pelo arquivo de estado. Ao
encerrar, o Hub aguarda as gerações aceitas terminarem antes de liberar a trava. Se o
prazo de encerramento se esgotar, o Hub sai com erro e o sistema libera a trava na saída.
Durante a cópia, uma reserva de escrita SQLite impede alterações no banco. O snapshot inclui
as páginas confirmadas do WAL. Com o Hub parado, não há escritas de mídia da aplicação.
Identidade, tamanho e timestamps dos arquivos e diretórios são comparados antes de publicar;
qualquer alteração observada provoca falha. Escritores externos devem estar parados: isso
não é um snapshot global do sistema de arquivos nem proteção contra editores concorrentes
hostis. Workspaces remotos e arquivos fora das raízes configuradas ficam de fora.

config.toml bruto, .env, chaveiros do sistema e credenciais de fornecedores nunca são
copiados. O config portátil contém somente schema e mapeamento das raízes por padrão.
A cópia privada do banco mantém histórico, usuários, referências de mídia, perfis e
preferências da aplicação, skills habilitadas, tarefas, checkpoints e identidades de
ferramentas. Ambientes e MCP preservam apenas metadados desabilitados, sem parâmetros,
variáveis, URLs ou configuração de transporte. Overrides de providers, ferramentas e
agentes são omitidos conservadoramente. Credenciais de contas, hashes de senha, sessões,
verificações, chaves de API, tokens de pareamento, metadados de segredos, continuidade de
providers, auditoria, instalações e linhas de tabelas desconhecidas são removidos. A
redaction e o vacuum alteram somente a cópia privada. O ledger de migrações permanece;
a futura restauração deve validar sua compatibilidade. Os registros de operações mantêm
seus IDs e resultados finais para preservar as referências das preferências. A captura
remove as cópias privadas dos resultados e marca operações aceitas ou em execução como
não resolvidas.

A leitura exclui nomes conhecidos de credenciais, tokens, segredos, variantes .env,
formatos de chaves privadas, identidades SSH, .git, node_modules, caches, logs, audit e run.
Também ficam de fora os caminhos resolvidos de segredos gerenciados e os arquivos
temporários das gravações atômicas de segredos.
O conteúdo do usuário restante é copiado literalmente: conversas, uploads, skills e
checkpoints podem conter segredos inseridos pelo usuário. A política exclui credenciais
gerenciadas pela aplicação; ela não identifica segredos arbitrários em texto ou binários.
Proteja e inspecione o arquivo.

```sh
mangostudio backup /destino/privado/dados.tar.gz --include-secrets
```

A opção avisa e exporta **somente o segredo de autenticação resolvido do Hub**, identificado
como `hub-auth-secret` no manifesto. Chaveiros, conectores e credenciais gerenciadas por
fornecedores continuam excluídos. Ambientes e conectores exigem reautorização após recuperar;
metadados não garantem conexão em outra máquina.

## Formato, limites e resultados

O tar gzip contém membros regulares manifest.json, database.sqlite, config.json e arquivos
sob IDs de raízes. O manifesto schema-first registra versões, data, modo de consistência,
origens configuradas, exclusões, opções e SHA-256/tamanho de cada membro de dados. Hashes
não estabelecem confiança. A futura restauração deverá validar caminhos, tipos e limites.

Limites: 10.000 entradas lidas, 10.000 membros de dados, 32 MiB por arquivo (incluindo banco),
128 MiB de dados expandidos, 140 MiB comprimidos e profundidade 32. A compressão usa gzip
nível 6. Nomes reservados do Windows, caracteres proibidos, pontos/espaços finais e colisões
de caixa/Unicode são recusados. O staging fica ao lado do destino, com diretório 0700 e
arquivos 0600 em POSIX. No Windows, whoami resolve o SID do usuário e icacls remove grants herdados e concede acesso
somente a esse usuário antes de copiar dados. Se isso falhar, a captura é recusada. Use também
um diretório de destino privado. Tamanho, permissões e sincronização do arquivo usam o mesmo
descritor aberto. Quando O_NOFOLLOW é suportado, um link simbólico substituído é recusado.
O hard link final ainda usa um nome dentro do staging privado: a proteção impede alterações
por outras contas sem privilégios, não por um processo hostil executado como o mesmo usuário.
Cancelamentos
são observados entre operações limitadas; uma operação SQLite/compressão em curso termina
antes da observação do cancelamento.

O arquivo é sincronizado e publicado por hard link atômico exclusivo. Falhas e
cancelamentos antes da publicação não deixam arquivo no destino. Após a criação do link,
um cancelamento preserva o arquivo completo e uma falha na limpeza gera um aviso. Uma
interrupção ou falha na limpeza pode deixar o staging privado `.mango-backup-*`. Remova-o
após confirmar que o processo parou. Uma interrupção após a publicação pode deixar um
arquivo completo sem mensagem de sucesso. Verifique o manifesto e os hashes dos membros
antes de usar o arquivo.
