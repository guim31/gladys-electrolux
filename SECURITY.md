# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration keeps, and where:

- the current Electrolux **access and refresh tokens**, with a SHA-256
  fingerprint of the refresh token they descend from, in
  `/data/electrolux-auth.json`, readable by the container user only — never in
  the logs;
- the Electrolux **API key** and the **refresh token** pasted by the user, in the
  Gladys configuration (both are `secret` fields: Gladys never sends them back to
  the browser).

Network: the container only talks to `api.developer.electrolux.one` (REST API and
token refresh, over HTTPS), to the HTTPS live stream URL the API gives, and to
Gladys. It opens no port. The Electrolux password is typed on Electrolux's own
portal, never in Gladys.

Commands: the integration never starts nor resumes an oven, a hob, a tumble dryer
or a washer-dryer, never sets an oven, and starts a washing machine only when the
user allowed it in the configuration and armed remote start on the machine. A way
around these rules is a vulnerability: please report it.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the Electrolux cloud and appliances.
