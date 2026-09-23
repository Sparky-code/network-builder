// Compiles tokens/design-tokens.json (W3C DTCG format) into the token
// stylesheet for BOTH tiers of the frontend-ui-stack skill — GENERATED,
// do not hand-edit either output:
//
//   src/styles/tokens.css                     (React/Tailwind tier)
//   ../plain-html-fallback/tokens.css         (zero-build tier)
//
// Both destinations are emitted from this one source so the two tiers
// cannot drift. The fallback copy used to be maintained by hand-copying
// the React output across; that made drift a matter of remembering, which
// is exactly the failure mode the token set exists to prevent.
//
// A custom format is required (rather than Style Dictionary's stock
// `css/variables` format) because color roles need to be split into a
// `:root[data-theme="light"]` / `:root[data-theme="dark"]` structure, and
// everything else (spacing, type, elevation, radius, motion) needs to stay
// flat. The [data-theme="..."] selectors are written with the `:root`
// element compounded in (rather than a bare attribute selector) so they
// have higher specificity (0,2,0) than a plain `:root` fallback block
// (0,1,0) within this same file, guaranteeing the active theme always wins
// regardless of source order.
import StyleDictionary from 'style-dictionary';

/**
 * @param {import('style-dictionary/types').TransformedToken[]} tokens
 * @param {(token: import('style-dictionary/types').TransformedToken) => boolean} predicate
 */
function pick(tokens, predicate) {
  return tokens.filter(predicate);
}

function cssVarLine(name, value) {
  return `  --${name}: ${value};`;
}

const sd = new StyleDictionary({
  source: ['tokens/design-tokens.json'],
});

sd.registerFormat({
  name: 'css/design-tokens-with-theme-split',
  format: ({ dictionary }) => {
    const all = dictionary.allTokens;

    const space = pick(all, (t) => t.path[0] === 'space');
    const type = pick(all, (t) => t.path[0] === 'type');
    const elevation = pick(all, (t) => t.path[0] === 'elevation');
    const radius = pick(all, (t) => t.path[0] === 'radius');
    const motion = pick(all, (t) => t.path[0] === 'motion');
    const colorLight = pick(all, (t) => t.path[0] === 'color' && t.path[1] === 'light');
    const colorDark = pick(all, (t) => t.path[0] === 'color' && t.path[1] === 'dark');

    const spaceLines = space.map((t) => cssVarLine(`space-${t.path[1]}`, t.$value));

    const typeLines = type.map((t) => cssVarLine(`type-${t.path[1]}-${t.path[2]}`, t.$value));

    const elevationLines = elevation.map((t) => cssVarLine(`elevation-${t.path[1]}`, t.$value));

    const radiusLines = radius.map((t) => cssVarLine(`radius-${t.path[1]}`, t.$value));

    const motionLines = motion.map((t) => cssVarLine(`${t.path[1]}-${t.path[2]}`, t.$value));

    const lightColorLines = colorLight.map((t) => cssVarLine(`color-${t.path[2]}`, t.$value));
    const darkColorLines = colorDark.map((t) => cssVarLine(`color-${t.path[2]}`, t.$value));

    return `/**
 * GENERATED FILE — do not hand-edit.
 * Source: tokens/design-tokens.json
 * Compiled by: style-dictionary.config.js (npm run tokens:build)
 */

:root {
  /* Spacing (8px grid + half-step) */
${spaceLines.join('\n')}

  /* Type scale (Material-3-inspired minimalist subset) */
${typeLines.join('\n')}

  /* Elevation / shadow scale */
${elevationLines.join('\n')}

  /* Radius scale */
${radiusLines.join('\n')}

  /* Motion */
${motionLines.join('\n')}

  /* Color roles — light is the default/fallback before data-theme is set */
${lightColorLines.join('\n')}
}

:root[data-theme='light'] {
${lightColorLines.join('\n')}
}

:root[data-theme='dark'] {
${darkColorLines.join('\n')}
}
`;
  },
});

sd.platforms = {
  css: {
    transformGroup: 'css',
    files: [
      {
        destination: 'src/styles/tokens.css',
        format: 'css/design-tokens-with-theme-split',
      },
      // The template also emits a copy for the workspace's plain-HTML tier.
      // That target is removed here: from apps/game it would resolve to
      // apps/plain-html-fallback/tokens.css and drop a stray file in the repo.
    ],
  },
};

await sd.hasInitialized;
await sd.buildAllPlatforms();
