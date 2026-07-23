# Changelog

## 0.2.0 - 2026-07-23

### Changed

- Require Pi 0.80.5 or newer and update development against Pi 0.81.1.
- Update TypeScript to 7.0.2.

### Fixed

- Finalize approved implementation runs only after Pi emits `agent_settled`, including retries and compaction continuations.
- Keep mutation permissions fail-closed when approval input is transformed, rejected before agent start, or interrupted by reload.

### Added

- Add regression tests for settled-run lifecycle, approval preflight, retries, failures, and reload races.
