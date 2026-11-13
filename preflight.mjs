import fs from 'node:fs';
import path from 'node:path';
import { arabicFinding, validateLanguage } from './i18n.mjs';

const ignored = new Set(['.git', 'node_modules', '.venv', 'vendor', 'coverage']);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const unixCommand = /^(?:\$\s*)?(?:(?:sudo|chmod|bash|sh)\s|export\s+[A-Za-z_]|\/bin\/(?:ba)?sh(?:\s|$))|^(?:\$\s*)?(?:python3?|node|npm|npx|uv|cd|rm|mkdir|cp|mv|cat|curl|wget|source)\s.*(?:\/tmp\/|\$HOME\b)/;
const runtimeCommands = [
  ['node', /^(?:\$\s*)?(?:node|npm|npx|pnpm|yarn)\s/i],
  ['python', /^(?:\$\s*)?(?:python(?:3(?:\.\d+)?)?|pip3?|uv)\s/i],
  ['bash', /^(?:\$\s*)?(?:bash|sh)\s/i],
  ['powershell', /^(?:\$\s*)?(?:pwsh|powershell)\s/i],
  ['git', /^(?:\$\s*)?git\s/i],
];

function skillFiles(root) {
  const found = [];
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (item.isSymbolicLink()) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory() && !ignored.has(item.name)) visit(file);
      else if (item.isFile() && item.name === 'SKILL.md') found.push(file);
    }
  }
  visit(root);
  return found;
}

// Deliberately recognizes a narrow subset, not arbitrary YAML or Markdown.
export function checkSkill(file, root) {
  const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const relative = path.relative(root, file).split(path.sep).join('/');
  const findings = [];
  const add = (rule, severity, line, message, details = {}) => findings.push({ file: relative, line, rule, severity, message, details });
  const front = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!front) add('META_FRONTMATTER', 'error', 1, 'Add YAML frontmatter with name and description.');
  else for (const key of ['name', 'description']) {
    const value = front[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim();
    const metaLines = front[1].split('\n');
    const fieldIndex = metaLines.findIndex(line => line.startsWith(`${key}:`));
    const continuation = [];
    for (let j = fieldIndex + 1; fieldIndex >= 0 && j < metaLines.length; j++) {
      if (metaLines[j].trim() && !/^[ \t]/.test(metaLines[j])) break;
      if (metaLines[j].trim() && !metaLines[j].trimStart().startsWith('#')) continuation.push(metaLines[j]);
    }
    const block = continuation.join('\n').trim();
    if (value === undefined || (/^(?:''|""|null|~)(?:\s*#.*)?$/i.test(value))) add('META_REQUIRED', 'error', 1, `Frontmatter needs a non-empty ${key}.`, { key });
    else if (!value || value.startsWith('#') || /^[|>][-+]?\s*(?:#.*)?$/.test(value)) {
      if (!block) add('META_REQUIRED', 'error', 1, `Frontmatter needs a non-empty ${key} block.`, { key, block: true });
    }
  }
  let fence = null, frontEnd = front ? front[0].split('\n').length - 1 : 0;
  let requirements = '', collecting = false, headingDepth = 0;
  const commands = [];
  let inComment = false;
  for (let i = frontEnd; i < lines.length; i++) {
    let line = lines[i];
    const marker = inComment ? null : line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], size: marker[1].length, language: marker[2].trim().toLowerCase() };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = null;
      continue;
    }
    if (fence) {
      if (['sh','shell','bash','console','powershell','pwsh','bat','cmd',''].includes(fence.language)) commands.push({ line: i+1, text: line.trim(), language: fence.language });
      continue;
    }
    // Ignore HTML comments in Markdown prose while preserving source line numbers.
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/`[^`]*`|<!--.*?(?:-->|$)/g, token => {
      if (token.startsWith('`')) return token;
      inComment = !token.endsWith('-->');
      return ' ';
    });
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      if (collecting && heading[1].length <= headingDepth) collecting = false;
      const title = heading[2].normalize('NFC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/\s+/g, ' ').trim();
      if (/^(?:requirements|prerequisites|dependencies|runtime requirements)(?=$|[\s:：])/i.test(title) || /^(?:المتطلبات|متطلبات التشغيل|المتطلبات الأساسية|المتطلبات الاساسية|الاعتماديات|التبعيات)(?=$|[\s:：])/.test(title)) { collecting = true; headingDepth = heading[1].length; }
    }
    if (collecting) requirements += `\n${line}`;
    // Inline local Markdown destinations; strip inline code first.
    const prose = line.replace(/`[^`]*`/g, '');
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\s*\)/g)) {
      let link = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(link)) continue;
      link = link.split(/[?#]/)[0];
      if (!link) continue;
      try { link = decodeURIComponent(link); } catch { add('LINK_ENCODING', 'warning', i+1, 'Local link has invalid percent encoding.'); continue; }
      // {baseDir} denotes this skill's directory; do not treat it as a literal folder.
      link = link.replace(/^\{baseDir\}[\\/]/, '');
      if (link === 'URL' || link === '<URL>') { add('LINK_PLACEHOLDER', 'warning', i+1, 'Example URL placeholder cannot be checked as a local file.'); continue; }
      if (/\{[^}]+\}|\$[A-Za-z_]|<[^>]+>/.test(link)) { add('LINK_DYNAMIC', 'warning', i+1, 'Dynamic local destination cannot be resolved statically.', { link }); continue; }
      const target = path.resolve(path.dirname(file), link);
      if (!inside(root, target)) { add('LINK_OUTSIDE_ROOT', 'warning', i+1, `Local link points outside the scan root: ${link}`, { link }); continue; }
      try {
        const resolved = fs.realpathSync(target);
        if (!inside(fs.realpathSync(root), resolved)) add('LINK_OUTSIDE_ROOT', 'warning', i+1, `Local link resolves outside the scan root: ${link}`, { link, resolved: true });
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') add('LINK_MISSING', 'error', i+1, `Local link does not exist: ${link}`, { link });
        else throw error;
      }
    }
  }
  const seen = new Set();
  for (const command of commands) {
    if (!command.text || command.text.startsWith('#')) continue;
    for (const [runtime, pattern] of runtimeCommands) {
      if (pattern.test(command.text) && !seen.has(runtime)) {
        seen.add(runtime);
        const declaration = runtime === 'node' ? /\b(?:node(?:\.js)?|npm|npx|pnpm|yarn)\b/i : new RegExp(`\\b${runtime}\\b`, 'i');
        if (!declaration.test(requirements)) add('RUNTIME_UNDECLARED', 'warning', command.line, `Command uses ${runtime}; prerequisites were not recognized in a Requirements section and may be documented elsewhere.`, { runtime });
      }
    }
    if (unixCommand.test(command.text)) add('PORTABILITY_SHELL', 'warning', command.line, 'POSIX shell assumption: document the supported OS or provide a Windows alternative.');
  }
  return findings;
}

export function scan(input) {
  const absolute = path.resolve(input);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error('Scan root must not be a symbolic link.');
  const root = stat.isDirectory() ? absolute : path.dirname(absolute);
  if (!stat.isDirectory() && path.basename(absolute) !== 'SKILL.md') throw new Error('Pass a directory or a SKILL.md file.');
  const files = stat.isDirectory() ? skillFiles(root) : [absolute];
  const findings = files.flatMap(file => checkSkill(file, root));
  if (!files.length) findings.push({ file: '.', line: 1, rule: 'NO_SKILLS', severity: 'error', message: 'No SKILL.md files found in this scan root.' });
  return { version: '0.3.1', skills: files.length, errors: findings.filter(f=>f.severity==='error').length, warnings: findings.filter(f=>f.severity==='warning').length, findings };
}

export function formatReport(report, format = 'text', language = 'en') {
  validateLanguage(language);
  const ar = language === 'ar';
  const findings = report.findings.map(f => ({ ...f, message: ar ? arabicFinding(f) : f.message }));
  if (format === 'json') return JSON.stringify({ ...report, language, findings }, null, 2) + '\n';
  const level = severity => ar ? (severity === 'error' ? 'خطأ' : 'تحذير') : severity;
  const title = ar ? `فحص المهارات: ${report.skills} مهارة، ${report.errors} خطأ، ${report.warnings} تحذير` : `Skill Preflight: ${report.skills} skill(s), ${report.errors} error(s), ${report.warnings} warning(s)`;
  if (format === 'markdown') {
    const escape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','\\|').replaceAll('`','\\`').replace(/[\r\n]/g,' ');
    const columns = ar ? '| الملف:السطر | المستوى | القاعدة | الملاحظة |' : '| File:line | Level | Rule | Finding |';
    return `## ${title}\n\n` + (findings.length ? columns + '\n|---|---|---|---|\n' + findings.map(f=>`| ${escape(f.file)}:${f.line} | ${level(f.severity)} | ${f.rule} | ${escape(f.message)} |`).join('\n') : (ar ? 'لم تُرصد ملاحظات ضمن الفحوص الثابتة المدعومة.' : 'No findings in the supported static checks.')) + '\n';
  }
  return title + '\n' + findings.map(f=>`${f.file}:${f.line} ${level(f.severity)} ${f.rule} ${f.message}`).join('\n') + '\n';
}
