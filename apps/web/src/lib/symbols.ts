/**
 * Symbols for the symbol palette: [command, name, glyph]. Loaded only when the palette opens. Commands outside
 * the LaTeX kernel note their package in the name (amssymb).
 */
export type MathSymbol = { command: string; name: string; glyph: string; category: SymbolCategory };
export type SymbolCategory = 'Greek' | 'Relations' | 'Operators' | 'Arrows' | 'Big operators' | 'Sets and logic' | 'Delimiters' | 'Accents' | 'Misc';

const raw: Record<SymbolCategory, Array<[string, string, string]>> = {
  Greek: [
    ['\\alpha', 'alpha', 'α'], ['\\beta', 'beta', 'β'], ['\\gamma', 'gamma', 'γ'], ['\\delta', 'delta', 'δ'],
    ['\\epsilon', 'epsilon', 'ϵ'], ['\\varepsilon', 'varepsilon', 'ε'], ['\\zeta', 'zeta', 'ζ'], ['\\eta', 'eta', 'η'],
    ['\\theta', 'theta', 'θ'], ['\\vartheta', 'vartheta', 'ϑ'], ['\\iota', 'iota', 'ι'], ['\\kappa', 'kappa', 'κ'],
    ['\\lambda', 'lambda', 'λ'], ['\\mu', 'mu', 'μ'], ['\\nu', 'nu', 'ν'], ['\\xi', 'xi', 'ξ'],
    ['\\pi', 'pi', 'π'], ['\\varpi', 'varpi', 'ϖ'], ['\\rho', 'rho', 'ρ'], ['\\varrho', 'varrho', 'ϱ'],
    ['\\sigma', 'sigma', 'σ'], ['\\varsigma', 'varsigma', 'ς'], ['\\tau', 'tau', 'τ'], ['\\upsilon', 'upsilon', 'υ'],
    ['\\phi', 'phi', 'ϕ'], ['\\varphi', 'varphi', 'φ'], ['\\chi', 'chi', 'χ'], ['\\psi', 'psi', 'ψ'],
    ['\\omega', 'omega', 'ω'], ['\\Gamma', 'capital gamma', 'Γ'], ['\\Delta', 'capital delta', 'Δ'], ['\\Theta', 'capital theta', 'Θ'],
    ['\\Lambda', 'capital lambda', 'Λ'], ['\\Xi', 'capital xi', 'Ξ'], ['\\Pi', 'capital pi', 'Π'], ['\\Sigma', 'capital sigma', 'Σ'],
    ['\\Upsilon', 'capital upsilon', 'Υ'], ['\\Phi', 'capital phi', 'Φ'], ['\\Psi', 'capital psi', 'Ψ'], ['\\Omega', 'capital omega', 'Ω'],
  ],
  Relations: [
    ['\\leq', 'less or equal', '≤'], ['\\geq', 'greater or equal', '≥'], ['\\neq', 'not equal', '≠'], ['\\approx', 'approximately equal', '≈'],
    ['\\equiv', 'equivalent, identical', '≡'], ['\\sim', 'similar to', '∼'], ['\\simeq', 'similar or equal', '≃'], ['\\cong', 'congruent', '≅'],
    ['\\propto', 'proportional to', '∝'], ['\\ll', 'much less than', '≪'], ['\\gg', 'much greater than', '≫'], ['\\prec', 'precedes', '≺'],
    ['\\succ', 'succeeds', '≻'], ['\\preceq', 'precedes or equal', '⪯'], ['\\succeq', 'succeeds or equal', '⪰'], ['\\doteq', 'approaches the limit', '≐'],
    ['\\asymp', 'asymptotic', '≍'], ['\\parallel', 'parallel', '∥'], ['\\perp', 'perpendicular', '⊥'], ['\\mid', 'divides', '∣'],
    ['\\models', 'models', '⊨'], ['\\vdash', 'proves', '⊢'], ['\\dashv', 'left tack', '⊣'], ['\\leqslant', 'less or equal, slanted (amssymb)', '⩽'],
    ['\\geqslant', 'greater or equal, slanted (amssymb)', '⩾'], ['\\lesssim', 'less than or similar (amssymb)', '≲'], ['\\gtrsim', 'greater than or similar (amssymb)', '≳'], ['\\triangleq', 'defined as (amssymb)', '≜'],
  ],
  Operators: [
    ['\\pm', 'plus or minus', '±'], ['\\mp', 'minus or plus', '∓'], ['\\times', 'times, cross product', '×'], ['\\div', 'divided by', '÷'],
    ['\\cdot', 'center dot, product', '⋅'], ['\\ast', 'asterisk', '∗'], ['\\star', 'star', '⋆'], ['\\circ', 'composition, ring', '∘'],
    ['\\bullet', 'bullet', '∙'], ['\\oplus', 'circled plus, direct sum', '⊕'], ['\\ominus', 'circled minus', '⊖'], ['\\otimes', 'circled times, tensor product', '⊗'],
    ['\\oslash', 'circled slash', '⊘'], ['\\odot', 'circled dot', '⊙'], ['\\wedge', 'logical and, wedge', '∧'], ['\\vee', 'logical or, vee', '∨'],
    ['\\cap', 'intersection', '∩'], ['\\cup', 'union', '∪'], ['\\setminus', 'set minus', '∖'], ['\\nabla', 'nabla, gradient', '∇'],
    ['\\partial', 'partial derivative', '∂'], ['\\sqrt{}', 'square root', '√'], ['\\frac{}{}', 'fraction', '½'], ['\\dagger', 'dagger', '†'],
    ['\\ddagger', 'double dagger', '‡'], ['\\amalg', 'amalgamation', '⨿'], ['\\wr', 'wreath product', '≀'],
  ],
  Arrows: [
    ['\\to', 'to, right arrow', '→'], ['\\rightarrow', 'right arrow', '→'], ['\\leftarrow', 'left arrow', '←'], ['\\leftrightarrow', 'left right arrow', '↔'],
    ['\\Rightarrow', 'implies', '⇒'], ['\\Leftarrow', 'is implied by', '⇐'], ['\\Leftrightarrow', 'if and only if', '⇔'], ['\\implies', 'implies (long)', '⟹'],
    ['\\iff', 'if and only if (long)', '⟺'], ['\\mapsto', 'maps to', '↦'], ['\\longrightarrow', 'long right arrow', '⟶'], ['\\longleftarrow', 'long left arrow', '⟵'],
    ['\\longmapsto', 'long maps to', '⟼'], ['\\uparrow', 'up arrow', '↑'], ['\\downarrow', 'down arrow', '↓'], ['\\updownarrow', 'up down arrow', '↕'],
    ['\\Uparrow', 'double up arrow', '⇑'], ['\\Downarrow', 'double down arrow', '⇓'], ['\\nearrow', 'north east arrow', '↗'], ['\\searrow', 'south east arrow', '↘'],
    ['\\swarrow', 'south west arrow', '↙'], ['\\nwarrow', 'north west arrow', '↖'], ['\\hookrightarrow', 'hook right arrow, inclusion', '↪'], ['\\rightleftharpoons', 'equilibrium', '⇌'],
  ],
  'Big operators': [
    ['\\sum', 'sum', '∑'], ['\\prod', 'product', '∏'], ['\\coprod', 'coproduct', '∐'], ['\\int', 'integral', '∫'],
    ['\\iint', 'double integral (amsmath)', '∬'], ['\\iiint', 'triple integral (amsmath)', '∭'], ['\\oint', 'contour integral', '∮'], ['\\bigcup', 'big union', '⋃'],
    ['\\bigcap', 'big intersection', '⋂'], ['\\bigoplus', 'big direct sum', '⨁'], ['\\bigotimes', 'big tensor product', '⨂'], ['\\bigvee', 'big or', '⋁'],
    ['\\bigwedge', 'big and', '⋀'], ['\\lim', 'limit', 'lim'], ['\\max', 'maximum', 'max'], ['\\min', 'minimum', 'min'],
    ['\\sup', 'supremum', 'sup'], ['\\inf', 'infimum', 'inf'], ['\\log', 'logarithm', 'log'], ['\\exp', 'exponential', 'exp'],
    ['\\sin', 'sine', 'sin'], ['\\cos', 'cosine', 'cos'], ['\\tan', 'tangent', 'tan'], ['\\det', 'determinant', 'det'],
    ['\\arg', 'argument', 'arg'], ['\\Pr', 'probability', 'Pr'],
  ],
  'Sets and logic': [
    ['\\in', 'element of', '∈'], ['\\notin', 'not an element of', '∉'], ['\\ni', 'contains as member', '∋'], ['\\subset', 'subset', '⊂'],
    ['\\supset', 'superset', '⊃'], ['\\subseteq', 'subset or equal', '⊆'], ['\\supseteq', 'superset or equal', '⊇'], ['\\emptyset', 'empty set', '∅'],
    ['\\varnothing', 'empty set, round (amssymb)', '⌀'], ['\\forall', 'for all', '∀'], ['\\exists', 'there exists', '∃'], ['\\nexists', 'there is no (amssymb)', '∄'],
    ['\\neg', 'not', '¬'], ['\\top', 'top, true', '⊤'], ['\\bot', 'bottom, false', '⊥'], ['\\mathbb{R}', 'real numbers (amssymb)', 'ℝ'],
    ['\\mathbb{N}', 'natural numbers (amssymb)', 'ℕ'], ['\\mathbb{Z}', 'integers (amssymb)', 'ℤ'], ['\\mathbb{Q}', 'rational numbers (amssymb)', 'ℚ'], ['\\mathbb{C}', 'complex numbers (amssymb)', 'ℂ'],
    ['\\aleph', 'aleph', 'ℵ'], ['\\therefore', 'therefore (amssymb)', '∴'], ['\\because', 'because (amssymb)', '∵'],
  ],
  Delimiters: [
    ['\\langle', 'left angle bracket', '⟨'], ['\\rangle', 'right angle bracket', '⟩'], ['\\lfloor', 'left floor', '⌊'], ['\\rfloor', 'right floor', '⌋'],
    ['\\lceil', 'left ceiling', '⌈'], ['\\rceil', 'right ceiling', '⌉'], ['\\{', 'left brace', '{'], ['\\}', 'right brace', '}'],
    ['\\|', 'double bar, norm', '‖'], ['\\left( \\right)', 'auto-sized parentheses', '( )'], ['\\left[ \\right]', 'auto-sized brackets', '[ ]'], ['\\left\\{ \\right\\}', 'auto-sized braces', '{ }'],
    ['\\lvert \\rvert', 'absolute value (amsmath)', '| |'], ['\\lVert \\rVert', 'norm (amsmath)', '‖ ‖'],
  ],
  Accents: [
    ['\\hat{}', 'hat', 'â'], ['\\bar{}', 'bar', 'ā'], ['\\vec{}', 'vector arrow', 'a⃗'], ['\\dot{}', 'dot', 'ȧ'],
    ['\\ddot{}', 'double dot', 'ä'], ['\\tilde{}', 'tilde', 'ã'], ['\\widehat{}', 'wide hat', 'â'], ['\\widetilde{}', 'wide tilde', 'ã'],
    ['\\overline{}', 'overline', 'a̅'], ['\\underline{}', 'underline', 'a̲'], ['\\mathbf{}', 'bold (math)', '𝐚'], ['\\mathrm{}', 'upright (math)', 'a'],
    ['\\mathcal{}', 'calligraphic', '𝒜'], ['\\boldsymbol{}', 'bold symbol (amsmath)', '𝛂'],
  ],
  Misc: [
    ['\\infty', 'infinity', '∞'], ['\\hbar', 'h bar, reduced Planck', 'ℏ'], ['\\ell', 'script l', 'ℓ'], ['\\Re', 'real part', 'ℜ'],
    ['\\Im', 'imaginary part', 'ℑ'], ['\\wp', 'Weierstrass p', '℘'], ['\\angle', 'angle', '∠'], ['\\triangle', 'triangle', '△'],
    ['\\square', 'square (amssymb)', '□'], ['\\Box', 'box (amssymb)', '□'], ['\\diamond', 'diamond', '⋄'], ['\\prime', 'prime', '′'],
    ['\\degree', 'degree (gensymb)', '°'], ['^{\\circ}', 'degree', '°'], ['\\ldots', 'dots on the line', '…'], ['\\cdots', 'centered dots', '⋯'],
    ['\\vdots', 'vertical dots', '⋮'], ['\\ddots', 'diagonal dots', '⋱'], ['\\checkmark', 'check mark (amssymb)', '✓'], ['\\S', 'section sign', '§'],
    ['\\P', 'paragraph sign', '¶'], ['\\copyright', 'copyright', '©'], ['\\dag', 'dagger (text)', '†'], ['\\clubsuit', 'club suit', '♣'],
    ['\\heartsuit', 'heart suit', '♡'], ['\\spadesuit', 'spade suit', '♠'], ['\\flat', 'flat', '♭'], ['\\sharp', 'sharp', '♯'],
    ['\\natural', 'natural', '♮'], ['\\quad', 'wide space', '␣'], ['\\,', 'thin space', '·'], ['\\!', 'negative thin space', '·'],
  ],
};

export const SYMBOLS: MathSymbol[] = (Object.entries(raw) as Array<[SymbolCategory, Array<[string, string, string]>]>).flatMap(([category, list]) =>
  list.map(([command, name, glyph]) => ({ command, name, glyph, category })),
);

export const SYMBOL_CATEGORIES = Object.keys(raw) as SymbolCategory[];

/** Symbols matching `q` by name or command ("less or equal", "leq", "\\leq"). */
export function searchSymbols(q: string, category?: SymbolCategory): MathSymbol[] {
  const s = q.trim().toLowerCase().replace(/^\\/, '');
  return SYMBOLS.filter((x) => (!category || x.category === category) && (!s || x.name.toLowerCase().includes(s) || x.command.toLowerCase().replace(/^\\/, '').startsWith(s)));
}
