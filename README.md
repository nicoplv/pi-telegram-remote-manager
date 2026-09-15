# Pi Telegram Remote Manager

A standalone Telegram controller for normal interactive [Pi](https://pi.dev/) sessions. Each active Pi process runs inside its own tmux session, so Telegram and a terminal can use the same live conversation.

## Requirements

- Unix-like operating system
- Node.js 24 or newer
- Pi 0.85.1 (the tested baseline) available as `pi`
- tmux 3.2 or newer; tmux 3.5+ is recommended
- A Telegram bot token from BotFather

For the best Pi keyboard behavior in tmux 3.5+, add this to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

## Setup

```sh
npm install
npm run build
cp config.example.yaml config.yaml
export TELEGRAM_BOT_TOKEN='your-token'
node dist/index.js --check --config config.yaml
node dist/index.js --config config.yaml
```

The first run prints a six-digit command such as `/trm_pair 123456`. Send it to the bot in a private Telegram chat. That account becomes the only owner. The code and bot token are secrets and are never logged.

To change owners, stop the daemon and run:

```sh
node dist/index.js --reset-owner --config config.yaml
```

Then start it normally and pair with the newly printed code.

## Operation

After pairing, Telegram displays a persistent `☰ Manager` button and a three-section menu:

- **Projects** — list every project as a button, create one, and start or open its sessions.
- **Sessions** — list every active or sleeping session as a button, start a session, or manage the selected session.
- **Manage Pi** — list, install, update, or uninstall Pi packages, and update Pi itself.

The only remote-manager command is `/trm_pair <code>`, used for initial owner pairing. After pairing, Telegram's slash-command suggestions are cleared at the default, private-chat, and owner-chat scopes so manager actions are available only through `☰ Manager`. Retired `/trm_*` commands direct the owner back to that menu and are never sent to Pi.

Project and session lists use one inline button per item, with no pagination. Selecting a project or session opens it directly; project names remain case-sensitive, and session buttons include their short ID. New project names, session names, and steering messages are still entered with the Telegram keyboard when prompted. After selecting a session, ordinary text and Pi slash commands are sent to it. While Pi is busy, normal messages are queued as follow-ups; use **Sessions → Current session → Steer** to steer the active turn. The **Leave** action clears the Telegram selection without stopping the Pi/tmux session.

### Manage Pi

Choose **Manage Pi**. **List extensions** displays the selected Global or Project scope as unpaginated package buttons; selecting a package opens its details and the **Uninstall** action. **Install extension** asks for a scope and a typed remote package source. **Update extension** asks for a scope and presents the installed packages as buttons before confirmation. **Update Pi** updates the Pi CLI itself. There is no separate top-level Uninstall action.

Install, update, uninstall, and Pi self-update operations require a short-lived Confirm button. Existing sessions are never restarted automatically: reload them after a package change, and restart them after updating Pi.

Accepted sources are `npm:`, `git:`, HTTP(S), SSH, and Git URLs; local filesystem paths are intentionally rejected. Pi packages may contain extensions, skills, prompts, or themes, and can run code with full access to the machine, so review their source before confirming.

Global packages apply to every project. Project packages are written to that project's `.pi/settings.json`; the Project list action shows only entries from that scope. New sessions load updated packages automatically. Existing sessions keep their currently loaded resources until you select the session and send Pi's `/reload` command, or restart it.

The session view displays the exact attach command:

```sh
tmux attach -t pi-project-1234abcd
```

Detach with `Ctrl+B`, then `D`. Detaching does not stop Pi. Project-local Pi resources are loaded with `--approve`; configuring `projectsRoot` therefore means trusting its direct child projects.

Stopping the daemon leaves Pi/tmux sessions alive. On restart, their bridge extensions reconnect. Sessions that remain idle for the configured interval are gracefully shut down only when Pi is settled and no tmux client is attached.

Pi extension dialogs are not mirrored in V1. If Pi waits for an interactive dialog, Telegram displays the tmux attach command and automatic idle shutdown remains disabled.

## Running under a supervisor

Run the same foreground command from systemd, launchd, supervisord, or another process supervisor. Ensure it uses the same Unix user and environment as the local Pi installation. V1 intentionally does not install or modify supervisor configuration.

## Troubleshooting

- `--check` reports missing executables, invalid directories, incompatible tmux, missing build output, and Unix socket failures.
- If Pi exits before its bridge becomes ready, the manager captures the final tmux output, stops that failed tmux session, records the error, and sends the diagnostic to Telegram once. A hung startup is treated the same way after `bridgeRegistrationTimeoutSeconds`.
- A session in `error` retains its Pi session path, when one was established, for inspection and recovery.
- Permanent Telegram polling errors, such as an invalid token or a second process polling the same bot, stop the polling loop instead of retrying forever. Temporary network errors still retry, but repeated log messages are limited to once per minute.
- The daemon never deletes unknown tmux sessions, even if their names start with `pi-`.
- If a Pi extension opens an interactive prompt, attach to tmux and answer it there.
