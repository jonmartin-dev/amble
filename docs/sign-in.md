# Sign-in

An Amble server signs people in through an OpenID Connect provider and lets in only the emails on its list. The app itself has no account: on a phone or in a browser it keeps everything on the device. Signing in to a server is how a device syncs with it (Use my own server), how Claude or ChatGPT connect, and how an admin reaches the server's own page.

Google is the default. Any provider that speaks OpenID Connect works, including the ones people self-host: Authelia, Authentik, Keycloak, Pocket ID, Zitadel and Kanidm.

The steps below were checked against Google, Authelia 4.39 and Keycloak 26.8, signing in through each from a fresh Docker setup. The Authentik notes follow its documentation.

## What every provider needs

Register Amble as a confidential web client (one with a client secret) and give it:

- **Redirect URI:** `<AMBLE_PUBLIC_URL>/auth/callback`, for example `https://example.com/amble/auth/callback`. It has to match exactly.
- **Scopes:** `openid email profile`.
- **Grant:** authorization code. Amble always uses PKCE (S256), so it's fine to require it.

Then set these in `.env`:

```sh
OIDC_ISSUER=https://auth.example.com      # the provider's issuer, exactly as its discovery document says
OIDC_PROVIDER_NAME=Authelia                # shown on the sign-in button: "Continue with Authelia"
OIDC_CLIENT_ID=amble
AMBLE_ADMIN_EMAILS=you@example.com
AMBLE_ALLOWED_EMAILS=partner@example.com
```

With Docker Compose the client secret goes in `secrets/oidc_client_secret`. Outside Docker, set `OIDC_CLIENT_SECRET` (or `OIDC_CLIENT_SECRET_FILE` pointing at a file).

What Amble expects back:

- **An issuer it can reach over HTTPS**, with `<issuer>/.well-known/openid-configuration`. The `issuer` in that document must match `OIDC_ISSUER` character for character, trailing slash included. If the provider uses a certificate from your own CA, give Node the CA with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
- **An email address.** Amble reads it from the ID token, or from the userinfo endpoint when the ID token leaves it out (Authelia does since 4.39).
- **An email that isn't marked unverified.** If the provider sends `email_verified: false`, Amble refuses the sign-in, since anyone who could put an allowed address on an account would otherwise get in. A provider that doesn't send `email_verified` at all is trusted.
- **Client secret** sent with HTTP Basic, the standard default. Amble switches to sending it in the request body only when the provider's discovery document says it can't take Basic.

Admins and allowed emails can sign in the first time without anything else. People added to the household in the app (People, on a device that syncs with the server) can sign in too.

## Google

1. In [Google Cloud](https://console.cloud.google.com/), create a project, then an OAuth client of type **Web application** with the redirect URI above.
2. On the OAuth consent screen, set the publishing status to **In production**. In testing mode, Google lets the server's Google Drive connection lapse after 7 days.
3. To keep the server in step with a household that syncs through Google Drive, turn on the **Google Drive API** in the same project ([google-drive.md](google-drive.md#a-server-in-the-household)).

```sh
OIDC_ISSUER=https://accounts.google.com
OIDC_PROVIDER_NAME=Google
OIDC_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
```

Google warns once on the consent screen that the app is unverified. That's expected for a self-hosted app with a few users.

## Authelia

Add a client under `identity_providers.oidc.clients`. Hash the secret with `authelia crypto hash generate pbkdf2 --variant sha512` and put the plain secret in Amble's `secrets/oidc_client_secret`.

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: 'amble'
        client_name: 'Amble'
        client_secret: '$pbkdf2-sha512$310000$...'
        public: false
        authorization_policy: 'one_factor'   # or two_factor
        redirect_uris:
          - 'https://example.com/amble/auth/callback'
        scopes: ['openid', 'email', 'profile']
```

```sh
OIDC_ISSUER=https://auth.example.com
OIDC_PROVIDER_NAME=Authelia
```

Leave `token_endpoint_auth_method` at its default (`client_secret_basic`). Amble reads the email from the userinfo endpoint, so no claims policy is needed.

## Keycloak

1. In your realm, go to **Clients**, **Create client**, type **OpenID Connect**, client ID `amble`.
2. Turn on **Client authentication**, keep **Standard flow**, and set **Valid redirect URIs** to the redirect URI above.
3. Copy the secret from the client's **Credentials** tab.
4. Each person needs an email with **Email verified** turned on (Users, the person, Details), or a realm that verifies emails itself. People an admin creates start out unverified, and Amble refuses them until that's on.

```sh
OIDC_ISSUER=https://keycloak.example.com/realms/home
OIDC_PROVIDER_NAME=Keycloak
```

## Authentik

1. Go to **Applications**, **Create with provider**, and pick **OAuth2/OpenID Provider**.
2. Set the client type to **Confidential** and add the redirect URI above as a **Strict** match. The default scopes include `openid`, `email` and `profile`.
3. Use the provider's **OpenID Configuration Issuer** as `OIDC_ISSUER`, including its trailing slash.

```sh
OIDC_ISSUER=https://authentik.example.com/application/o/amble/
OIDC_PROVIDER_NAME=Authentik
```

Since authentik 2025.10 its default `email` scope mapping says every address is unverified, so Amble refuses the sign-in until you do one of these:

- Verify addresses in authentik with an email stage, so the claim becomes true for people who confirmed theirs.
- If you set everyone's address yourself and nobody can change their own, make a scope mapping that vouches for them: **Customization**, **Property Mappings**, **New Property Mapping**, **Scope Mapping**, scope name `email`, with the expression below. Then on the provider's **Scopes**, swap the default `email` mapping for this one. Don't keep both.

```python
return {
    "email": request.user.email,
    "email_verified": True,
}
```

See authentik's [Verify email address](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/verify-email-address/) page for the details.

## Other providers

The checklist under [What every provider needs](#what-every-provider-needs) is all Amble relies on. Things that commonly trip it up:

- **Email marked unverified.** Most providers keep a verified flag per person. In Pocket ID, turn on **Emails Verified** in its application configuration and verify each person's address.
- **Issuer mismatch.** Copy the issuer from the provider's discovery document rather than typing it.

## Google Drive with another provider

To join a household that syncs through Google Drive, a server signed in through another provider needs a Google OAuth client of its own: a **Web application** client with the same redirect URI, and the Google Drive API turned on in its project.

```sh
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...          # or GOOGLE_CLIENT_SECRET_FILE
```

Without it, everything else works; devices sync with the server itself.

## When sign-in fails

The sign-in page says why when it can, and the server logs a line starting with `Sign-in could not start:` or `Sign-in failed:` (`docker compose logs amble`).

| The page says | What to check |
|---|---|
| Amble couldn't reach the sign-in provider | Amble couldn't read the provider's discovery document. `discovered metadata issuer does not match the expected issuer` means `OIDC_ISSUER` differs from the issuer the provider reports (often a trailing slash). `unexpected HTTP response status code` means nothing is at that address. `fetch failed: unable to verify the first certificate` means Node doesn't trust the provider's certificate; see `NODE_EXTRA_CA_CERTS` above. |
| That account isn't on this household's list | Add the email to `AMBLE_ALLOWED_EMAILS`, or add the person in People on a device that syncs with the server. |
| Your sign-in provider says this email address isn't verified | Mark the address verified in the provider (see your provider above). |
| Your sign-in provider didn't share an email address | Give the client the `email` scope, and make sure the person has an email in the provider. |
| Sign-in didn't go through | Read the server log. `invalid_client` or `unauthorized_client` means the client ID or secret is wrong, or the provider wants another way of sending the secret. If the provider shows its own error page instead of coming back, the redirect URI it has doesn't match `<AMBLE_PUBLIC_URL>/auth/callback`. |
| That sign-in took too long | The round trip took over 10 minutes, or the browser dropped Amble's cookie. Behind a proxy, check that `AMBLE_PUBLIC_URL` is the address people actually use. |
