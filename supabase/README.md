# Supabase setup

This project stores Telegram users, trading preferences, DreamDEX trade
history, bot decisions, and performance summaries in Supabase.

## Apply the schema

1. Open the SQL Editor in your Supabase project.
2. Create a new query.
3. Paste and run `supabase/migrations/0001_initial_schema.sql`.
4. Confirm that the five tables appear under **Table Editor**.

The migration enables Row Level Security on every table. The bot backend is
expected to use a server-side Supabase connection; no service-role key should
ever be shipped to a client or committed to Git.

## Required runtime values

Copy `.env.example` to your local environment or Replit Secrets and fill in
the Supabase URL and server-side key there. Never commit a real `.env` file.

The initial trading configuration is deliberately restricted to Somnia
Shannon testnet:

- Chain ID: `50312`
- RPC: `https://dream-rpc.somnia.network`
- Explorer: `https://shannon-explorer.somnia.network`

The application should reject startup if a non-testnet chain is configured.