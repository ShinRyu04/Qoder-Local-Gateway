# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0-mod] - 2026-11-08

### Added

- **Current global model registry**: added `sonus` (SOTA-exclusive), `fast`, `kimi-k3.1-pro`, `kimi-k2.8-preview`, `minimax-m3.1-flash`, `deepseek-flash`, and `deepseek-v4.1-flash`. Documented that unavailable models silently fall back to `auto`, that `QODERCN_STRICT_MODELS` only validates the registry, and that only Sonus consumes SOTA credits while they remain valid.
- **OMP integration docs**: `~/.omp/agent/models.yml` provider example and model list verification.
- **Multi-account profiles**: profiles are stored in `~/.qorder-proxy/profiles.json`; each one spawns the CLI with its own `USERPROFILE`/`HOME`, so `~/.qoder/.auth` is isolated. Manual selection via `x-qoder-profile`, `QODER_PROFILE`, or the dashboard. **Experimental automatic rotation** (global backend) parks a profile on quota/rate/billing/auth errors and retries the next healthy account in the same request, with a 15-minute cooldown. This may violate Qoder's terms; use only your own accounts, at your own risk. Disable with `QODER_PROFILE_ROTATION=off`.
- **Deadline pacing**: `POST /usage/target` accepts a `deadline`, and `/usage/burn-rate` reports `hoursLeft`, `requiredRatePerHour` and `pace` (`ahead`/`on_track`/`behind`). The dashboard exposes a date field next to the remaining-credit target.
- **Strict model allowlist**: `QODERCN_STRICT_MODELS=1` rejects unknown models with 400 instead of falling back to `auto`.
- **Indonesian/English UI switcher**: the console's remaining Chinese labels are gone; every page title, description, status, button, placeholder and dynamic message switches between Indonesian and English from the top-right selector, persisted in `localStorage`.
- **Accounts tab + OAuth login links**: profiles moved out of the Usage page into their own Accounts menu. `POST /accounts/login` starts `qodercli login` with the profile's isolated home, returns the `https://qoder.com/device/...` URL, and keeps the child alive for the callback; the dashboard shows the link, polls status, and flips to `logged in` automatically. One-click connect: a label-only **Hubungkan akun** button generates the profile name and home (`~/.qoder-profiles/<name>`), starts the OAuth login, and shows **Buka halaman izin** / **Salin tautan** / **Batal** plus a waiting status. Cancel also removes the profile created by that flow (`POST /accounts/login/cancel`). Transient `.credential-transaction` / `machine_id` files no longer count as authenticated.
- **Accounts API**: `GET /accounts`, `POST /accounts`, `POST /accounts/active`, `DELETE /accounts`.
- **CLI-reported credit metering**: both CLI runners parse `total_credits`, `total_cost_usd` and `modelUsage` from the CLI's final `result` record and report them through a new `onUsage` callback. `/usage/local` now exposes `creditsTotal`, `creditsToday`, `creditsByModel`, `creditsCostUsd` and `source: "cli-reported"` alongside the existing estimates.
- **Burn-rate tracker**: credit samples are persisted append-only to `usage-events.jsonl` (no concurrent read-modify-write races). `/usage/burn-rate`, `GET/POST /usage/target` and the Usage dashboard project depletion from a manually entered remaining balance. The official quota panel remains the source of truth.
- **Daemon mode**: `npm run daemon start|stop|restart|status|logs` with state in `~/.qorder-proxy/`, plus `start-proxy-hidden.vbs` for windowless startup on Windows.

### Fixed

- **Global backend no longer needs a dummy `QODER_PAT`**: `CLI_BACKEND=global` authorizes through the OAuth state in `~/.qoder/.auth`, and a missing login now returns a clear 401 instead of a token-configuration error.
- `buildChildEnv` no longer injects an empty/undefined token variable into the CLI process.

### Changed

- Lifetime credit totals now come from `usage.json` and no longer shrink when the 7-day event log is pruned; events are only rebuilt on a missing snapshot. Credit samples also record the serving profile (`creditsByProfile`).
- Token counters stay `estimated`: qodercli currently reports `input_tokens`/`output_tokens` as 0 under plan metering, so they are not presented as real values. `extractCliUsage` exposes `tokensAvailable` so this can be revisited if the CLI starts reporting them.
