# Shellcode

One terminal for every coding agent. Shellcode runs the coding harnesses you already have installed, plus a built-in agent that talks to free and local model providers, and a router that picks the model for each task.

> Status: early. Everything below marked "tested" has automated tests; harness adapters for third-party CLIs are built from their public docs and have not been run against the real binaries yet. See [What is verified](#what-is-verified).

## What it does

- **Swappable harnesses.** Switch between the built-in agent and Claude Code, Codex CLI, Cursor CLI, Google Antigravity CLI, Gemini CLI, OpenCode, Aider and Goose with `/harness`. Each external harness keeps its own login and keys. Shellcode only launches it headless in your project and streams its output. Because it cannot see or cap what a harness bills, an external harness is **refused by default** (every policy) unless the model is an OpenCode model that OpenCode's own catalog (`opencode models <provider> --verbose`) prices at exactly 0, checked at call time, or you pass `--ack-external-cost` for that run.
- **Free and local providers, labelled conservatively.** Local (Ollama, LM Studio) and OpenRouter models priced at 0 count as free. Gemini counts as free-tier (Google says free-tier content may be used to improve its products, and some models have no free tier). Groq, Cerebras and Mistral are marked `unverified`, because current docs did not confirm a no-card free plan (Cerebras documents trial credits that need a payment method). `unverified` is treated like paid until you list the provider in `allowFree` in your config. Any other OpenAI-compatible endpoint can be added in config. Models are discovered live from each provider because lists change often.
- **Task-aware routing.** Each request is scored (length, complexity words, files involved, stack traces, session length, earlier failures). Light work goes to a small fast model, hard work to a large one, and the choice and reasons are shown. If a model rate-limits or fails, Shellcode falls back down the chain.
- **Policies.** `free` (default) calls only free labelled models and checks this again right before every request, so a model outside the policy is never contacted and a pinned paid model is refused. `balanced` uses paid models only for heavy tasks. `quality` allows paid models everywhere. Paid providers only participate if you set their key.
- **Streaming and sessions.** Replies stream token by token. Conversations are saved to `~/.shellcode/sessions` and can be resumed with `/sessions`.
- **Permissions, honestly.** The built-in agent asks before writing files or running commands unless you turn on auto-approve (`/yolo`). The file tools refuse paths outside the project, including through symlinks. The shell tool is **not sandboxed**: an approved command can do anything you can, so read what you approve. Commands do not receive environment variables whose names contain KEY, TOKEN, SECRET, PASSWORD or AUTH. For external harnesses, `/yolo` maps only to the narrowest documented switch (for example Claude Code `acceptEdits`, Codex `--sandbox workspace-write`); Shellcode never passes a skip-all-permissions flag.

## Choosing harnesses and models

- `auto` (default) uses the built-in agent when any allowed model exists. If none does, it falls back only to an OpenCode model that OpenCode's own catalog lists at price 0 right now. It never auto-selects a harness whose price it cannot verify.
- External harnesses other than that case need a per-run confirmation (a prompt in the TUI and the terminal, or `--ack-external-cost`). The prompt is only approval UX: Shellcode cannot see their billing.
- Local servers: the `:11434` and `:1234` entries accept any OpenAI-compatible server. Add your own under `providers` in the config file with `cost: "local"` for other ports.

### Routing evaluation (`bun run packages/core/eval/routing.ts`)

Tier routing is a keyword and length heuristic. I labelled 44 prompts by hand (light, standard, heavy) and a second held-out set of 24 written after the last rule change. The labels come from the same author as the rules, so treat the numbers as optimistic, and they measure agreement with those labels, not whether a model solved the task. Before any tuning the first set scored 61% (27/44). After adjusting the rules it scores 86%, but that set was used to tune. The held-out set scores 67% (16/24) with no two-tier misses; its mistakes are mostly hard tasks routed one tier too low. Failed attempts escalate the tier, which is the safety net.

## Install and run

Requires [Bun](https://bun.sh).

```bash
bun install
bun run start            # open the interface
bun run start doctor     # what is set up, what is missing
bun run start route "refactor the auth module and fix the race in the session cache"
bun run start run -y "add input validation to parse()"
bun run start run -H aider "rename foo to bar"   # use an installed external harness
```

### Reproduce a keyless local run

```bash
# 1. a local OpenAI-compatible server on port 11434 or 1234 (Ollama, LM Studio, or llama.cpp's llama-server)
llama-server -m qwen2.5-1.5b-instruct-q4_k_m.gguf --port 11434 --jinja   # needs --jinja for tool calls
# 2. confirm Shellcode sees it
bun run start doctor
# 3. run a task (-y auto-approves edits in the current folder)
bun run start run -y "In a.txt, replace the word old with new."
```

External harnesses are separate installs with their own logins. `doctor` marks one as installed only if its binary is on PATH and `--version` exits 0, and it prints the official docs link for installing it. OpenCode needs no key for its zero-priced models (`opencode models opencode --verbose` lists their cost).

Set at least one provider key in your environment. Shellcode reads keys from environment variables and never writes them to disk:

| Provider | Variable | Cost |
| --- | --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` | models priced at 0 only (free policy) |
| Groq | `GROQ_API_KEY` | free tier, rate limited |
| Gemini | `GEMINI_API_KEY` | free tier, rate limited |
| Cerebras | `CEREBRAS_API_KEY` | free tier, rate limited |
| Mistral | `MISTRAL_API_KEY` | free plan, rate limited |
| Ollama / LM Studio | none | local |
| OpenAI, Anthropic | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | paid, ignored under `free` policy |

Free tiers have limits and can change. Check each provider's current terms.

## Config

`~/.shellcode/config.json` (override the directory with `SHELLCODE_HOME`):

```json
{
  "policy": "free",
  "harness": "auto",
  "yolo": false,
  "tierOverrides": { "groq/some-model": "heavy" },
  "providers": [
    { "id": "mine", "name": "My gateway", "baseUrl": "https://example.com/v1", "keyEnv": "MY_KEY", "cost": "free-tier", "note": "" }
  ]
}
```

## Layout

```
packages/core   providers, router, built-in agent loop, tools, harness adapters (no UI)
packages/cli    terminal UI (OpenTUI + React) and the headless commands
```

## What is verified

Run `bun run test` and `bun run typecheck`.

- Router tiering, escalation after failures, policy filtering and call-time fail-closed: unit tests and mock-server tests.
- Provider discovery, including that only zero-priced OpenRouter models are free and unverified providers need an allowlist.
- Built-in agent end to end against a mock OpenAI-compatible server: light task goes to the small model, a real file is edited, a real command runs, 429 falls back, a denied approval changes nothing, SSE streaming and streamed tool calls work.
- Symlink escape, secret-free shell environment, session save and reload.
- `shellcode run` as a real process, and the terminal UI driven through a real pseudo-terminal.
- Local OpenAI-compatible server, no account: one run against llama.cpp `llama-server` (port 11434, the address Shellcode uses for its `ollama` entry) with Qwen2.5-1.5B-Instruct Q4. The built-in agent discovered the model, streamed a reply, made one real `edit_file` call and the file changed. This is a single run on one small model, so it shows the path works, not how reliable tool use is for any model size. Real Ollama and LM Studio were not tested; they should work through the same OpenAI-compatible API but that is unverified.
- External harness adapters: the flags for all eight were checked against each vendor's official docs on 2026-10-21 (links in `shellcode doctor`) and the generated command lines are tested. Only OpenCode has been run for real (a zero-priced `opencode/*` catalog model, synthetic prompts, one reply and one file edit). Claude Code, Codex, Cursor, Antigravity, Gemini CLI, Aider and Goose were not run, so treat them as "documented, not yet exercised". The OpenCode free models are hosted by a third party, so do not send private code to them until you have read their terms. Codex and Goose model selection is not passed because no headless model flag was confirmed. A harness shows as installed only if its binary is found and `--version` succeeds.
- Not tested against any live provider (no keys were used) or with real free-tier limits.

## Known gaps

- Routing is rule-based scoring plus model-name tiering, not learned. It routes models for the built-in agent and does not switch harnesses by itself.
- Bash is unsandboxed (see above).
- Cursor CLI binary is `agent` per its docs; older installs may use `cursor-agent`.

## Notes

Shellcode started from the structure of the [Nightcode tutorial](https://github.com/code-with-antonio/nightcode) (a Bun + OpenTUI terminal app). It is a different product: no account system, billing or hosted server, and the agent, router, providers and harness layer are original code.
