```
██████╗ ███████╗████████╗ █████╗  ██████╗██╗  ██╗
██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
██████╔╝███████╗   ██║   ███████║██║     █████╔╝
██╔═══╝ ╚════██║   ██║   ██╔══██║██║     ██╔═██╗
██║     ███████║   ██║   ██║  ██║╚██████╗██║  ██╗
╚═╝     ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
```

# PStack for Oh-My-Pi 

This is a native plugin for Oh-My-Pi (omp) but has support for Pi, Claude Code and Empryo.

All skills follow the `ps-*` namespace, You might hate it 😬, but for me it's a quick visual and typing action to quickly find the skill I want to run manually. Which is similar to my [DoSkills](https://github.com/edheltzel/Do-Skills).

## What pstack is

pstack is a Cursor plugin by Lauren Tan ([@poteto](https://x.com/poteto)). See [Curor's repo](https://github.com/cursor/plugins/tree/main/pstack) for more info.

## Docs

- [The pstack guide](./docs/guide/README.md) — original numbered product tutorial (setup through recipes, plus images).

**pi** skill use `skills/ps-*`. **omp** skills are `/skill:ps-…`. **claude** skills are `/pstack:ps-*`. `/poteto-mode` stays unprefixed on omp, becuase it is a native plugin.

## Automations

pstack also ships a dormant [benny automation pack](./automations/benny/). Benny triages Slack issue reports, then reproduces and fixes confirmed bugs with real UI evidence. Its files are **not** slash skills. Sibling `skills/` at the package root is the only skill tree; do not add a second one.

Setup starts at [`automations/benny/FOR_AGENTS.md`](./automations/benny/FOR_AGENTS.md). That README records the Cursor Automations host vs what omp can run.

## Load this plugin

GitHub install. No clone required.

### omp

```
omp plugin marketplace add edheltzel/Do-Pstack
omp plugin install pstack@pstack
```

This checkout: `omp plugin link ./`

### Pi

```
pi install git:github.com/edheltzel/Do-Pstack
```

This checkout: `pi install ./`

### Claude Code

```
claude plugin marketplace add /absolute/path/to/Do-Pstack
claude plugin install pstack@pstack
```

```
claude plugin marketplace add edheltzel/Do-Pstack
claude plugin install pstack@pstack
```

This session only: `claude --plugin-dir ./`

Claude slash skills are namespaced: `/pstack:ps-how`, `/pstack:ps-poteto-mode`. Validate the layout with `claude plugin validate .`. Sticky `/poteto-mode` is omp-only; on Claude run `/pstack:ps-poteto-mode`.

### Empryo

Empryo has no plugin API, so pstack installs from a clone. Needs Node and npm.

#### Install

```
git clone https://github.com/edheltzel/Do-Pstack.git
cd Do-Pstack
npm run empryo -- install
```

| What | Where |
| --- | --- |
| Skills `skills/ps-*` | symlinked into `~/.agents/skills/` |
| 8 pstack agents, translated for Empryo | `~/.empryo/agents/pstack/` |
| `poteto` profile | `~/.empryo/agents/pstack/poteto.md` |
| Ownership manifest | `~/.empryo/pstack.json` |

Keep the clone where it is: the skills are symlinks into it. Install never overwrites a file it did not create; it reports it and leaves it alone. Preview first with `npm run empryo -- install --dry-run`.

#### Use

- Poteto Mode: pick the `poteto` profile per tab with `/agent poteto`, or start with `empryo --agent poteto`. Switch the tab to another agent to turn it off. It is never on for every tab.
- Skills: run any `ps-*` skill from `/skills` or by name, in any tab.
- Agents: `poteto-agent`, `how-explorer`, `interrogate-reviewer`, `swarm-worker` and the rest show in `/agents` and can be dispatched by name.

#### Update the plugin

```
cd Do-Pstack
git pull
npm run empryo -- install
```

Install is safe to rerun: it links new skills, removes links to deleted ones, and refreshes the agents. `npm run empryo -- check` tells you when an update is needed; it exits non-zero if anything is missing, out of date, or blocked by a file pstack does not own.

#### Update the pstack skills

`git pull` gets the skills as synced in this repo. To pull the newest official skills from [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack) yourself:

```
npm run sync -- --dry-run
npm run sync
```

Sync writes into `skills/ps-*`, then updates your Empryo install in the same run (only when `~/.empryo/pstack.json` exists). Pass `--no-empryo` to skip the Empryo step. See [Update official skills](#update-official-skills).

#### Remove

```
npm run empryo -- remove
```

Deletes only what the manifest lists. Your own skills and agents stay.

## Usage

1. On omp: `/poteto-mode` — enable sticky Poteto Mode for this conversation. Optional task arguments are passed through; this also sends `/skill:ps-poteto-mode`.
2. Do your thing as usual. Just with pstack's flow and skills

- `/poteto-mode` is persistent in omp with you execute `/new` or when you resume a conversation.

3. `/poteto-mode off` (aliases: `disable`, `stop`)

`/poteto-mode` is off by default

please note: omp's TUI shows `🍠 poteto: ✓ on` when enabled.

## Commands

| Command            | What it does                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `/poteto-mode`     | omp factory: enable sticky Poteto Mode for this conversation. Also sends `/skill:ps-poteto-mode`. |
| `/poteto-mode off` | Disable this omp conversation. Aliases: `disable`, `stop`.                                        |

That is the live omp extension command. It stays unprefixed. There is no worktree command. No `hooks/` tree. No `src/` tree. No Cursor marketplace APIs. Do not ship `commands/poteto-mode.md`.

## Poteto Mode (this extension)

- On omp, enable sends `/skill:ps-poteto-mode`. The `/skill:ps-poteto-mode` input hook also persists enabled.
- Stored as a custom `pstack-mode` entry on that conversation’s session jsonl. Last `{enabled}` wins. Missing means off.
- `session_start` re-reads the jsonl. `new_session` / `/new` starts off. Resume of an on conversation stays on.
- When on, a prompt needle prepends “Pstack Poteto Mode is on…”
- The TUI status reads `🍠 poteto: ✓ on` when on.
- Off aliases: `off`, `disable`, `stop`.

## Update official skills

Official skills come from the Cursor pstack folder in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack):

```
npm run sync
```

Same command: `node scripts/pstack.mjs sync`.
Dry-run: `npm run sync -- --dry-run`.

That pulls `pstack/skills/<name>` from `cursor/plugins` into the existing `skills/ps-*` tree (YAML `name` gets the `ps-` prefix). It does not create a second skill tree. When Empryo was installed with `npm run empryo -- install` (manifest `~/.empryo/pstack.json`), sync then reconciles those Empryo links and agents; `--no-empryo` skips that.

After a feature or this sync, bump versions the same way:

```
npm run bump -- patch
npm run bump -- minor
npm run bump -- major
```

That updates `package.json` (omp plugin + pi extension) and `.claude-plugin/plugin.json` together. Dry-run: `npm run bump -- patch --dry-run`. After those files are committed: `npm run bump -- --tag` (tags HEAD) then `npm run bump -- --release` (push tag + `gh release create --target <sha>`). Do not combine patch and --tag in one run.

## License

I just follow omp's license but i think I need to do that?
omp is also MIT ([license](https://github.com/can1357/oh-my-pi/blob/main/LICENSE)).
