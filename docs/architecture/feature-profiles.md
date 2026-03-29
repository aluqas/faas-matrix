# Feature Profiles

Feature profiles are defined in `src/foundation/config/feature-profile.ts`.

Profiles:

- `full`
  - current default behavior
- `core`
  - keeps core Matrix behavior while disabling selected optional capabilities
- `lite`
  - reserved for a lean Matrix profile and currently acts as a declared gating surface

Current gates:

- `adminApi`
- `e2ee`
- `federation`
- `media`
- `mediaPreviews`
- `presence`
- `pushNotifications`
- `slidingSync`

Runtime selection is controlled by `MATRIX_FEATURE_PROFILE`, defaulting to `full`.
