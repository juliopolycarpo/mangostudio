# ChatGPT Provider

ChatGPT is integrated as a first-class MangoStudio provider for personal
ChatGPT subscription accounts. It uses browser-based OAuth sign-in instead of
an API key, then talks to the ChatGPT backend with the same account-oriented
flow used by tools such as Codex CLI and OpenCode.

## Provider Type

- **Provider ID:** `chatgpt`
- **Authentication:** Sign in with ChatGPT from Settings
- **Wire format:** ChatGPT backend Responses protocol
- **Continuation:** Stateless replay within MangoStudio; no durable
  server-side continuation cursor is stored across turns
- **Tools:** MangoStudio tool registry, executed by the API

## Sign-In Flow

1. Open **Settings -> Connectors**.
2. Choose **Sign in with ChatGPT**.
3. MangoStudio starts a temporary loopback callback server on
   `127.0.0.1:1455`.
4. Complete ChatGPT sign-in in the browser opened by the API host.
5. After ChatGPT redirects to `http://localhost:1455/auth/callback`, the API
   exchanges the authorization code, stores the token bundle, and lists the
   connector like any other provider.

Only one ChatGPT sign-in can use port `1455` at a time. Close other login
flows, including `codex login`, if MangoStudio reports that the port is busy.

## Token Storage And Reauth

ChatGPT access tokens expire and refresh tokens rotate. MangoStudio stores the
full token bundle in the OS secret store through `Bun.secrets`; it does not
support `config.toml` or `.env` storage for ChatGPT connectors. The SQLite
database stores only UI-safe metadata such as connector name, account label,
plan label, enabled models, and reauth status.

When a refresh token is rejected or revoked, MangoStudio marks the connector as
requiring reauthentication. Re-run **Sign in with ChatGPT** for the existing
connector to replace the token bundle without losing enabled-model settings.

## Model Availability

The model catalog combines a static ChatGPT baseline with best-effort discovery
from the account. Availability still depends on the ChatGPT plan attached to
the signed-in account, and plan rate limits are enforced by ChatGPT.

If a model appears but the account cannot use it, the backend may reject the
generation request. Reauthenticate after plan changes so MangoStudio can refresh
account and plan metadata.

## ChatGPT Vs OpenAI API Key

| Aspect         | ChatGPT connector                   | OpenAI connector                       |
| -------------- | ----------------------------------- | -------------------------------------- |
| Credential     | Browser sign-in, rotating tokens    | API key                                |
| Account scope  | ChatGPT subscription account        | OpenAI API organization/project        |
| Storage        | OS secret store only                | OS secret store, `config.toml`, `.env` |
| Rate limits    | ChatGPT plan limits                 | API account/project limits             |
| Continuation   | Stateless replay, no durable cursor | Responses continuation where supported |
| Intended usage | Personal subscription access        | Programmatic API access                |

Use the OpenAI connector when you need organization/project scoping, API-key
automation, or API billing controls. Use the ChatGPT connector when you want
MangoStudio to use the models available through your ChatGPT subscription.

## Remote Hosts

The OAuth redirect always targets `localhost:1455` in the browser. If the API
runs on a remote host but the browser runs on your laptop, that redirect will
hit the laptop unless you forward the callback port to the remote API host.

Example:

```bash
ssh -L 1455:127.0.0.1:1455 user@remote-host
```

Keep the tunnel open while signing in, then open the MangoStudio UI through
your normal remote access path. If the UI itself is also remote-only, forward
the API/frontend port as usual in a separate tunnel.

## Debug Overrides

The production endpoints are built in. Test and smoke harnesses can override
them with:

```toml
[chatgpt]
auth_base_url = "https://auth.openai.com"
api_base_url = "https://chatgpt.com/backend-api/codex"
```

The same values can be supplied with `MANGO_CHATGPT_AUTH_BASE_URL` and
`MANGO_CHATGPT_BASE_URL`. These overrides are for tests and debugging only;
connectors are still created through the Settings sign-in flow.
