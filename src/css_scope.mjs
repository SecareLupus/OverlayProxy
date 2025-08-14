import postcss from 'postcss';
import selParser from 'postcss-selector-parser';

// Build a transformer that prefixes every normal selector with the scope, and
// rewrites html/body/:root to target the scope container.
function makeSelectorTransformer(scope) {
  // Base pseudo AST we can clone for prefixing/replacement
  const basePrefix = selParser().astSync(`:where(${scope})`).first.nodes[0];

  return selParser((selectors) => {
    selectors.each((sel) => {
      let hasRoot = false;

      sel.walk((node) => {
        if (
          (node.type === 'pseudo' && node.value.toLowerCase() === ':root') ||
          (node.type === 'tag' && /^(html|body)$/i.test(node.value))
        ) {
          hasRoot = true;
        }
      });

      if (hasRoot) {
        const only = basePrefix.clone();
        only.spaces.after = '';
        sel.nodes = [only];
      } else {
        const pref = basePrefix.clone();
        pref.spaces.after = ' ';
        sel.prepend(pref);
      }
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
