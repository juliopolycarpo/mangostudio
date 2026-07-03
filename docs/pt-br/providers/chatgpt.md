# Provedor ChatGPT

O ChatGPT é integrado como provedor de primeira classe do MangoStudio para
contas pessoais com assinatura ChatGPT. Ele usa login OAuth pelo navegador em
vez de chave de API, depois conversa com o backend do ChatGPT usando o mesmo
fluxo orientado por conta usado por ferramentas como Codex CLI e OpenCode.

## Tipo De Provedor

- **Provider ID:** `chatgpt`
- **Autenticação:** Entrar com ChatGPT pelas Configurações
- **Formato wire:** protocolo Responses do backend ChatGPT
- **Continuação:** replay stateless no MangoStudio; nenhum cursor durável do
  servidor é armazenado entre turnos
- **Ferramentas:** registry de ferramentas do MangoStudio, executado pela API

## Fluxo De Login

1. Abra **Configurações -> Conectores**.
2. Escolha **Entrar com ChatGPT**.
3. O MangoStudio inicia um servidor temporário de callback loopback em
   `127.0.0.1:1455`.
4. Conclua o login do ChatGPT no navegador aberto pelo host da API.
5. Depois que o ChatGPT redireciona para
   `http://localhost:1455/auth/callback`, a API troca o código de autorização,
   armazena o bundle de tokens e lista o conector como qualquer outro provedor.

Apenas um login ChatGPT pode usar a porta `1455` por vez. Feche outros fluxos
de login, incluindo `codex login`, se o MangoStudio informar que a porta está
ocupada.

## Armazenamento De Tokens E Reautenticação

Tokens de acesso ChatGPT expiram e refresh tokens rotacionam. O MangoStudio
armazena o bundle completo de tokens no OS secret store via `Bun.secrets`; ele
não oferece armazenamento em `config.toml` ou `.env` para conectores ChatGPT. O
banco SQLite armazena apenas metadados seguros para UI, como nome do conector,
rótulo da conta, rótulo do plano, modelos habilitados e status de reautenticação.

Quando um refresh token é rejeitado ou revogado, o MangoStudio marca o conector
como exigindo reautenticação. Rode **Entrar com ChatGPT** no conector existente
para substituir o bundle de tokens sem perder os modelos habilitados.

## Disponibilidade De Modelos

O catálogo combina uma base estática de modelos ChatGPT com descoberta
best-effort pela conta. A disponibilidade ainda depende do plano ChatGPT da
conta conectada, e os limites de uso do plano são aplicados pelo ChatGPT.

Se um modelo aparece mas a conta não pode usá-lo, o backend pode rejeitar a
geração. Reautentique após mudanças de plano para o MangoStudio atualizar os
metadados da conta e do plano.

## ChatGPT Vs Chave API OpenAI

| Aspecto       | Conector ChatGPT                       | Conector OpenAI                        |
| ------------- | -------------------------------------- | -------------------------------------- |
| Credencial    | Login pelo navegador, tokens rotativos | Chave de API                           |
| Escopo        | Conta com assinatura ChatGPT           | Organização/projeto da API OpenAI      |
| Armazenamento | Apenas OS secret store                 | OS secret store, `config.toml`, `.env` |
| Limites       | Limites do plano ChatGPT               | Limites da conta/projeto de API        |
| Continuação   | Replay stateless, sem cursor durável   | Continuação Responses quando suportada |
| Uso previsto  | Acesso por assinatura pessoal          | Acesso programático via API            |

Use o conector OpenAI quando precisar de escopo por organização/projeto,
automação por chave de API ou controles de billing da API. Use o conector
ChatGPT quando quiser que o MangoStudio use os modelos disponíveis na sua
assinatura ChatGPT.

## Hosts Remotos

O redirect OAuth sempre aponta para `localhost:1455` no navegador. Se a API roda
em um host remoto mas o navegador roda no seu laptop, esse redirect chegará no
laptop a menos que você encaminhe a porta de callback para o host remoto da API.

Exemplo:

```bash
ssh -L 1455:127.0.0.1:1455 usuario@host-remoto
```

Mantenha o túnel aberto durante o login e acesse a UI do MangoStudio pelo seu
caminho remoto normal. Se a própria UI também for acessada remotamente, encaminhe
a porta da API/frontend em um túnel separado.

## Overrides Para Debug

Os endpoints de produção são embutidos. Harnesses de teste e smoke podem
sobrescrevê-los com:

```toml
[chatgpt]
auth_base_url = "https://auth.openai.com"
api_base_url = "https://chatgpt.com/backend-api/codex"
```

Os mesmos valores podem ser fornecidos por `MANGO_CHATGPT_AUTH_BASE_URL` e
`MANGO_CHATGPT_BASE_URL`. Esses overrides são apenas para testes e debug; os
conectores continuam sendo criados pelo fluxo de login das Configurações.
