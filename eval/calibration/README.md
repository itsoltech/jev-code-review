# Preset calibration (excluding maintainability)

Measured with `jev-1.13.0` on 2026-09-24. All **18** other built-in presets are covered: **76 rules and two score dimensions**. Each family report contains per-rule positive/negative labels, confirmed true/false findings, positive and clean human reviews, misses, decisions, reproduction commands and raw-answer locations.

| Presets | Measurements and decisions |
| --- | --- |
| `base`, `security`, `correctness`, `tests` | [Core safety](core/README.md): 11 rules remain enabled; `tests.missing` disabled after two false alarms on the reserved PRs. |
| `style`, `recommended`, `conventional-title` | [Style and composition](meta-title/README.md): five title rules remain enabled; `style.naming` and `recommended.change_focus` disabled. `style.readability` remains an advisory score, not an automatic finding. Recommended now resolves to 11 inherited rules. |
| `pr-template`, `pr-description`, `docs-sync` | [PR text and documentation](pr-docs/README.md): 14 rules remain enabled; two docs regex rules disabled. PR-body context corrected for standalone template and docs presets. |
| `result-errors`, `electron`, `svelte5` | [Frameworks](frameworks/README.md): all 14 rules remain enabled, with a measured Electron platform-guard correction. |
| `theming`, `pattern-matching`, `type-hygiene`, `async-state` | [Conventions](conventions/README.md): three deterministic rules disabled after noise/insufficient natural evidence; async stale-write is human-first, **not** guaranteed human-only. |
| `code-slop` | [Code slop](code-slop/README.md): 24 rules retain automatically confirmed **nonblocking advisory** findings with conditional human review; one noisy human-band floor corrected in this calibration. Preexisting `insufficient_context` abstain labels on all 24 rules prevent opt-in approval with default `no_abstentions: true`; approval is off by default, and abstentions do not themselves fail the check or request changes. |

The reserved slice was frozen in [preset-holdout.json](../preset-holdout.json) before this calibration: canopy-desktop PRs 284, 285, 286, 287 and 289. Most rules had **no positive violations** in these five PRs, so their holdout recall and precision are undefined. The PR titles/descriptions already appeared in earlier labeled data; this is not a fully blind prospective holdout. `tests.missing` was disabled in response to its holdout false positives: that result is a go/no-go diagnostic, not untouched final validation. The type-hygiene training initially reused PR 286 source; its rows were replaced and remeasured, but the already-observed type holdout is not independent. Many development positives are explicit mutations or authored fixtures rather than natural failures; individual reports distinguish them. Automatic *finding* is distinct from automatic *blocking*: do not promote advisory severities to merge gates on these small, selected samples.

For maintainability, use the separate [maintainability report](../maintainability/README.md); it was not recalibrated here.
