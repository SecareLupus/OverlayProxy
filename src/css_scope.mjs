import postcss from 'postcss';
import selParser from 'postcss-selector-parser';

// Build a transformer that prefixes every normal selector with the scope, and
// rewrites html/body/:root to target the scope container.
function makeSelectorTransformer(scope) {
  return selParser((selectors) => {
    selectors.each((sel) => {
      // Replace :root, html, body with the scope (no descendant)
      sel.walk((node) => {
        if (
          (node.type === 'pseudo' && node.value.toLowerCase() === ':root') ||
          (node.type === 'tag' && /^(html|body)$/i.test(node.value))
        ) {
          // Replace whole selector with `scope`
          sel.nodes = [selParser.selector({ nodes: [selParser.universal()] })].nodes; // reset
          sel.nodes = [selParser.selector({ nodes: [] })].nodes; // ensure empty
          const nsAst = selParser().astSync(scope).first;
          sel.nodes = nsAst.nodes[0].nodes; // copy contents of scope selector
        }
      });

      // If selector still has content (not replaced), prefix with scope (zero specificity via :where)
      const prefix = selParser().astSync(`:where(${scope}) `).first;
      sel.prepend(prefix.nodes[0].nodes[0]); // prepend :where([data-ov="..."])␠
    });
  });
}

export async function scopeCss(cssText, scopeSelector) {
  const scope = scopeSelector; // e.g. [data-ov="blerps"]
  const transform = makeSelectorTransformer(scope);

  const result = await postcss([
    {
      postcssPlugin: 'overlay-scope',
      Once(root) {
        root.walkRules((rule) => {
          // Skip keyframes blocks
          if (rule.parent && rule.parent.type === 'atrule') {
            const at = rule.parent;
            if (/^keyframes$/i.test(at.name)) return;
          }
          if (!rule.selector) return;
          // Don’t touch @font-face etc. (they’re rules without selectors)
          try {
            rule.selector = transform.processSync(rule.selector);
          } catch (_) { /* best-effort; skip broken selectors */ }
        });
      }
    }
  ]).process(cssText, { from: undefined });
  return result.css;
}
