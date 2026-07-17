# Implement federated polls

## Summary

Define poll creation and voting over the Headwater transport before enabling
poll controls.

## Requirements

- Define signed poll creation, expiry, single/multiple voting, result aggregation, and replay protection.
- Implement poll create/read/vote API responses and persistent state.
- Advertise `polls: true` only with relay-tested federation semantics.

## Acceptance Criteria

- Daemon, frontend, restart, and relay tests cover poll creation, voting, expiry, and results.
