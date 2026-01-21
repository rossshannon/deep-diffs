/**
 * Example usage of DeepDiff
 */

import { deepDiffHtml, computeDeepDiff, getDefaultStyles } from './src/deep-diff.js';

// Your original test case
const revisions = [
  `Metamorphosis is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation.
Metamorphosis usually accompanies a change of habitat or of habits. In some species, however, it is merely development through a series of forms which may represent ancestral stages of the species; see ontogeny recapitulates phylogeny.`,

  `Metamorphosis in biology is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. It was once thought that in those cases where the animal's habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.`,

  `Metamorphosis in cosmology is a physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. It was once thought that in those cases where the animal's habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.`,

  `Metamorphosis in cosmology is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. I put in a new sentence here, yo. It was once thought that in those cases where the animal's habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.`,

  `Metamorphosis in cosmology is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. I put in a new bunch of words here, yo. It was once thought that in those cases where the animal's habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.`,

  `Metamorphosis in cosmology is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. I put in a new collection of words here, yo. It was once thought that in those cases where the animal's habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.`
];

// Simple HTML output
const html = deepDiffHtml(revisions);
console.log(html);

// Or get markers separately for custom rendering
const { text, markers } = computeDeepDiff(revisions);
console.log(`\nFinal text length: ${text.length}`);
console.log(`Active markers: ${markers.length}`);
markers.forEach((m, i) => {
  const snippet = text.slice(m.start, m.end + 1);
  console.log(`  ${i}: [${m.start}-${m.end}] "${snippet.slice(0, 30)}${snippet.length > 30 ? '...' : ''}"`);
});

// Generate CSS
console.log('\n--- Default CSS ---');
console.log(getDefaultStyles(5));
