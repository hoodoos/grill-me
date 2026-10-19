# Grill-me Game hosted plugin

This separate portable package presents the public hosted MCP endpoint. It does not
replace the existing local Codex/Claude plugins or rebuild the frozen CLI/MCPB assets.
Its JSON/asset validation does not establish installation, directory approval or actual
provider/model behavior. It cannot reproduce a full HTML homepage inside a store listing.
`Grill-me Game` is the public display name; `grill-me-game` is this new package's stable
identifier. If updating an already assigned package, preserve its existing immutable
identity instead of assuming a new name can overwrite it. No existing package/account
identity was accessible or changed in preparing this draft.

## Connect or update your personal ChatGPT plugin

In ChatGPT Plugins, choose **+ → Add custom MCP server**. Enter:

- Name: **Grill-me Game**
- Description: **Turn an idea into a friendly swipe-card interview. Answer in chat or on your phone, one focused round at a time.**
- Connection: **Server URL**
- URL: **https://grill-me.ai/mcp**
- Authentication: **No authentication**

Review the warning, create the plugin and install it. In a conversation, select it with
`@` and ask it to grill you. For an existing custom plugin, use its available settings
to update its account-owned name/description and refresh tools/server instructions.
If those presentation fields cannot be edited there, recreate the personal connection
with the same canonical endpoint. Server metadata alone cannot rename an existing
account connection. This repository has no account-management access and makes no claim
that those account steps have been performed.

Choose **Server URL**, not **Tunnel**: this endpoint is already public HTTPS. A Secure MCP
Tunnel is for reaching a private server; it is not a durable agent, wake registration or
answer-handoff fix. Do not substitute an unrelated AppDeploy endpoint.

`mcp.json` uses the portable schema's `streamable-http` transport and no credential
headers. That schema has no `auth` field; adding `"auth":"none"` would be invalid.
The explicit No authentication selection belongs to account/submission configuration.

## Importable listing draft

Package the contents of this directory at the ZIP root, with `plugin.json`, `mcp.json`
and `assets/` together. OpenAI-specific presentation is under
`extensions.com.openai.interface`. It is separate from MCP `serverInfo`, tool titles
and model instructions. Use the publisher dashboard's **With MCP** flow for the remote
endpoint and upload the portable package where supported; no fake registered app ID is
included. Dashboard access, category/developer identity and actual import are unverified.

This draft intentionally omits `termsOfServiceURL`: no service Terms URL is established.
The MIT source license is not a substitute for service Terms. Public MCP submission
requires Terms plus other review materials, including reviewer cases and a demo recording;
this package is **not public-submission complete**, approved or published.

The privacy link is the existing website's `#privacy` section; support goes to repository
issues. Assets are public disposable demonstration material, never owner interviews,
private phone links, keys or unrelated Hub source. Listing screenshots cannot prove
actual ChatGPT/Claude/Grok rendering or automatic continuation.
The three included706×800 PNGs are unedited captures of the public website demo, in starter
order: `store-demo.png`, `store-swipe.png`, `store-own-answer.png`. They illustrate the
shared cards, not an actual ChatGPT store/account render. The SVG logo reuses the existing
blue card/flame favicon at128×128 with a matching square viewBox. Screenshots are accepted
as optional listing assets, but current directory guidelines do not promise their display.

Official references (checked 2026-10-19):

- [Portable plugin structure](https://developers.openai.com/plugins/build/plugins)
- [Listing fields and asset requirements](https://developers.openai.com/plugins/deploy/submission)
- [Submission errors and screenshot limits](https://developers.openai.com/plugins/deploy/submission-errors)
- [Custom MCP account setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
