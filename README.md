# Nemira Labs — Agent Skills

Public, installable skills for AI coding agents (Claude Code, OpenClaw,
Cursor, Codex, Gemini CLI, …).

| Skill | What it does |
|---|---|
| [`oddsbot`](skills/oddsbot) | Trade Polymarket prediction markets through [OddsBot](https://oddsbot.vercel.app) on a user's behalf — balance, market search and detail, order-book depth, real-money limit & market orders under user-approved spend limits, order lifecycle, positions and fills. Zero dependencies, Node 20+. |

## Install

```
npx skills add nemira-labs/skills
```

and pick `oddsbot`. Or copy `skills/oddsbot/` into your agent's skills
directory by hand — it is two files (`SKILL.md` + `scripts/oddsbot.mjs`).

First use asks for a one-time browser authorization (OAuth device flow);
the agent never sees the user's wallet keys, and every order is checked
server-side against spend limits the user set.

## Versioning

`skills/<name>/SKILL.md` carries the version in its frontmatter. This repo is
a **publish target**: its contents are synced from the private application
repository on each skill release and are not edited here directly. Issues
and questions are welcome on this repo.

## License

MIT — see [LICENSE](LICENSE).
