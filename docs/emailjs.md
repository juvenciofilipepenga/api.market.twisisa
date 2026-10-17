# Recuperação de conta com EmailJS

O servidor gera o link de recuperação e envia o email pela REST API do EmailJS. O browser nunca recebe o token:
só quem tem acesso à caixa de correio consegue redefinir a palavra-passe.

## 1. Conta EmailJS

1. **Email Services > Add New Service**: ligue o Gmail (ou outro). O **Service ID** vai para `EMAILJS_SERVICE_ID`.
2. **Account > General**: copie a **Public Key** para `EMAILJS_PUBLIC_KEY`.
3. **Account > Security**: ative **Allow EmailJS API for non-browser applications**. Sem isto o EmailJS responde 403 ao servidor.
   Aqui também se gera a **Private Key** (Access Token): vai para `EMAILJS_PRIVATE_KEY`.
4. **Email Templates > Create New Template** (texto abaixo). O **Template ID** vai para `EMAILJS_TEMPLATE_ID`.
5. Variáveis a definir no projeto **da API** (api.market.twisisa) na Vercel, não no frontend. Defina também `FRONTEND_URL=https://market.twisisa.site`
   (é a base do link do email; sem ela usa a primeira origem de `CORS_ORIGIN`).

## 2. Template "recuperar palavra-passe" (`EMAILJS_TEMPLATE_ID`)

- **To Email:** `{{to_email}}`
- **Subject:** `Recupere a sua conta {{site_name}}`
- **Variáveis enviadas:** `to_email`, `to_name`, `reset_link`, `expires_minutes`, `site_name`

Corpo:

```
Olá {{to_name}},

Recebemos um pedido para redefinir a palavra-passe da sua conta {{site_name}}.

Para escolher uma nova, abra este link (válido por {{expires_minutes}} minutos, uso único):
{{reset_link}}

Se não foi você, ignore este email: a sua palavra-passe continua a mesma.
```

## 3. Template opcional "palavra-passe alterada" (`EMAILJS_TEMPLATE_ID_CHANGED`)

- **To Email:** `{{to_email}}`
- **Subject:** `A sua palavra-passe foi alterada`
- **Variáveis enviadas:** `to_email`, `to_name`, `changed_at`, `site_url`, `site_name`

```
Olá {{to_name}},

A palavra-passe da sua conta {{site_name}} foi alterada em {{changed_at}}.
Se não foi você, contacte-nos de imediato pelo chat em {{site_url}}.
```

## 4. Comportamento

| Pedido | Resposta |
| --- | --- |
| `POST /auth/forgot-password` `{ email }` | `200 { ok, cooldownSeconds, expiresMinutes }` sempre (exista a conta ou não; os dois números são fixos e servem o timer de reenvio). `503 EMAIL_UNAVAILABLE` se as variáveis EMAILJS não estiverem definidas em produção. `429` acima de 5 pedidos/min por IP. |
| `POST /auth/reset-password/check` `{ token }` | `200 { valid, email (mascarado), expiresAt, serverNow }` ou `400 INVALID_TOKEN` / `410 TOKEN_EXPIRED` / `410 TOKEN_USED` / `403 ACCOUNT_RESTRICTED` |
| `POST /auth/reset-password` `{ token, password }` | `200 { ok, user, accessToken }` (`accessToken` é `null` em contas de administração: têm de entrar pelo login) ou os erros acima, mais `422 SAME_PASSWORD` |

Regras: link válido por `PASSWORD_RESET_TTL_MINUTES` (30 por omissão) e de uso único; um pedido novo invalida o link anterior;
por conta, no máximo 1 email por minuto e 5 por hora; só o hash do token fica na base de dados; ao redefinir, os tokens de acesso
anteriores deixam de valer (`User.passwordChangedAt`); contas suspensas ou bloqueadas não recebem email.

Se o email não chegar, procure no log do servidor `password reset email failed`: traz o motivo devolvido pelo EmailJS
(chave inválida, "non-browser" desativado, limite do plano gratuito, etc.).
