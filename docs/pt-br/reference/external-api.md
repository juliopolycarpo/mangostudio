# API externa (chaves de API)

MangoStudio expõe a mesma API HTTP para sessões no navegador e para clientes de
automação. Chamadas externas autenticam com chaves de API com escopo em vez de
cookies.

## Habilitar acesso

1. Entre no app e abra **Configurações → API externa**.
2. Ative **Habilitar acesso à API externa** (`externalApiSettings.enabled` nas
   configurações do app). Com o toggle desligado, todas as chaves do usuário são
   recusadas com `EXTERNAL_API_DISABLED` (403).
3. Crie uma chave: nome, escopo e expiração opcional. A chave em texto claro
   aparece uma vez na UI — copie imediatamente; ela não fica no cache de
   queries e não pode ser recuperada depois.

Gerenciar chaves (criar, listar, revogar) exige sessão por cookie. Chaves de API
não podem gerenciar outras chaves.

## Autenticação

Envie a chave em cada request:

```http
x-api-key: mango_…
```

O Better Auth resolve a chave pelo mesmo caminho de sessão do navegador, então
rotas protegidas continuam com `requireAuth` sem um stack separado. Chaves nunca
funcionam em `/api/auth/**`.

### Escopos

| Escopo      | Métodos permitidos          |
| ----------- | --------------------------- |
| `read-only` | `GET`, `HEAD`, `OPTIONS`    |
| `full`      | Todos os métodos permitidos |

Escrita ou exclusão com chave read-only retorna `API_KEY_SCOPE_FORBIDDEN` (403).

## Descobrir endpoints

OpenAPI interativo em `/scalar` no host da API (mesma origem que `/api`). Use
para explorar rotas e schemas quando você tem cookie de sessão.

Para shapes de contrato, os schemas TypeBox em `@mangostudio/shared` são a fonte
da verdade; testes de integração frequentemente validam responses com
`Value.Check`.

## Erros

Erros HTTP usam `ApiErrorResponse` de `@mangostudio/shared/errors`:

```json
{ "error": "Mensagem legível", "code": "CODIGO_OPCIONAL" }
```

Envie `Accept: application/problem+json` para receber problem details da RFC
9457, com o mesmo status e o mesmo `code`. É opt-in e aditivo — nenhuma
integração existente precisa mudar. Veja
[Formato Da Resposta De Erro](./api.md#problem-details-rfc-9457) para o contrato
completo.

Códigos comuns para tráfego de API externa:

| Código                    | Status típico | Significado                                 |
| ------------------------- | ------------- | ------------------------------------------- |
| `EXTERNAL_API_DISABLED`   | 403           | Toggle do usuário desligado                 |
| `API_KEY_SCOPE_FORBIDDEN` | 403           | Método não permitido para o escopo da chave |
| `RATE_LIMITED`            | 429           | Limite do bucket; veja `Retry-After`        |

Rate limiting usa buckets separados para health, auth, navegador (`general`) e
tráfego com chave (`api-key`). Os contadores ainda são por IP dentro de cada
bucket hoje, então um pico com `x-api-key` não consome o contador general da
sessão no mesmo host (bucketing por chave está em #737). O teto do `api-key`
fica abaixo do `general` de propósito: um script faz os requests que pretende
fazer, enquanto o `general` precisa absorver o fan-out por página do navegador.

## Notas de segurança

- A API escuta em `0.0.0.0` por padrão. Fora de localhost, termine TLS no proxy
  reverso e defina `TRUST_PROXY=true` apenas quando o proxy substitui headers de
  IP do cliente (veja `docs/pt-br/operations/deployment.md`).
- Chaves são armazenadas hasheadas no servidor; só o prefixo aparece na lista.
  Trate chaves em texto claro como senhas.
- Não commite chaves em git nem cole em logs públicos.

## Exemplos

Substitua `BASE` e `KEY` pela origem da API e pela chave.

### curl

```bash
export MANGO_API_KEY='mango_sua_chave_aqui'
export BASE='http://localhost:3001'

curl -sS -H "x-api-key: $MANGO_API_KEY" "$BASE/api/health"
curl -sS -H "x-api-key: $MANGO_API_KEY" "$BASE/api/chats"
```

### Bun

```typescript
const base = process.env.BASE ?? 'http://localhost:3001';
const key = process.env.MANGO_API_KEY;
if (!key) throw new Error('Set MANGO_API_KEY');

const res = await fetch(`${base}/api/chats`, {
  headers: { 'x-api-key': key },
});
console.log(res.status, await res.json());
```

### Script de smoke

Na raiz do repo, com servidor de dev e chave válida:

```bash
MANGO_API_KEY='mango_…' bun run scripts/examples/external-api-smoke.ts http://localhost:3001
```
