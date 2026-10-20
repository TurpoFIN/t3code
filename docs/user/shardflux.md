# Shardflux

This build of T3 Code runs every thread on [Shardflux](https://shardflux.dev). Projects, threads,
diffs, the terminal and Git work as usual; the agent works in the thread's own cloud computer, and
its changes come back to your project folder.

## Set up

1. Install the Shardflux CLI and sign in: `npm install -g @shardflux/cli`, then `shard auth login`.
2. Save a project API key with `shard setup`, or set `SHARDFLUX_API_KEY`. The thread terminal and
   Git use it.
3. Start T3 Code, add a project folder, and start a thread. Pick **Claude Code** or **Codex** and a
   model in the composer.

## How a thread runs

- **The agent** works in a cloud computer that starts from your folder as it is, including
  uncommitted changes. Later messages in the thread reuse the same computer.
- **Files** sync both ways before and after every message, so the thread's diff and the Changes
  panel show the agent's edits in your folder. Commit and push them as usual.
- **Git**: the agent works on its own branch, `shard/<name>`. When a message finishes, that branch
  appears in your repository as `shardflux/<name>`; your checked-out branch is not moved.
- **Terminal**: a thread's terminal opens in its cloud computer, in the project. Before the first
  message it waits for the computer to start.

To run agents on this machine instead, start T3 Code with `T3CODE_EXECUTION_BACKEND=local`.
