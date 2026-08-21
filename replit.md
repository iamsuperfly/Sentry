# DreamDEX Event Contracts Telegram Bot

A Telegram trading bot for DreamDEX Event Contracts on Somnia Shannon testnet, with optional Agent-Reach sentiment signals and Supabase-backed history and settings.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- Somnia Shannon testnet is the only supported network for the initial build (chain ID `50312`).
- DreamDEX Event Contracts are accessed through `@somnia-chain/markets-sdk`; the spot HTTP API is not used for Event Contracts.
- Supabase SQL migrations are committed to the repository for manual execution by the project owner.
- The bot's core trading rules must work without Agent-Reach; sentiment is an optional signal layer.
- All repository changes are made on branches and delivered through pull requests, never directly to `main`.

## Product

The bot will let Telegram users configure testnet trading preferences, execute rule-based Up/Down Event Contract trades, and review trade history and performance. Bot decisions and optional sentiment inputs will be logged for transparency.

## User preferences

- The owner runs the Supabase SQL manually in their Supabase project.
- The initial deployment and all wallet activity must remain on Somnia Shannon testnet.
- Changes must be delivered as pull requests for owner review and merge.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
