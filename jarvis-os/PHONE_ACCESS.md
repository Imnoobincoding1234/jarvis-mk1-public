# Reaching JARVIS from your phone

JARVIS binds to `127.0.0.1` and nothing else. That is deliberate — the whole security
model (token gate, Host/Origin allowlist) assumes the server is not reachable from a
network. This adds a second, opt-in listener on your Tailscale interface only.

**Status (checked 2026-10-22): live.** Tailscale is installed on this Mac and JARVIS is listening on its tailnet address
(`lsof` shows `node … 100.x.y.z:8787` beside `127.0.0.1:8787`) — the second listener below is up. Whether a phone has used it
end to end is not recorded here. (Before 2026-10-22 this line said Tailscale was not installed.)

## Why Tailscale and not port-forwarding

A tailnet is a private WireGuard network between your own devices. Your phone reaches the
Mac by its tailnet address; nothing is exposed to the public internet, no ports are opened
on your router, and there is no certificate to manage. The alternative — forwarding 8787
through your router — puts JARVIS, which can open apps and drive your keyboard, on the
open internet behind a single token. Don't.

The listener binds to the Tailscale IP specifically, **never `0.0.0.0`**. Binding all
interfaces would expose JARVIS on whatever café wifi the laptop is on.

## Setup

1. Install Tailscale on the Mac and on your phone, signed into the same account:

```bash
brew install --cask tailscale
```

2. Start it and confirm the Mac has a tailnet address (it will be in `100.64.0.0/10`):

```bash
tailscale ip -4
```

3. Turn the listener on:

```bash
echo 'JARVIS_TAILNET=1' >> ~/"JARVIS MK-1/.env"
```

4. Restart JARVIS OS:

```bash
launchctl kickstart -k gui/$(id -u)/com.atharv.jarvisos
```

5. Check the log — it prints the reachable address, or says why it could not:

```bash
grep -i tailnet ~/"JARVIS MK-1/jarvis-os/logs/"*.log | tail -5
```

## Using it

Open `http://<tailnet-ip>:8787` on your phone while Tailscale is connected. The API token
is still required and is served in the page, exactly as on localhost — so the browser flow
just works. MagicDNS names (`yourmac.tailnet-name.ts.net`) are accepted too.

## Shortcut for one-shot commands

To fire a command without opening the UI, make a Shortcut with a **Get Contents of URL**
action:

- URL: `http://<tailnet-ip>:8787/api/chat`
- Method: `POST`
- Headers: `x-jarvis-token` = the value of `~/JARVIS MK-1/jarvis-os/state/.apitoken`,
  and `content-type` = `application/json`
- Body (JSON): `{"messages":[{"role":"user","content":"<your text>"}]}`

Add **Ask for Input** in front of it and **Show Result** after, and "Hey Siri, ask JARVIS"
works from anywhere on the tailnet.

Treat that token as a password — anyone holding it, on your tailnet, can drive this Mac.

## Turning it off

Remove `JARVIS_TAILNET=1` from `.env` and restart. The loopback listener is completely
independent, so nothing about local use changes either way.
