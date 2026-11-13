import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scan, formatReport } from './preflight.mjs';
import { arabicFinding } from './i18n.mjs';

const header = '---\nname: test-skill\ndescription: A test skill.\n---\n';
function fixture(t, text, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-preflight-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'SKILL.md'),text);
  for(const [name,content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); fs.writeFileSync(path.join(root,name),content); }
  return root;
}
test('ready bundle passes and includes no absolute paths',t=>{
  const root=fixture(t,header+'## Requirements\nNode.js 20\n[guide](guide.md)\n```sh\nnode --version\n```',{ 'guide.md':'ok' });
  const report=scan(root); assert.equal(report.errors,0); assert.equal(report.warnings,0); assert.ok(!JSON.stringify(report).includes(root));
});
test('missing local files fail with line numbers',t=>{
  const r=scan(fixture(t,header+'[guide](gone.md)\n')); assert.equal(r.errors,1); assert.equal(r.findings[0].rule,'LINK_MISSING'); assert.equal(r.findings[0].line,5);
});
test('external links, inline code and fenced code are not opened',t=>{
  const r=scan(fixture(t,header+'[web](https://invalid.example/a)\n`[ignore](gone.md)`\n```md\n[ignore](also-gone.md)\n```')); assert.equal(r.errors,0);
});
test('URL-encoded local link and anchor resolve',t=>{
  const r=scan(fixture(t,header+'[guide](my%20guide.md#section)',{'my guide.md':'ok'})); assert.equal(r.errors,0);
});
test('parent reference within repository is valid',t=>{
  const root=fixture(t,header,{'child/SKILL.md':header+'[parent](../guide.md)','guide.md':'ok'}); assert.equal(scan(root).errors,0);
});
test('outside-root link is a warning, never followed',t=>{
  const r=scan(fixture(t,header+'[outside](../../elsewhere.md)')); assert.equal(r.errors,0); assert.equal(r.findings[0].rule,'LINK_OUTSIDE_ROOT');
});
test('frontmatter missing and empty fields fail',t=>{
  assert.equal(scan(fixture(t,'# No metadata')).findings[0].rule,'META_FRONTMATTER');
  const r=scan(fixture(t,'---\nname: ""\ndescription: null\n---\n')); assert.equal(r.errors,2);
  assert.equal(scan(fixture(t,'---\nname:\ndescription: Nonempty\n---\n')).errors,1);
});
test('multiline YAML description recognized',t=>{
  const r=scan(fixture(t,'---\nname: demo\ndescription: |\n  First line\n  Second line\n---\n')); assert.equal(r.errors,0);
});
test('empty multiline metadata fails',t=>{
  const r=scan(fixture(t,'---\nname: demo\ndescription: |\n---\n')); assert.equal(r.errors,1);
});
test('BOM and CRLF work',t=>{
  assert.equal(scan(fixture(t,'\uFEFF'+header.replaceAll('\n','\r\n'))).errors,0);
});
test('runtime warnings are deduplicated and ignore comments',t=>{
  const r=scan(fixture(t,header+'```sh\n# npm install\npython3 x.py\npython3 y.py\nnpx thing\n```')); assert.equal(r.warnings,2);
});
test('requirements end at next sibling heading',t=>{
  const r=scan(fixture(t,header+'## Requirements\nNone\n## Notes\nPython\n```sh\npython3 x.py\n```')); assert.equal(r.findings[0].rule,'RUNTIME_UNDECLARED');
});
test('POSIX assumptions are warnings',t=>{
  const r=scan(fixture(t,header+'```bash\nexport OUT=/tmp/out\nchmod +x script\n```')); assert.equal(r.warnings,2);
});
test('ignored directories are not scanned',t=>{
  const root=fixture(t,header,{'node_modules/pkg/SKILL.md':'broken','.git/SKILL.md':'broken'}); assert.equal(scan(root).skills,1);
});
test('no skills fails rather than reporting success',t=>{
  const root=fixture(t,header); fs.unlinkSync(path.join(root,'SKILL.md')); assert.equal(scan(root).findings[0].rule,'NO_SKILLS');
});
test('Markdown escapes report-controlled table and HTML characters',()=>{
  const text=formatReport({skills:1,errors:1,warnings:0,findings:[{file:'a|b',line:1,rule:'LINK_MISSING',severity:'error',message:'<script>|x'}]},'markdown'); assert.ok(text.includes('a\\|b')); assert.ok(text.includes('&lt;script&gt;\\|x'));
});
test('CLI exit codes and strict mode',t=>{
  const root=fixture(t,header+'```sh\npython3 a.py\n```');
  const cli=path.resolve('cli.mjs');
  assert.equal(spawnSync(process.execPath,[cli,root]).status,0);
  assert.equal(spawnSync(process.execPath,[cli,root,'--strict']).status,1);
  assert.equal(spawnSync(process.execPath,[cli,root,'--format','xml']).status,2);
  assert.equal(spawnSync(process.execPath,[cli,root,'--bogus']).status,2);
});

test('Arabic requirement headings, diacritics and punctuation are recognized', t => {
  for (const title of ['المتطلبات', 'متطلبات التشغيل', 'المتطلبات الأساسية:', 'المتطلبات الاساسية', 'الاعتماديات', 'التبعيات', 'المُتطلَّبات', 'المتطلبات — Requirements']) {
    const root = fixture(t, header + `## ${title}\nNode.js 20\n\n` + '```sh\nnode --version\n```');
    assert.equal(scan(root).warnings, 0, title);
  }
});

test('Arabic requirements stop at sibling headings and do not match similar words', t => {
  const r = scan(fixture(t, header + '## المتطلبات\nلا توجد\n## ملاحظات\nPython\n```sh\npython3 example.py\n```'));
  assert.equal(r.findings[0].rule, 'RUNTIME_UNDECLARED');
  const similar = scan(fixture(t, header + '## المتطلباتية\nPython\n```sh\npython3 example.py\n```'));
  assert.equal(similar.findings[0].rule, 'RUNTIME_UNDECLARED');
});

test('Arabic content, filenames and encoded links work', t => {
  const root = fixture(t, '---\nname: arabic-demo\ndescription: مهارة لكتابة التقارير\n---\n[دليل](دليل.md)\n[دليل مرمز](%D8%AF%D9%84%D9%8A%D9%84.md)\n', { 'دليل.md': 'تعليمات عربية' });
  assert.equal(scan(root).errors, 0);
});

test('Arabic reports translate text, Markdown and JSON without changing codes', t => {
  const report = scan(fixture(t, header + '[دليل](مفقود.md)\n```sh\npython3 a.py\n```'));
  assert.match(formatReport(report, 'text', 'ar'), /فحص المهارات/);
  assert.match(formatReport(report, 'markdown', 'ar'), /الملف:السطر/);
  const ar = JSON.parse(formatReport(report, 'json', 'ar'));
  const en = JSON.parse(formatReport(report, 'json', 'en'));
  assert.equal(ar.language, 'ar');
  assert.deepEqual(ar.findings.map(f=>[f.rule,f.severity,f.line]), en.findings.map(f=>[f.rule,f.severity,f.line]));
  assert.match(ar.findings[0].message, /غير موجود: مفقود.md/);
  assert.match(ar.findings[1].message, /python/);
  assert.match(formatReport(report), /Skill Preflight/);
  assert.throws(()=>formatReport(report, 'text', 'fr'), /Language/);
});

test('Every supported rule has an Arabic message and output is escaped', () => {
  for (const rule of ['META_FRONTMATTER','META_REQUIRED','LINK_MISSING','LINK_OUTSIDE_ROOT','LINK_ENCODING','RUNTIME_UNDECLARED','PORTABILITY_SHELL','NO_SKILLS']) {
    assert.match(arabicFinding({rule, message:'ENGLISH', details:{key:'name',link:'x',runtime:'node'}}), /[\u0600-\u06ff]/);
  }
  const text = formatReport({skills:1,errors:1,warnings:0,findings:[{rule:'LINK_MISSING',severity:'error',file:'a|b',line:1,details:{link:'<script>|x'}}]}, 'markdown', 'ar');
  assert.ok(text.includes('&lt;script&gt;\\|x'));
});

test('Arabic CLI help, errors, output files and exit codes', t => {
  const root = fixture(t, header + '[دليل](مفقود.md)');
  const cli = path.resolve('cli.mjs');
  const run = args => spawnSync(process.execPath, [cli, ...args], {encoding:'utf8'});
  const help = run(['--help','--lang','ar']);
  assert.equal(help.status,0); assert.match(help.stdout,/الاستخدام/);
  const bad = run([root,'--lang','ar','--bogus']);
  assert.equal(bad.status,2); assert.match(bad.stderr,/خيار غير معروف/);
  assert.match(run([root,'--lang','ar','--format']).stderr,/إلى قيمة/);
  assert.equal(run([root,'--lang','fr']).status,2);
  const output = path.join(root,'تقرير.json');
  const result = run([root,'--lang','ar','--format','json','--output',output]);
  assert.equal(result.status,1);
  assert.equal(JSON.parse(fs.readFileSync(output,'utf8')).language,'ar');
});

test('Indented YAML plain scalars are accepted without swallowing sibling fields', t => {
  assert.equal(scan(fixture(t,'---\nname: demo\ndescription:\n  First line of the description\n  continuation text\nlicense: MIT\n---\n')).errors,0);
  assert.equal(scan(fixture(t,'---\nname:\ndescription:\n  Nonempty description\n---\n')).errors,1);
  assert.equal(scan(fixture(t,'---\nname: demo\ndescription: # comment only\n  # still empty\n---\n')).errors,1);
  assert.equal(scan(fixture(t,'---\nname: demo\ndescription: NULL\n---\n')).errors,1);
});

test('baseDir links resolve from skill directory and still enforce boundaries', t => {
  const root = fixture(t,header+'[guide]({baseDir}/references/guide.md)\n[missing]({baseDir}/missing.md)\n[escape]({baseDir}/../../outside.md)',{'references/guide.md':'ok'});
  const r = scan(root);
  assert.equal(r.errors,1); assert.equal(r.warnings,1);
  assert.equal(r.findings[0].rule,'LINK_MISSING');
  assert.equal(r.findings[1].rule,'LINK_OUTSIDE_ROOT');
});

test('Dynamic destinations and URL examples are review warnings, not missing files', t => {
  const r = scan(fixture(t,header+'[example](URL)\n[guide](${ROOT}/guide.md)\n[other]({unknown}/guide.md)'));
  assert.equal(r.errors,0); assert.equal(r.warnings,3);
  assert.equal(r.findings[0].rule,'LINK_PLACEHOLDER');
  assert.equal(r.findings[1].rule,'LINK_DYNAMIC');
  assert.match(formatReport(r,'text','ar'),/الفحص الثابت/);
});

test('Prompt prose and expected-output logs do not become shell portability findings', t => {
  const r = scan(fixture(t,header+'~~~\n- Always use the search tool, not bash grep.\n~~~\n\n```\nINFO: runner /tmp/work\n```'));
  assert.equal(r.warnings,0);
  assert.equal(scan(fixture(t,header+'```sh\npython3 /tmp/work.py\nexport OUT=/tmp/out\n```')).findings.filter(f=>f.rule==='PORTABILITY_SHELL').length,2);
});

test('HTML comments hide links without hiding visible links or code fences', t => {
  const root = fixture(t, header + [
    '<!-- [hidden](hidden-inline.md) --> [visible](missing-first.md)',
    '<!--',
    '```md',
    '[hidden](hidden-block.md)',
    '--> [visible](missing-second.md)',
    '`<!--` [visible](missing-third.md)',
    '```md',
    '<!--',
    '```',
    '[visible](missing-fourth.md)',
    '<!-- [hidden](hidden-unclosed.md)',
  ].join('\n'));
  const report = scan(root);
  assert.deepEqual(report.findings.map(({ rule, line, details }) => [rule, line, details.link]), [
    ['LINK_MISSING', 5, 'missing-first.md'],
    ['LINK_MISSING', 9, 'missing-second.md'],
    ['LINK_MISSING', 10, 'missing-third.md'],
    ['LINK_MISSING', 14, 'missing-fourth.md'],
  ]);
});
