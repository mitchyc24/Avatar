# Custom SVG avatars

Instead of the built-in cartoon, anyone in a call can use their own SVG drawing. Face tracking animates it, and
the other person sees it too. The app doesn't need to understand the artwork. It finds parts by their `id` and
moves, squashes and swaps them, so any drawing style works as long as the parts are named.

**Quickest route:** in the lobby, click **Copy AI prompt**, open ChatGPT (or another AI that can see images and
write SVG), attach a photo of yourself, paste the prompt, and upload or paste the result back into the app. The
prompt is in [`public/assets/avatar-prompt.txt`](../public/assets/avatar-prompt.txt). For a hand-made starting
point, use [`public/assets/avatar-template.svg`](../public/assets/avatar-template.svg) (also behind the
**Download template** button).

## Canvas

- A `viewBox` is required. `0 0 400 400` is recommended, and the motion amounts are tuned for a head about 180–200 units wide in that box.
- Leave out `width`/`height`. They're removed, and the avatar scales to fit its tile.
- Leave the background transparent. The app paints the background colour the user picks.
- Draw the avatar front-facing with a neutral expression: eyes open, looking ahead, mouth closed.

## Parts

Parts are found by `id`. Matching ignores case and treats `eyeLeft`, `eye_left` and `eye-left` the same.
**Left/right always mean the left/right side of the picture as you look at it.** Only `head` is needed for basic
motion. Without the recommended parts the avatar still works, but those features don't animate.

| id | | What it is | How it's animated |
| --- | --- | --- | --- |
| `head` | required | Group containing everything that moves with the head | Moves with your head position, tilts (rolls) around the neck, scales slightly as you lean in |
| `body` | | Neck, shoulders, clothes (outside `head`) | Follows head position at half strength |
| `eye-left`, `eye-right` | recommended | An open eye: white, iris, pupil | Squashed vertically to blink, squint or widen; shifts with head turn |
| `pupil-left`, `pupil-right` | recommended | Iris/pupil, ideally *inside* its eye group | Slides with your gaze (about ±20% of the eye width) |
| `eye-left-closed`, `eye-right-closed` | | A closed eye in the same spot | Replaces the open eye during a blink (otherwise the open eye just squashes flat) |
| `brow-left`, `brow-right` | | Eyebrows | Rise and fall; the inner ends tilt up when worried and down when frowning |
| `nose` | | Nose | Shifts the most on head turns (it's closest to the viewer) |
| `mouth` | recommended | Closed, neutral mouth | Shown at rest; widens for smiles and narrows for puckers. Without `mouth-open`, it is stretched vertically to talk |
| `mouth-open` | | Fully open mouth, same spot, top edge level with `mouth` | Replaces `mouth` while talking, stretched from its top edge by how open your jaw is |
| `mouth-smile` | | Closed smiling mouth | Replaces `mouth` when you smile with your mouth closed |
| `jaw` | | Chin or beard | Drops as the mouth opens |
| `cheeks` | | Blush | Opacity rises with smiling (35%–100%) |
| `glasses` | | Glasses | Move with the eyes |
| `ears` | | Both ears | Shift opposite to head turns |
| `hair-back` | | Hair behind the head | Shifts slightly opposite to head turns (depth) |
| `hair-front` | | Fringe/bangs over the forehead | Shifts slightly with head turns (depth) |

Head turns (yaw) and nods (pitch) are suggested by parallax. Parts closer to the viewer slide further than
parts at the back, so a flat drawing reads as turning.

**Variants are drawn visible.** Draw `eye-*-closed`, `mouth-open` and `mouth-smile` in place and fully visible in
the file, without `opacity="0"` or `display="none"`. The app hides and shows them by setting opacity on a wrapper
it adds around each part. Each part keeps its own `transform` attribute, so parts can be positioned however you like.

### Skeleton

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <defs><!-- gradients, clip paths --></defs>
  <g id="body">…</g>
  <g id="head">
    <g id="hair-back">…</g>
    <g id="ears">…</g>
    <!-- face shape, no id -->
    <g id="cheeks">…</g>
    <g id="eye-left">  <!-- eye white -->  <g id="pupil-left">…</g>  </g>
    <g id="eye-right"> <!-- eye white -->  <g id="pupil-right">…</g> </g>
    <g id="eye-left-closed">…</g>
    <g id="eye-right-closed">…</g>
    <g id="brow-left">…</g>
    <g id="brow-right">…</g>
    <g id="nose">…</g>
    <g id="mouth">…</g>
    <g id="mouth-smile">…</g>
    <g id="mouth-open">…</g>
    <g id="jaw">…</g>
    <g id="glasses">…</g>
    <g id="hair-front">…</g>
  </g>
</svg>
```

Any element type can carry a part id (a single `<path id="nose">` is fine). Later elements are drawn on top.

## What's allowed

A custom SVG is sent to the other person, so both sides clean it against an allowlist before showing it. Anything
outside the allowlist is removed, and the upload panel lists what was removed.

- **Elements:** `svg g path rect circle ellipse line polyline polygon defs title desc linearGradient radialGradient stop clipPath mask pattern use symbol text tspan image filter` and the basic `fe*` filter primitives (`feGaussianBlur feOffset feBlend feColorMatrix feFlood feComposite feMerge feMergeNode feDropShadow feMorphology`). `<a>` becomes a plain group.
- **Attributes:** geometry, presentation (`fill`, `stroke`, `opacity`, …), `transform`, gradient/clip/mask/filter attributes, `id`, and `style` limited to presentation properties.
- **References:** only within the file (`url(#id)`, `href="#id"`). `<image>` may embed PNG/JPEG/GIF/WebP as a `data:` URI. Anything that points outside the file is removed.
- **`<style>` blocks:** simple rules (`.skin{fill:#c96}`, `path{…}`, `#id{…}`, `rect.x{…}`) are copied onto the matching elements, then the block is dropped. More complex selectors are ignored.
- **Always removed:** scripts, `on…` event attributes, `<foreignObject>`, animation elements (`animate`, `set`, …), editor metadata (Inkscape/Illustrator namespaces), `class`.

**Limits:** 1 MB for the uploaded file, and 200 KB after cleaning. The cleaned file is what gets stored and sent.
Embedded raster images use up that budget quickly.

## How it travels

The cleaned SVG is saved in your browser and sent to the other person over the call's encrypted data channel
when you connect, and again whenever you change it, in 16 KB chunks. The receiver cleans it again before
showing it. Ids are prefixed per instance, so two custom avatars on one page never clash.
