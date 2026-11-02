# Security

Please report a security problem privately, through [Report a vulnerability](https://github.com/jonmartin-dev/amble/security/advisories/new) on the repository's Security tab, rather than in a public issue. Say what someone could do and how.

What counts most: anything that lets someone read or change a household they aren't in, get around a server's sign-in or the connector's OAuth, or reach the secrets a server keeps (its sign-in client's secret, AI key, Google tokens). On a device, Amble keeps everything in the app's own storage, so problems there usually start with another app or a lost phone; those are worth reporting too.

Fixes go into the latest version only. A household's server picks them up with `deploy/setup.sh --update`.
