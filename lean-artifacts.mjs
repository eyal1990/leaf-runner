import { cleanExplanation } from './runner-state.mjs';

// Strip comments (including nested Lean block comments) and strings for basic source gates.
// Lean compilation and the server verdict remain authoritative.
function leanLexemes(source) {
  let text = '', depth = 0;
  for (let i = 0; i < source.length; ) {
    if (depth) {
      if (source.startsWith('/-', i)) { depth++; text += '  '; i += 2; }
      else if (source.startsWith('-/', i)) { depth--; text += '  '; i += 2; }
      else { text += ' '; i++; }
    } else if (source.startsWith('/-', i)) { depth++; text += '  '; i += 2; }
    else if (source.startsWith('--', i)) {
      while (i < source.length && source[i] !== '\n') { text += ' '; i++; }
    } else if (source[i] === '"') {
      text += ' '; i++;
      while (i < source.length) {
        if (source[i] === '\\') { text += ' '.repeat(Math.min(2, source.length - i)); i += 2; }
        else { text += ' '; if (source[i++] === '"') break; }
      }
    } else text += source[i++];
  }
  return [...text.matchAll(/[A-Za-z_][A-Za-z0-9_'.]*|[^\s]/g)].map(m => ({ token: m[0], index: m.index }));
}
export const leanTokens = source => leanLexemes(source).map(m => m.token);

export function artifactNameSuffix(target, attempt) {
  return `__p2m_${String(target.theorem_id ?? target.id ?? target.theorem_name).replace(/[^A-Za-z0-9_]/g, '_')}_a${attempt}`;
}

// Rename declarations and module imports before creating the immutable artifact.
// Comments and string literals retain their original bytes.
export function scopeArtifactNames(candidate, source, target, attempt) {
  const suffix = artifactNameSuffix(target, attempt), replacements = new Map();
  for (const row of [...candidate.children, ...candidate.definitions]) {
    const name = row.theorem_name ?? row.definition_name;
    const scoped = name.endsWith(suffix) ? name : name + suffix;
    replacements.set(name, scoped);
    const status = row.definition ? 'Definition' : 'Open';
    replacements.set(moduleFor({ ...row, status }), moduleFor({ ...row, status,
      theorem_name: row.theorem_name ? scoped : undefined, definition_name: row.definition_name ? scoped : undefined }));
  }
  const keys = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const rename = code => {
    let result = code;
    for (const { token, index } of leanLexemes(code).reverse()) {
      const key = keys.find(name => token === name || token.startsWith(name + '.'));
      if (key) result = result.slice(0, index) + replacements.get(key) + token.slice(key.length) + result.slice(index + token.length);
    }
    return result;
  };
  return { source: rename(source), candidate: { ...candidate,
    children: candidate.children.map(row => ({ ...row, theorem_name: replacements.get(row.theorem_name),
      formal_statement: rename(row.formal_statement), preamble: rename(row.preamble) })),
    definitions: candidate.definitions.map(row => ({ ...row, definition_name: replacements.get(row.definition_name), definition: rename(row.definition) })),
  } };
}

// Rename only the exact original target's single declaration. Do not infer a
// replacement from its type, an unrelated lemma, or a namespace wrapper.
export function normalizeSolutionDeclaration(source, target) {
  const tokens = leanLexemes(source);
  if (tokens.some(t => ['namespace', 'private', 'protected', 'mutual'].includes(t.token)) ||
      tokens.some(t => t.token === 'solution')) return source;
  const names = tokens.filter((t, i) => t.token === target.theorem_name && tokens[i - 1]?.token === 'theorem');
  if (names.length !== 1 || tokens.filter(t => t.token === target.theorem_name).length !== 1) return source;
  const name = names[0];
  return source.slice(0, name.index) + 'solution' + source.slice(name.index + name.token.length);
}
export function imports(source) {
  const tokens = leanTokens(source), result = new Set();
  for (let i = 0; i < tokens.length; i++) if (tokens[i] === 'import') {
    for (let j = i + 1; j < tokens.length && /^(?:Mathlib|Init|Lean|Std|Definitions|Theorems|Solutions)(?:\.[A-Za-z0-9_']+)*$/.test(tokens[j]); j++) result.add(tokens[j]);
  }
  return [...result];
}
export function moduleFor(row) {
  const name = row.theorem_name ?? row.definition_name;
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)) throw new Error('Unsupported platform declaration name');
  return (row.status === 'Definition' ? 'Definitions.Def_' : 'Theorems.Thm_') + name.replaceAll('.', '_');
}
export function gate(source, target) {
  if (source.includes('\0')) throw new Error('Solution contains a NUL character');
  const tokens = leanTokens(source);
  if (tokens.some(t => ['sorry', 'admit', 'axiom', 'constant', 'unsafe'].includes(t))) throw new Error('Solution contains a proof hole or an untrusted declaration');
  if (!tokens.some((t, i) => t === 'theorem' && tokens[i + 1] === 'solution')) throw new Error('Missing theorem solution');
  if (imports(source).includes(moduleFor(target))) throw new Error('Solution imports its own target');
  if (imports(source).some(m => m.startsWith('Solutions.'))) throw new Error('Solution must be self-contained');
}

export const leanEqual = (a, b) => JSON.stringify(leanTokens(a ?? '')) === JSON.stringify(leanTokens(b ?? ''));
export const CHILD_FIELDS = ['theorem_name', 'theorem_title', 'formal_statement', 'natural_language_statement', 'preamble'];
export const DEFINITION_FIELDS = ['definition_name', 'definition_title', 'definition', 'natural_language_statement'];

const artifactSchema = fields => ({
  type: 'object', properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
  required: fields, additionalProperties: false,
});
export const ANSWER_SCHEMA = {
  type: 'object', properties: {
    ready: { type: 'boolean', description: 'A complete proof/reduction candidate ready for runner validation; not a compilation verdict. Counterexamples and incomplete candidates use false.' },
    kind: { type: 'string', enum: ['proof', 'sketch', 'counterexample'] }, explanation: { type: 'string' },
    children: { type: 'array', maxItems: 8, items: artifactSchema(CHILD_FIELDS) },
    definitions: { type: 'array', maxItems: 8, items: artifactSchema(DEFINITION_FIELDS) },
  },
  required: ['ready', 'kind', 'explanation', 'children', 'definitions'], additionalProperties: false,
};

export class AnswerFormatError extends Error {}

const unfence = text => typeof text === 'string'
  ? text.replace(/^\s*```(?:lean|lean4)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/, '$1') : text;

function normalizeChildStatement(child) {
  const text = unfence(child.formal_statement);
  if (typeof text !== 'string') return text;
  const wrapped = text.match(/^\s*namespace\s+([A-Za-z_][A-Za-z0-9_'.]*)\s+theorem\s+([A-Za-z_][A-Za-z0-9_'.]*)([\s\S]*?)\s+end\s+\1\s*$/);
  if (!wrapped || `${wrapped[1]}.${wrapped[2]}` !== child.theorem_name) return text;
  const tokens = leanTokens(wrapped[3]);
  // Only unwrap a single placeholder declaration; never discard extra commands or a proof.
  if (tokens.slice(-4).join(' ') !== ': = by sorry' || tokens.filter(t => t === 'sorry').length !== 1 ||
      tokens.some(t => ['namespace', 'end', 'theorem', 'lemma', 'def', 'structure', 'inductive', 'import'].includes(t))) return text;
  return `theorem ${child.theorem_name}${wrapped[3]}`;
}

export function normalizeAnswer(result) {
  return { ...result, explanation: cleanExplanation(result.explanation), ...(Array.isArray(result.children) && { children: result.children.map(child => child && ({
    ...child, formal_statement: normalizeChildStatement(child), preamble: unfence(child.preamble),
  })) }), ...(Array.isArray(result.definitions) && { definitions: result.definitions.map(definition => definition && ({
    ...definition, definition: unfence(definition.definition),
  })) }) };
}

export function decomposition(result, target, source) {
  const kind = result.kind ?? 'proof', children = result.children ?? [], definitions = result.definitions ?? [];
  if (!['proof', 'sketch'].includes(kind) || !Array.isArray(children) || !Array.isArray(definitions) ||
      children.length > 8 || definitions.length > 8) {
    throw new AnswerFormatError('Invalid proof/decomposition artifacts');
  }
  if (kind === 'proof' && (children.length || definitions.length)) throw new Error('A direct proof cannot propose decomposition artifacts');
  const modules = new Map();
  const safeArtifact = (code, allowSorry = false) => {
    const tokens = leanTokens(code);
    if (tokens.some(t => ['admit', 'axiom', 'constant', 'unsafe'].includes(t)) || !allowSorry && tokens.includes('sorry')) {
      throw new Error('Decomposition artifact contains a proof hole or untrusted declaration');
    }
    if (imports(code).some(m => m === moduleFor(target) || m.startsWith('Solutions.'))) {
      throw new Error('Decomposition artifact imports the target or a solution');
    }
  };
  for (const [rows, fields, status] of [[definitions, DEFINITION_FIELDS, 'Definition'], [children, CHILD_FIELDS, 'Open']]) {
    for (const artifact of rows) {
      if (!artifact || fields.some(f => typeof artifact[f] !== 'string' || f !== 'preamble' && !artifact[f].trim()) ||
          Object.keys(artifact).some(f => !fields.includes(f)) ||
          (artifact.theorem_title ?? artifact.definition_title).length > 200 || JSON.stringify(artifact).length > 200000) {
        throw new AnswerFormatError('Missing or oversized decomposition artifact fields');
      }
      if (status === 'Definition' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(artifact.definition_name)) throw new Error('Unsupported definition name');
      const row = { ...artifact, status, mathlib_rev: target.mathlib_rev }, module = moduleFor(row);
      if (modules.has(module) || module === moduleFor(target)) throw new Error('Duplicate child or target declaration');
      if (status === 'Open') {
        const tokens = leanTokens(row.formal_statement);
        if (tokens[0] !== 'theorem' || tokens[1] !== row.theorem_name ||
            tokens.slice(-4).join(' ') !== ': = by sorry' || tokens.filter(t => t === 'sorry').length !== 1 ||
            tokens.slice(2, -4).some(t => ['theorem', 'lemma', 'def', 'structure', 'inductive', 'namespace', 'end', 'import'].includes(t))) {
          throw new AnswerFormatError('Child must be one exact theorem declaration ending with := by sorry; use its full theorem_name and no namespace/end wrapper');
        }
        if (leanTokens(row.preamble).some(t => ['theorem', 'lemma', 'def', 'structure', 'inductive', 'instance', 'sorry'].includes(t))) {
          throw new Error('Child preamble must use imports/opens/variables; put custom definitions in definitions');
        }
        safeArtifact(row.preamble); safeArtifact(row.formal_statement, true);
        if (leanEqual(row.formal_statement.replace(row.theorem_name, target.theorem_name), target.formal_statement)) {
          throw new Error('A child merely restates the target; provide a meaningful decomposition');
        }
      } else safeArtifact(row.definition);
      modules.set(module, row);
    }
  }
  // Children are independent problems; supporting definitions may form an acyclic graph.
  for (const row of modules.values()) {
    for (const module of imports(row.definition ?? row.preamble)) {
      if (modules.get(module)?.status === 'Open') throw new Error('Proposed artifacts must not import proposed Open children');
    }
  }
  const reachable = new Set(), visiting = new Set(), ordered = [];
  function visit(module) {
    if (!modules.has(module) || reachable.has(module)) return;
    if (visiting.has(module)) throw new Error('Circular decomposition artifacts');
    visiting.add(module);
    const row = modules.get(module);
    for (const dependency of imports(row.definition ?? row.preamble)) visit(dependency);
    visiting.delete(module); reachable.add(module); ordered.push(row);
  }
  for (const module of imports(source)) visit(module);
  if (reachable.size !== modules.size) throw new Error('Decomposition includes unused child/definition artifacts');
  return { kind, children, definitions, modules, ordered };
}

export const answerPayload = result => Object.fromEntries(Object.keys(ANSWER_SCHEMA.properties).filter(key => key in result).map(key => [key, result[key]]));

export function assertFormatOnlyRepair(original, repaired) {
  const before = normalizeAnswer(original), after = normalizeAnswer(repaired);
  if (before.ready !== after.ready || (before.kind ?? 'proof') !== (after.kind ?? 'proof')) throw new Error('Repair changed answer readiness or kind');
  for (const [field, name, code] of [['children', 'theorem_name', 'formal_statement'], ['definitions', 'definition_name', 'definition']]) {
    const oldRows = before[field] ?? [], newRows = after[field] ?? [];
    if (!Array.isArray(oldRows) || !Array.isArray(newRows) || oldRows.length !== newRows.length) throw new Error('Repair changed artifact count');
    for (let i = 0; i < oldRows.length; i++) {
      if (!oldRows[i] || !newRows[i] || oldRows[i][name] !== newRows[i][name] || typeof oldRows[i][code] !== 'string' ||
          oldRows[i][code].trim() !== newRows[i][code]?.trim() ||
          field === 'children' && (oldRows[i].preamble ?? '').trim() !== (newRows[i].preamble ?? '').trim()) {
        throw new Error('Repair changed Lean code or artifact identity');
      }
    }
  }
}

export function validateAnswer(result, target, source) {
  if (typeof result.ready !== 'boolean' || typeof result.explanation !== 'string' || !result.explanation.trim() || result.explanation.length > 50000) {
    throw new AnswerFormatError('Missing or oversized proof explanation or invalid ready field');
  }
  if (result.kind === 'counterexample') {
    if (result.ready !== false || !Array.isArray(result.children) || result.children.length ||
        !Array.isArray(result.definitions) || result.definitions.length) {
      throw new AnswerFormatError('A counterexample requires ready=false and empty children/definitions');
    }
    return { kind: 'counterexample' };
  }
  return decomposition(result, target, source);
}

export function typeCheckSource(target, solutionModule, children = [], { counterexample = false } = {}) {
  moduleFor(target); // Validate the declaration name before embedding a Lean identifier.
  return `import Lean\nimport ${solutionModule}\n${target.preamble ?? ''}\n${target.formal_statement}\n\n` +
    `open Lean Meta Elab Command in\nrun_cmd liftTermElabM do\n` +
    `  let expected ← getConstInfo \`${target.theorem_name}\n` +
    `  let actual ← getConstInfo \`solution\n` +
    `  unless expected.levelParams.length == actual.levelParams.length do\n    throwError "solution universe parameters differ from target"\n` +
    `  let levels ← expected.levelParams.mapM (fun _ => mkFreshLevelMVar)\n` +
    `  let targetType := expected.type.instantiateLevelParams expected.levelParams levels\n` +
    (counterexample ? `  let expectedType ← mkAppM \`\`Not #[targetType]\n` : `  let expectedType := targetType\n`) +
    `  let actualType := actual.type.instantiateLevelParams actual.levelParams levels\n` +
    `  unless ← isDefEq expectedType actualType do\n    throwError "solution type does not match ${counterexample ? 'negation of target' : 'target'}"\n` +
    (counterexample ? `  for ax in ← collectAxioms \`solution do\n` +
      `    unless #[\`propext, \`Classical.choice, \`Quot.sound].contains ax do\n` +
      `      throwError "counterexample depends on untrusted axiom: {ax}"\n` : '') +
    children.map(child => {
      moduleFor(child);
      return `  let child ← getConstInfo \`${child.theorem_name}\n` +
        `  if child.levelParams.length == expected.levelParams.length then\n` +
        `    let childLevels ← expected.levelParams.mapM (fun _ => mkFreshLevelMVar)\n` +
        `    if ← isDefEq (expected.type.instantiateLevelParams expected.levelParams childLevels) (child.type.instantiateLevelParams child.levelParams childLevels) then\n` +
        `      throwError "child merely restates target: ${child.theorem_name}"\n`;
    }).join('');
}
