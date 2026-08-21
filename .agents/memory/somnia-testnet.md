---
name: Somnia testnet boundary
description: Durable network constraint for the DreamDEX Event Contracts bot.
---

The initial bot must operate only on Somnia Shannon testnet (chain ID 50312). Do not introduce mainnet defaults, mainnet RPCs, or mainnet wallet flows without explicit user approval.

**Why:** The user has STT testnet tokens and wants to validate the bot safely for the hackathon before considering any production network.

**How to apply:** Keep testnet values in examples and runtime validation, use a dedicated testnet wallet, and make any future mainnet support an explicit opt-in rather than an implicit configuration.