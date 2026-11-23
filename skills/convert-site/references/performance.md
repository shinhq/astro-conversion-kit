# Performance after parity

Run this pass on `astro-rebuild` after the full gates and visual review. Evaluate all seven
items below. Apply a change when it improves a measured bottleneck and the affected parity and
interaction checks pass. Keep the original capture and baseline as the source of truth and
record changes in the Decisions table in `docs/plan.md`. Use the existing proposal workflow for
changes to copy, palette, visible controls, form behavior, or other user-facing differences.

A plain conversion request includes this work. Begin the image inventory from the saved capture.
If a parity issue holds up release verification, test candidates offline and continue any other
independent measurements. Fix the gate and verify the integrated changes before accepting them.
A hosting login, a remote push or a PR approval is unnecessary for the local pass.

## Measure the starting build

The scaffold pins Lighthouse and Sharp. From the converted site run

    npm run optimize -- -- <same verify flags as phase 7>

With no flags, run `npm run optimize`. It saves the starting audit, builds and verifies the optimized site,
then saves the comparison audit. Retries reuse a completed starting measurement. Use the same flags as `npm run
verify:release`, including site-specific form flags and `--allow-extra` if applicable. Set
`CHROME_PATH` if needed. The runner serves an isolated, verified release build on loopback. It
blocks known analytics and predecessor hosts. Supply extra tracker hosts from `docs/third-party.md`
with `--block-hosts`. The audit measures initial loading with those requests blocked. Assess
analytics timing and attribution separately using stubbed requests. Use the existing staging
audit to evaluate hosting, compression, and cache behavior.

The default scope is `/` and each representative in `capture/templates.json`, on mobile and
desktop. Add important flows not represented by a template with `--routes` (include the default
routes in that list). Use `--runs 3` for noisy performance results and match the run count in
both rounds. The summary includes Performance, Accessibility, Best Practices, SEO, LCP, CLS,
TBT and image transfer bytes where Lighthouse measures them. The score target is 90 per category.
Exit 1 reports measured scores below target. Explain intentionally nonindexable routes in the
report and retain their scores. Exit 2 means the audit is incomplete. Try a recoverable build,
verification, dependency, or browser fix first. If coverage remains unavailable, quote the
reason under **Not covered** and continue only with independently measured changes, such as a
verified asset transfer reduction. Apply phase 7 and launch gates as written.

For store media, the audit serves matching captured cache files from `.conversion/media-cache/`
at the requested paths. Report cache use and missing resources. `audit:lighthouse -- --preview` measures the
current `dist/`; its SEO results include the intended preview noindex and robots directives.

## Build the optimized site

The build inside `npm run optimize` runs in phase `performance`. The scaffold's Astro
integration tries WebP for locally built JPEG and PNG images, keeps smaller encodings and adds
a typed picture source. The original img remains the fallback. Width-descriptor sets keep their
existing widths and sizes. This runs again on later local, release and hosted builds. The scaffold
records the parity-only intake choice in its config so the host respects it without local state.

Inspect `docs/image-optimization.json` for the paths, dimensions, byte counts, hashes and pages
changed by the build. Commit this report. Check resource selection and the visual review.
For a regression, exclude the affected original path in the integration's `exclude` array,
document the measurement and rebuild. Continue through all seven checks below. Art-directed,
preloaded, dynamic, externally stored and CSS images, and new responsive widths that need layout
measurements, require site-specific work.

For an older scaffold, copy the current kit's audit runner and the two scripts from
`skills/convert-site/templates/site/scripts/` to the site's `scripts/`. Add the template's
`optimize` npm command, pin `sharp@0.35.5` and `lighthouse@13.6.0` as dev dependencies, and
import and register `imageOptimization()` in its Astro config after link normalization.
For a parity-only site, use `imageOptimization({ enabled: false })`.

## Default optimization checklist

1. **WebP encoding and image localization.** Inventory captured image URLs in markup, lazy
   attributes, CSS, masks, posters, and galleries. Use a site-local encoder such as pinned Sharp
   to generate smaller WebP derivatives offline. Retain originals at their existing URLs, use
   lossless encoding for graphics as needed, and check color, transparency, crop and orientation.
   Preserve existing SVGs, GIF or other animation, icons, incompatible color profiles, gallery
   originals and social/structured-data assets. Maintain a source-to-derivative manifest with
   dimensions, hashes and byte sizes. If bytes are missing, use the existing paced capture tools
   and a separate capture folder. Confirm output asset count and file sizes fit the hosting plan.
2. **Responsive image delivery.** Use the largest compatible captured source, keeping existing
   crop and picture art direction. Use `srcset` widths based on measured layouts and DPR, bounded
   by the source width. Keep accurate captured `sizes` or derive them from the layout. Retain
   fallback URLs, dimensions, alt text, and lazy attributes. Supply missing intrinsic dimensions
   when safe. Keep density-descriptor sets and art-directed sources unless verified independently.
   Wire generation into the site's build where needed, and use a cache keyed by source bytes,
   encoder version and settings. Verify cache hits against output hashes and fail clearly on
   missing inputs. Run the build offline after the initial capture.

   For these first two checks, trial eligible captured raster images with the encoder and compare
   original and candidate bytes. Wire the winning candidates into the templates that use them.
   On mobile and desktop, record a representative route, the browser's selected URL
   (`currentSrc` for an image), delivered width and bytes. An existing WordPress srcset or a
   hero preload alone leaves encoding and sizing untested. If originals win, record the trial.
   If there are no eligible sources, cite the inventory and explain the exclusions. Serve generated assets through Astro's
   asset pipeline or allow the derivative paths from the manifest on the routes gate. Keep all
   original media paths available.

3. **Hero and below-fold loading.** Inspect each representative's LCP element and request timings.
   Use an eager image, a matching preload or high priority only where it helps. Lazy-load
   below-fold images and iframes where safe. For captured autoplay heroes, paint the still at
   the same crop and size, then set the video source after initial assets and paint. Keep the
   still through playback failure or reduced-motion mode and verify autoplay after first paint.
4. **CSS and fonts.** Use local captured sheets and the kit's coverage pruning. Preserve rule
   order, media queries and dynamic selectors, including sticky headers and active plugin states.
   Inline small critical blocks where justified by the cascade and timing. Self-host captured
   font subsets used on the page, preserving family, weight, style and Unicode ranges. Preload
   only measured critical faces and defer widget-only fonts until they are needed.
5. **Initial layout and widgets.** Render the captured initial open accordion or tab state before
   its script runs. Use the widget's own deferred mounting mode, where available, for offscreen
   galleries or sliders. Check sticky navigation, menus, tabs, galleries, keyboard focus, and
   scrolling in all affected templates after pruning or changing initialization timing.
6. **First-party JavaScript.** Defer blocking scripts where safe and preserve classic execution
   order, dependencies and globals. Consolidate compatible local scripts only when useful.
   Remove demonstrably unused WordPress runtime code after checking its dependencies and testing
   the functionality it could affect, especially menus, forms and media plugins.
7. **Analytics and tags.** Follow `third-party.md`. Move eligible noncritical tags out of the
   render path and honor the captured independence of async tags. Preserve consent, IDs, page
   coverage, queued events, ordering dependencies and attribution already used by forms.
   Verify script-gate recognition and exercise consent, async independence and failure in a
   local browser with stubbed vendors. Confirm failed or blocked tracking cannot prevent form
   use. Keep the launch workflow's rules for actual form submissions.

## Accept and report the result

After any further changes, rerun the audit into `review/lighthouse/after` with identical routes, devices, threshold,
extra blocked hosts and repetition count. Review the transfer savings and candidate selection
with browser network evidence. Re-run phase 7 and phase 8, including representative screenshots
at 390, 768 and 1440 px, computed styles, the all-page visual review and affected interactions.
Reuse the saved live screenshots for comparisons. Revert changes that fail validation and keep
the remaining measured improvements as a separate conversion-branch commit.

Write `docs/performance.md` with the sampled route/device matrix, before-and-after scores and
metrics, image transfer bytes, checklist results, verification results, and **Not covered**.
Use one level-three heading per checklist item, copying its bold name above without the final
period. Begin its first paragraph with one of the following outcomes and an em dash.

- `Applied —` give the affected routes or assets, measured change and validation.
- `Verified unchanged —` give the comparison or test that justified keeping the original.
- `Not applicable —` identify the inventory or template inspection that established absence.
- `Blocked —` record the concrete blocker and remaining work. Resume here and complete the
  other checks that can run independently. This outcome keeps the pass open.

For example, a site with no tracking might record the following entry.

    ### Analytics and tags

    Not applicable — baseline/scripts.json contains no vendors and the captured heads contain no tracking tags.

Keep the compact before/after summaries with the report so another checkout can verify the run.
The full review directory is ignored. Stage just the summaries with
`git add -f review/lighthouse/before/summary.json review/lighthouse/after/summary.json`.
Quote the summaries' coverage gaps under `## Not covered`. If release Lighthouse remains unavailable
after retrying, also quote its errors and provide independent evidence for every checklist decision.
A below-target score still counts as a measurement. Preview scores can supplement the report.
Run `S check-performance` (the state command from phases.md) before any handoff.

Record which measured opportunities were resolved and which remain as suggestions or proposals.
For `parity only`, record the intake choice and skip the measurement and optimization steps.
